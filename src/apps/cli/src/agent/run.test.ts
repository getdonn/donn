import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentProbe,
  agentProject,
  createAgent,
  SECRETS,
  START_LINES,
} from "../test/created-agent.js";
import { fakeEve, type FakeEve, type FakeEveReply } from "../test/fake-eve.js";
import { quietIo, seed, zz, type Seeded } from "../test/seed.js";
import { createServer } from "node:net";
import { agentLogPath, keptNote, startAgent } from "./run.js";
import { storedPort } from "./registry.js";

// `donn agent run|stop|logs` without a daemon, and startAgent itself: eve build, then eve start
// in its own process group, the URL from its `[START]` line. See
// docs/planning/25-agent-runner.md, section 4 `local`.

const START_ARGS = [
  "exec",
  "eve",
  "start",
  "--host",
  "127.0.0.1",
  "--port",
  "0",
];

/** `eve build` exits 0; `eve start` prints START_LINES and runs until killed. */
const serving = (extra: FakeEveReply[] = []) =>
  fakeEve({
    replies: [
      ...extra,
      { eve: ["build"], lines: ["built"] },
      { eve: ["start"], lines: START_LINES(), hold: true },
    ],
  });

const startCall = (spawn: FakeEve) =>
  spawn.calls.find((c) => c.args.includes("start"));

describe("startAgent", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "donn-run-"));
    writeFileSync(join(dir, "package.json"), '{ "name": "kody" }\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const io = (
    spawn: FakeEve,
    probe = agentProbe(),
    env: NodeJS.ProcessEnv = {},
  ) => ({
    ...quietIo({ cwd: dir, home: join(dir, "home"), env }),
    probe,
    spawn,
  });
  const options = { name: "kody", project: "/p", buildEnv: {} };

  it("builds, then starts eve detached on 127.0.0.1 and reads the URL", async () => {
    const spawn = serving();
    const agent = await startAgent(
      io(spawn, agentProbe(), {
        NODE_ENV: "test",
        VITEST: "true",
        EVE_DEV: "1",
        EVE_MOCK_AUTHORED_MODELS: "1",
        PATH: "/usr/bin",
      }),
      dir,
      { API_TOKEN: "tok-SECRET", GREETING: "hello" },
      { ...options, buildEnv: { GREETING: "hello" } },
    );
    expect(spawn.calls.map((c) => c.args)).toEqual([
      ["exec", "eve", "build"],
      START_ARGS,
    ]);
    // The build gets the plain values (an agent may read them at load), never a secret.
    const build = spawn.calls[0]!;
    expect(build.env.API_TOKEN).toBeUndefined();
    expect(build.env.DONN_ROUTE_TOKEN).toBeUndefined();
    expect(build.env.GREETING).toBe("hello");
    expect(build.env.NODE_ENV).toBe("production");
    const start = startCall(spawn)!;
    expect(start.command).toBe("pnpm");
    expect(start.cwd).toBe(dir);
    expect(start.detached).toBe(true);
    expect(start.env.NODE_ENV).toBe("production");
    expect(start.env.API_TOKEN).toBe("tok-SECRET");
    expect(start.env.GREETING).toBe("hello");
    expect(start.env.PATH).toBe("/usr/bin");
    for (const name of ["VITEST", "EVE_DEV", "EVE_MOCK_AUTHORED_MODELS"])
      expect(start.env[name]).toBeUndefined();
    expect(agent.url).toBe("http://127.0.0.1:61131/");
    expect(agent.token).toMatch(/^[0-9a-f]{64}$/);
    expect(start.env.DONN_ROUTE_TOKEN).toBe(agent.token);
    expect(agent).toMatchObject({ name: "kody", project: "/p" });
    expect(agent.pid).toBeGreaterThan(0);
    await agent.stop();
  });

  it("builds without donn's run-time names from an agent exec shell", async () => {
    const spawn = serving();
    const agent = await startAgent(
      io(spawn, agentProbe(), {
        PATH: "/usr/bin",
        DONN_SECRET_1: "sk-gw-SECRET",
        DONN_ROUTE_TOKEN: "old-token",
      }),
      dir,
      {},
      options,
    );
    const build = spawn.calls[0]!;
    expect(build.env.PATH).toBe("/usr/bin");
    expect(build.env.DONN_SECRET_1).toBeUndefined();
    expect(build.env.DONN_ROUTE_TOKEN).toBeUndefined();
    await agent.stop();
  });

  it("generates a new token each run", async () => {
    const a = await startAgent(io(serving()), dir, {}, options);
    const b = await startAgent(io(serving()), dir, {}, options);
    expect(a.token).not.toBe(b.token);
    await Promise.all([a.stop(), b.stop()]);
  });

  it("stop signals the group, then counts eve-sbx- containers running and exited", async () => {
    const spawn = serving();
    const probe = agentProbe(["running", "exited", "exited"]);
    const agent = await startAgent(io(spawn, probe), dir, {}, options);
    expect(await agent.stop()).toEqual({ leftovers: 1, exited: 2 });
    expect(startCall(spawn)!.kills).toEqual(["SIGTERM"]);
    expect(probe.dockerCalls).toEqual([
      ["ps", "-a", "--filter", "name=eve-sbx-", "--format", "{{.State}}"],
    ]);
    expect(await agent.exited).toBe(143);
    // Twice is once.
    expect(await agent.stop()).toEqual({ leftovers: 1, exited: 2 });
    expect(startCall(spawn)!.kills).toEqual(["SIGTERM"]);
  });

  it("stop kills the group when SIGTERM is not enough", async () => {
    const spawn = fakeEve({
      replies: [
        { eve: ["build"] },
        {
          eve: ["start"],
          lines: START_LINES(),
          hold: true,
          ignore: ["SIGTERM"],
        },
      ],
    });
    const agent = await startAgent(
      io(spawn),
      dir,
      {},
      {
        ...options,
        killAfterMs: 20,
      },
    );
    expect(await agent.stop()).toEqual({ leftovers: 0, exited: 0 });
    expect(startCall(spawn)!.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  /** A probe whose `docker ps` records whether the group still ran when it was asked. */
  const watching = (spawn: FakeEve) => {
    const probe = agentProbe(["running"]);
    const alive: boolean[] = [];
    const run = probe.run;
    probe.run = async (command, args) => {
      if (command === "docker") alive.push(startCall(spawn)!.alive());
      return run(command, args);
    };
    return { probe, alive };
  };

  it("stop waits for a server that outlives pnpm exec, then counts", async () => {
    const spawn = fakeEve({
      replies: [
        { eve: ["build"] },
        { eve: ["start"], lines: START_LINES(), hold: true, linger: 150 },
      ],
    });
    const { probe, alive } = watching(spawn);
    const agent = await startAgent(
      io(spawn, probe),
      dir,
      {},
      {
        ...options,
        killAfterMs: 5_000,
      },
    );
    expect(await agent.stop()).toEqual({ leftovers: 1, exited: 0 });
    expect(startCall(spawn)!.kills).toEqual(["SIGTERM"]);
    expect(alive).toEqual([false]);
  });

  it("stop kills a server that hangs after pnpm exec exits", async () => {
    const spawn = fakeEve({
      replies: [
        { eve: ["build"] },
        {
          eve: ["start"],
          lines: START_LINES(),
          hold: true,
          linger: "until-kill",
        },
      ],
    });
    const { probe, alive } = watching(spawn);
    const agent = await startAgent(
      io(spawn, probe),
      dir,
      {},
      {
        ...options,
        killAfterMs: 50,
      },
    );
    expect(await agent.stop()).toEqual({ leftovers: 1, exited: 0 });
    expect(startCall(spawn)!.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(alive).toEqual([false]);
  });

  it("stop after pnpm exec ended on its own still ends the server's group", async () => {
    let exit!: (code: number) => void;
    const spawn = fakeEve({
      replies: [
        { eve: ["build"] },
        {
          eve: ["start"],
          lines: START_LINES(),
          hold: true,
          until: new Promise<number>((resolve) => (exit = resolve)),
          linger: "until-kill",
        },
      ],
    });
    const { probe, alive } = watching(spawn);
    const agent = await startAgent(
      io(spawn, probe),
      dir,
      {},
      {
        ...options,
        killAfterMs: 50,
      },
    );
    exit(1);
    expect(await agent.exited).toBe(1);
    expect(startCall(spawn)!.alive()).toBe(true);
    expect(await agent.stop()).toEqual({ leftovers: 1, exited: 0 });
    expect(startCall(spawn)!.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(alive).toEqual([false]);
  });

  it("counts no leftovers when docker does not answer", async () => {
    const probe = agentProbe();
    probe.run = async () => ({ exitCode: 1, stdout: "", stderr: "no docker" });
    const agent = await startAgent(io(serving(), probe), dir, {}, options);
    expect(await agent.stop()).toEqual({ leftovers: 0, exited: 0 });
  });

  it("starts eve on the given port", async () => {
    const spawn = serving();
    const agent = await startAgent(
      io(spawn),
      dir,
      {},
      { ...options, port: 8787 },
    );
    expect(startCall(spawn)!.args).toEqual([
      ...START_ARGS.slice(0, -1),
      "8787",
    ]);
    await agent.stop();
  });

  it("maps eve's EADDRINUSE before it listens to port-in-use", async () => {
    const spawn = fakeEve({
      replies: [
        { eve: ["build"] },
        {
          eve: ["start"],
          lines: [
            "Error: listen EADDRINUSE: address already in use 127.0.0.1:8787",
          ],
          exitCode: 1,
        },
      ],
    });
    await expect(
      startAgent(io(spawn), dir, {}, { ...options, port: 8787 }),
    ).rejects.toMatchObject({
      code: "port-in-use",
      message: "port 8787 is in use by another process",
      details: { port: 8787, fix: "donn agent run kody --port <other>" },
    });
  });

  it("a failed build is eve-failed and nothing starts", async () => {
    const spawn = fakeEve({
      replies: [{ eve: ["build"], lines: ["boom"], exitCode: 1 }],
    });
    await expect(startAgent(io(spawn), dir, {}, options)).rejects.toMatchObject(
      {
        code: "eve-failed",
        details: expect.objectContaining({ tail: ["boom"] }),
      },
    );
    expect(startCall(spawn)).toBeUndefined();
  });

  it("eve start exiting before it listens is eve-failed with the tail", async () => {
    const spawn = fakeEve({
      replies: [
        { eve: ["build"] },
        { eve: ["start"], lines: ["port in use"], exitCode: 1 },
      ],
    });
    await expect(startAgent(io(spawn), dir, {}, options)).rejects.toMatchObject(
      {
        code: "eve-failed",
        details: expect.objectContaining({ tail: ["port in use"] }),
      },
    );
  });

  it("no [START] line in time is eve-failed, and the group is killed", async () => {
    const spawn = fakeEve({
      replies: [
        { eve: ["build"] },
        { eve: ["start"], lines: ["warming up"], hold: true },
      ],
    });
    await expect(
      startAgent(io(spawn), dir, {}, { ...options, startTimeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "eve-failed" });
    expect(startCall(spawn)!.kills).toEqual(["SIGTERM"]);
  });

  it("hides the token and the secrets it is told of from its output lines", async () => {
    const printed = [...START_LINES()];
    const spawn = fakeEve({
      replies: [
        { eve: ["build"] },
        {
          eve: ["start"],
          hold: true,
          lines: printed,
          // Printed once the env is known: the fake reads its lines after the effect.
          effect: (c) =>
            void printed.unshift(
              `key tok-SECRET token ${c.env.DONN_ROUTE_TOKEN}`,
            ),
        },
      ],
    });
    const lines: string[] = [];
    const agent = await startAgent(
      io(spawn),
      dir,
      { API_TOKEN: "tok-SECRET" },
      {
        ...options,
        redact: ["tok-SECRET"],
        onLine: (line) => lines.push(line),
      },
    );
    expect(lines[0]).toBe("key *** token ***");
    expect(lines.join("\n")).not.toContain(agent.token);
    await agent.stop();
  });

  it("puts each agent's log under the project's hash", () => {
    const path = agentLogPath("/h", "/work/repo", "kody");
    expect(path).toMatch(/^\/h\/agents\/[0-9a-f]{16}\/kody\.log$/);
    expect(agentLogPath("/h", "/work/repo", "kody")).toBe(path);
    expect(agentLogPath("/h", "/work/other", "kody")).not.toBe(path);
  });
});

describe("donn agent run|stop|logs without a daemon", () => {
  let s: Seeded;
  beforeEach(async () => {
    s = seed();
    agentProject(s);
    await createAgent(s);
  });
  afterEach(() => s.cleanup());

  const run = (
    argv: string[],
    spawn: FakeEve,
    env: Record<string, string> = SECRETS,
  ) =>
    zz(["agent", ...argv, "--project", s.repo], {
      cwd: s.root,
      home: s.home,
      env,
      probe: agentProbe(),
      spawn,
    });

  it("runs in the foreground and stops on SIGINT with the child's code", async () => {
    const spawn = serving();
    const before = process.listenerCount("SIGINT");
    const pending = run(["run", "kody"], spawn);
    await vi.waitFor(() => expect(startCall(spawn)).toBeDefined());
    await vi.waitFor(() =>
      expect(process.listenerCount("SIGINT")).toBe(before + 1),
    );
    process.emit("SIGINT");
    const r = await pending;
    expect(r.code).toBe(143);
    const start = startCall(spawn)!;
    expect(start.kills).toEqual(["SIGTERM"]);
    expect(start.cwd).toBe(join(s.repo, "agents/kody"));
    expect(start.env.API_TOKEN).toBe("tok-SECRET");
    expect(start.env.NODE_ENV).toBe("production");
    const build = spawn.calls.find((c) => c.args.includes("build"))!;
    expect(build.env.GREETING).toBe("hello");
    for (const name of ["DONN_SECRET_1", "DONN_ROUTE_TOKEN"])
      expect(build.env[name]).toBeUndefined();
    expect(r.stdout).toContain("kody running at http://127.0.0.1:61131/");
    expect(r.stdout).toContain(start.env.DONN_ROUTE_TOKEN);
    expect(r.stdout + r.stderr).not.toContain("tok-SECRET");
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("stops before starting when a secret does not resolve", async () => {
    const spawn = serving();
    const r = await run(["run", "kody", "--json"], spawn, {
      GATEWAY_KEY: "sk-gw-SECRET",
    });
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("secret-unresolved");
    // Only the daemon's environment lacks the shell's exports.
    expect(r.stdout).not.toContain("the daemon resolves");
    expect(spawn.calls).toHaveLength(0);
  });

  it("warns, and still runs, when the agent is stale", async () => {
    const file = join(s.repo, ".donn/persona.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "inline: Checkout overview.",
        "inline: Checkout overview v2.",
      ),
    );
    const spawn = serving();
    const before = process.listenerCount("SIGINT");
    const pending = run(["run", "kody"], spawn);
    await vi.waitFor(() => expect(startCall(spawn)).toBeDefined());
    await vi.waitFor(() =>
      expect(process.listenerCount("SIGINT")).toBe(before + 1),
    );
    process.emit("SIGINT");
    const r = await pending;
    expect(r.stderr).toContain(
      "warning: kody's donn files are older than its persona, or a subagent waits for its gateway edit; `donn agent sync kody` brings them up to date",
    );
  });

  it("--dev runs eve dev in the foreground with the resolved env", async () => {
    const spawn = fakeEve({ replies: [{ eve: ["dev"], exitCode: 4 }] });
    const r = await run(["run", "kody", "--dev"], spawn, {
      ...SECRETS,
      VITEST: "true",
    });
    expect(r.code).toBe(4);
    expect(spawn.calls.map((c) => c.args)).toEqual([
      ["exec", "eve", "dev", "--port", expect.stringMatching(/^\d+$/)],
    ]);
    const dev = spawn.calls[0]!;
    expect(dev.env.API_TOKEN).toBe("tok-SECRET");
    expect(dev.env.NODE_ENV).toBe("development");
    expect(dev.env.VITEST).toBeUndefined();
  });

  it("stop with nothing running says so", async () => {
    const r = await run(["stop", "kody", "--json"], fakeEve());
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ agent: "kody", stopped: false });
  });

  it("logs prints the agent's log, and says when there is none", async () => {
    const none = await run(["logs", "kody", "--json"], fakeEve());
    expect(none.code).not.toBe(0);
    expect(none.stdout + none.stderr).toContain("no-agent-log");
    const path = agentLogPath(s.home, s.repo, "kody");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      "2026-10-25T00:00:00.000Z one\n2026-10-25T00:00:01.000Z two\n",
    );
    const r = await run(["logs", "kody"], fakeEve());
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      "2026-10-25T00:00:00.000Z one\n2026-10-25T00:00:01.000Z two\n",
    );
    const json = await run(["logs", "kody", "--json"], fakeEve());
    expect(JSON.parse(json.stdout)).toEqual({
      agent: "kody",
      log: path,
      lines: ["2026-10-25T00:00:00.000Z one", "2026-10-25T00:00:01.000Z two"],
    });
  });

  it("logs --follow prints lines as they are appended until interrupted", async () => {
    const path = agentLogPath(s.home, s.repo, "kody");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "first\n");
    const controller = new AbortController();
    const pending = zz(
      ["agent", "logs", "kody", "--follow", "--project", s.repo],
      {
        cwd: s.root,
        home: s.home,
        signal: controller.signal,
      },
    );
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(path, "first\nsecond\n");
    await new Promise((r) => setTimeout(r, 400));
    controller.abort();
    const r = await pending;
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("first\nsecond\n");
  });
});

describe("donn agent run of a vercel agent", () => {
  let s: Seeded;
  beforeEach(async () => {
    s = seed();
    agentProject(s, "vercel");
    await createAgent(s);
  });
  afterEach(() => s.cleanup());

  it("is refused before a secret resolves: eve start cannot serve it", async () => {
    const spawn = serving();
    const r = await zz(
      ["agent", "run", "kody", "--json", "--project", s.repo],
      {
        cwd: s.root,
        home: s.home,
        env: {},
        probe: agentProbe(),
        spawn,
      },
    );
    expect(r.code).not.toBe(0);
    const error = JSON.parse(r.stdout || r.stderr).error;
    expect(error).toMatchObject({
      code: "target-not-runnable",
      target: "vercel",
      fix: "donn agent run kody --dev",
    });
    expect(spawn.calls).toHaveLength(0);
  });

  it("--dev still runs it", async () => {
    const spawn = fakeEve({ replies: [{ eve: ["dev"] }] });
    const r = await zz(["agent", "run", "kody", "--dev", "--project", s.repo], {
      cwd: s.root,
      home: s.home,
      env: SECRETS,
      probe: agentProbe(),
      spawn,
    });
    expect(r.code).toBe(0);
    expect(spawn.calls.map((c) => c.args)).toEqual([["exec", "eve", "dev"]]);
  });
});

describe("donn agent run --port and the sticky port", () => {
  let s: Seeded;
  const setup = async (target?: string) => {
    s = seed();
    agentProject(s, target);
    await createAgent(s);
  };
  afterEach(() => s.cleanup());

  const go = (argv: string[], spawn: FakeEve) =>
    zz(["agent", ...argv, "--project", s.repo], {
      cwd: s.root,
      home: s.home,
      env: SECRETS,
      probe: agentProbe(),
      spawn,
    });
  const portOf = (spawn: FakeEve) => {
    const args = startCall(spawn)!.args;
    return Number(args[args.indexOf("--port") + 1]);
  };
  /** A run that is stopped at once by a SIGINT once eve listens. */
  const stopped = async (argv: string[], spawn: FakeEve) => {
    const before = process.listenerCount("SIGINT");
    const pending = go(argv, spawn);
    await vi.waitFor(() => expect(startCall(spawn)).toBeDefined());
    await vi.waitFor(() =>
      expect(process.listenerCount("SIGINT")).toBe(before + 1),
    );
    process.emit("SIGINT");
    return pending;
  };
  const stored = () => storedPort(s.home, s.repo, "kody");

  it("a foreground local run stores a picked port and says so once", async () => {
    await setup();
    const first = serving();
    const a = await stopped(["run", "kody"], first);
    const port = portOf(first);
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(await stored()).toBe(port);
    expect(a.stdout).toContain(keptNote(port, "kody"));
    const second = serving();
    const b = await stopped(["run", "kody"], second);
    expect(portOf(second)).toBe(port);
    expect(b.stdout).not.toContain("is kept for");
  });

  it("keptNote reads as the spec says", () => {
    expect(keptNote(8787, "kody")).toBe(
      "port 8787 is kept for kody; a tunnel can point at it",
    );
  });

  it("a foreground --port replaces the stored port", async () => {
    await setup();
    await stopped(["run", "kody"], serving());
    const spawn = serving();
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const free = (probe.address() as { port: number }).port;
    await new Promise((r) => probe.close(r));
    await stopped(["run", "kody", "--port", String(free)], spawn);
    expect(portOf(spawn)).toBe(free);
    expect(await stored()).toBe(free);
  });

  it("a port in use is refused and nothing is stored", async () => {
    await setup();
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(0, "127.0.0.1", () => r()));
    const port = (busy.address() as { port: number }).port;
    try {
      const spawn = serving();
      const r = await go(
        ["run", "kody", "--port", String(port), "--json"],
        spawn,
      );
      expect(r.code).not.toBe(0);
      expect(JSON.parse(r.stdout || r.stderr).error.code).toBe("port-in-use");
      expect(spawn.calls).toHaveLength(0);
      expect(await stored()).toBeUndefined();
    } finally {
      await new Promise((r) => busy.close(r));
    }
  });

  it("--dev passes the stored port to eve dev", async () => {
    await setup();
    const first = serving();
    await stopped(["run", "kody"], first);
    const port = portOf(first);
    const spawn = fakeEve({ replies: [{ eve: ["dev"] }] });
    const r = await go(["run", "kody", "--dev"], spawn);
    expect(r.code).toBe(0);
    expect(spawn.calls.map((c) => c.args)).toEqual([
      ["exec", "eve", "dev", "--port", String(port)],
    ]);
  });

  it("--port is refused for a self-host agent", async () => {
    await setup("self-host");
    const spawn = serving();
    const r = await go(["run", "kody", "--port", "8787", "--json"], spawn);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout || r.stderr).error).toMatchObject({
      code: "port-local-only",
      message: "kody targets self-host: --port applies to local agents only",
      target: "self-host",
    });
    expect(spawn.calls).toHaveLength(0);
  });

  it("--port is refused for a vercel agent under --dev", async () => {
    await setup("vercel");
    const spawn = fakeEve({ replies: [{ eve: ["dev"] }] });
    const r = await go(
      ["run", "kody", "--dev", "--port", "8787", "--json"],
      spawn,
    );
    expect(JSON.parse(r.stdout || r.stderr).error.code).toBe("port-local-only");
    expect(spawn.calls).toHaveLength(0);
  });

  it("a vercel --dev run without --port passes none", async () => {
    await setup("vercel");
    const spawn = fakeEve({ replies: [{ eve: ["dev"] }] });
    await go(["run", "kody", "--dev"], spawn);
    expect(spawn.calls.map((c) => c.args)).toEqual([["exec", "eve", "dev"]]);
  });

  it("a self-host run keeps --port 0 and stores nothing", async () => {
    await setup("self-host");
    const spawn = serving();
    await stopped(["run", "kody"], spawn);
    expect(startCall(spawn)!.args).toEqual(START_ARGS);
    expect(await stored()).toBeUndefined();
  });

  it("the CLI refuses --port 80", async () => {
    await setup();
    const spawn = serving();
    const r = await go(["run", "kody", "--port", "80", "--json"], spawn);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout || r.stderr).error).toMatchObject({
      code: "invalid-port",
      message: "--port must be an integer from 1024 to 65535",
    });
    expect(spawn.calls).toHaveLength(0);
  });
});
