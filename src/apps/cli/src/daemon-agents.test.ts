import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storedPort } from "./agent/registry.js";
import { agentLogPath, keptNote, run } from "./agent/run.js";
import { agentRunner, serial } from "./daemon/agents.js";
import { cliVersion } from "./commands/daemon.js";
import {
  connectDaemon,
  daemonRequest,
  type DaemonEvent,
} from "./daemon/client.js";
import { allowedRun } from "./daemon/run.js";
import {
  startDaemon,
  type Daemon,
  type DaemonOptions,
} from "./daemon/server.js";
import {
  agentProbe,
  agentProject,
  createAgent,
  installingEve,
  SECRETS,
  START_LINES,
} from "./test/created-agent.js";
import { fakeEve, type FakeEve } from "./test/fake-eve.js";
import { NO_USER_HOME, quietIo, seed, zz, type Seeded } from "./test/seed.js";

// The daemon runs created agents: GET /agents, POST /agents/run|stop, the agent.* events, the
// agent's log, and `donn agent run|stop|list` and `donn status` through it.
// See docs/planning/25-agent-runner.md, sections 4 `local` and 7.

let s: Seeded;
let daemons: Daemon[];
let spawn: FakeEve;
let probe: ReturnType<typeof agentProbe>;
let printed: string[];
let events: DaemonEvent[];
let unfollow: (() => void) | undefined;

beforeEach(async () => {
  s = seed();
  daemons = [];
  events = [];
  agentProject(s);
  await createAgent(s);
  printed = ["using tok-SECRET", ...START_LINES()];
  spawn = fakeEve({
    replies: [
      { eve: ["build"], lines: ["built"] },
      { eve: ["start"], lines: printed, hold: true },
    ],
  });
  probe = agentProbe(["running", "exited"]);
});
afterEach(async () => {
  unfollow?.();
  unfollow = undefined;
  await Promise.all(daemons.map((d) => d.close()));
  s.cleanup();
});

async function start(
  env: NodeJS.ProcessEnv = SECRETS,
  seams: Pick<DaemonOptions, "watch"> = {},
) {
  const daemon = await startDaemon({
    ...seams,
    home: s.home,
    env: { ...env, VITEST: "true", NODE_ENV: "test", EVE_DEV: "1" },
    version: cliVersion(),
    debounceMs: 50,
    probe,
    spawn,
    passwdHome: () => NO_USER_HOME,
  });
  daemons.push(daemon);
  const client = await connectDaemon(s.home);
  unfollow = client!.events((e) => events.push(e));
  // The stream is open once the server has added it; a status round trip is enough.
  await client!.status();
  return daemon;
}

const call = (daemon: Daemon, method: string, path: string, body?: unknown) =>
  daemonRequest(daemon.socket, daemon.token, method, path, 30_000, body);

const startCall = () => spawn.calls.find((c) => c.args.includes("start"));

/** `donn agent <argv>` in a terminal whose shell exports `env` (the persona's secrets). */
const cli = (
  argv: string[],
  cliSpawn: FakeEve = fakeEve(),
  env: NodeJS.ProcessEnv = SECRETS,
) =>
  zz(["agent", ...argv, "--project", s.repo], {
    cwd: s.root,
    home: s.home,
    env,
    probe: agentProbe(),
    spawn: cliSpawn,
  });

describe("the daemon's agents", () => {
  it("runs a created agent, lists it with its token, and stops it", async () => {
    const daemon = await start();
    const ran = await call(daemon, "POST", "/agents/run", {
      project: s.repo,
      name: "kody",
    });
    expect(ran.status).toBe(200);
    const agent = (ran.body as { agent: Record<string, unknown> }).agent;
    expect(agent).toMatchObject({
      name: "kody",
      project: s.repo,
      url: "http://127.0.0.1:61131/",
    });
    const child = startCall()!;
    expect(child.detached).toBe(true);
    expect(child.cwd).toBe(join(s.repo, "agents/kody"));
    expect(child.env.NODE_ENV).toBe("production");
    expect(child.env.API_TOKEN).toBe("tok-SECRET");
    expect(child.env.VITEST).toBeUndefined();
    expect(child.env.EVE_DEV).toBeUndefined();
    expect(child.env.DONN_ROUTE_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    const build = spawn.calls.find((c) => c.args.includes("build"))!;
    expect(build.env.GREETING).toBe("hello");
    for (const name of ["DONN_SECRET_1", "DONN_ROUTE_TOKEN"])
      expect(build.env[name]).toBeUndefined();

    const listed = await call(daemon, "GET", "/agents");
    expect(listed.body).toEqual({
      agents: [
        {
          name: "kody",
          project: s.repo,
          url: "http://127.0.0.1:61131/",
          pid: expect.any(Number),
          startedAt: expect.any(String),
          token: child.env.DONN_ROUTE_TOKEN,
        },
      ],
    });
    const status = (await call(daemon, "GET", "/status")).body as {
      agents: Record<string, unknown>[];
    };
    expect(status.agents).toEqual([
      expect.objectContaining({ name: "kody", url: "http://127.0.0.1:61131/" }),
    ]);
    expect(status.agents[0]!.token).toBeUndefined();

    const stopped = await call(daemon, "POST", "/agents/stop", {
      project: s.repo,
      name: "kody",
    });
    expect(stopped.body).toEqual({
      agent: "kody",
      stopped: true,
      leftovers: 1,
      exited: 1,
    });
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(probe.dockerCalls).toEqual([
      ["ps", "-a", "--filter", "name=eve-sbx-", "--format", "{{.State}}"],
    ]);
    expect((await call(daemon, "GET", "/agents")).body).toEqual({ agents: [] });
    const again = await call(daemon, "POST", "/agents/stop", {
      project: s.repo,
      name: "kody",
    });
    expect(again.body).toEqual({ agent: "kody", stopped: false });
  });

  it("emits agent.started and agent.stopped without the token or any value", async () => {
    const daemon = await start();
    await call(daemon, "POST", "/agents/run", {
      project: s.repo,
      name: "kody",
    });
    await call(daemon, "POST", "/agents/stop", {
      project: s.repo,
      name: "kody",
    });
    await vi.waitFor(() =>
      expect(events.map((e) => e.type)).toEqual([
        "agent.started",
        "agent.stopped",
      ]),
    );
    expect(events[0]).toMatchObject({
      name: "kody",
      project: s.repo,
      url: "http://127.0.0.1:61131/",
    });
    expect(events[1]).toMatchObject({ name: "kody", leftovers: 1, exited: 1 });
    const text = JSON.stringify(events);
    expect(text).not.toContain(startCall()!.env.DONN_ROUTE_TOKEN);
    expect(text).not.toContain("tok-SECRET");
    expect(text).not.toContain("sk-gw-SECRET");
  });

  it("writes eve's lines to the agent's log, never a secret or the token", async () => {
    const daemon = await start();
    await call(daemon, "POST", "/agents/run", {
      project: s.repo,
      name: "kody",
    });
    await call(daemon, "POST", "/agents/stop", {
      project: s.repo,
      name: "kody",
    });
    const log = readFileSync(agentLogPath(s.home, s.repo, "kody"), "utf8");
    expect(log).toContain(
      "[START] server listening at http://127.0.0.1:61131/",
    );
    expect(log).toContain("using ***");
    expect(log).not.toContain("tok-SECRET");
    expect(log).not.toContain(startCall()!.env.DONN_ROUTE_TOKEN);
    const daemonLog = readFileSync(join(s.home, "daemon/daemon.log"), "utf8");
    expect(daemonLog).not.toContain("tok-SECRET");
    expect(daemonLog).not.toContain(startCall()!.env.DONN_ROUTE_TOKEN);
  });

  it("answers a failed start with its code and emits agent.failed", async () => {
    const daemon = await start({ GATEWAY_KEY: "sk-gw-SECRET" });
    const ran = await call(daemon, "POST", "/agents/run", {
      project: s.repo,
      name: "kody",
    });
    expect(ran.status).toBe(400);
    expect(ran.body).toMatchObject({ error: { code: "secret-unresolved" } });
    // The daemon's environment is not the user's shell: the fix says so.
    const { details } = (ran.body as { error: { details: { fix: string } } })
      .error;
    expect(details.fix).toContain(
      "the daemon resolves secrets in its own environment, which has no shell exports",
    );
    expect(details.fix).toContain("keychain provider");
    expect(details.fix).toContain(
      "`donn agent run kody` in a terminal, which passes its env-provider secrets to the daemon",
    );
    expect(startCall()).toBeUndefined();
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "agent.failed",
          name: "kody",
          code: "secret-unresolved",
        }),
      ),
    );
  });

  it("answers a run on an invalid persona with its code, not internal", async () => {
    const file = join(s.repo, ".donn/persona.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "targets:\n",
        "permisions: {}\ntargets:\n",
      ),
    );
    const daemon = await start();
    const ran = await call(daemon, "POST", "/agents/run", {
      project: s.repo,
      name: "kody",
    });
    expect(ran.status).toBe(400);
    expect(ran.body).toMatchObject({ error: { code: "invalid-persona" } });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "agent.failed",
          name: "kody",
          code: "invalid-persona",
        }),
      ),
    );
    const viaCli = await cli(["run", "kody", "--json"]);
    expect(viaCli.code).toBe(1);
    expect(JSON.parse(viaCli.stdout).error).toMatchObject({
      code: "invalid-persona",
    });
  });

  it("refuses a malformed run request", async () => {
    const daemon = await start();
    const bad = await call(daemon, "POST", "/agents/run", { name: "kody" });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: { code: "bad-request" } });
  });

  it("an agent that exits on its own is agent.failed and leaves the list", async () => {
    let exit!: (code: number) => void;
    spawn = fakeEve({
      replies: [
        { eve: ["build"] },
        {
          eve: ["start"],
          lines: START_LINES(),
          hold: true,
          until: new Promise<number>((resolve) => (exit = resolve)),
        },
      ],
    });
    const daemon = await start();
    await call(daemon, "POST", "/agents/run", {
      project: s.repo,
      name: "kody",
    });
    exit(1);
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "agent.failed",
          name: "kody",
          exitCode: 1,
        }),
      ),
    );
    expect((await call(daemon, "GET", "/agents")).body).toEqual({ agents: [] });
  });

  it("refuses a vercel agent: eve start cannot serve its routes", async () => {
    s.cleanup();
    s = seed();
    agentProject(s, "vercel");
    await createAgent(s);
    const daemon = await start();
    const ran = await call(daemon, "POST", "/agents/run", {
      project: s.repo,
      name: "kody",
    });
    expect(ran.status).toBe(400);
    expect(ran.body).toMatchObject({
      error: {
        code: "target-not-runnable",
        details: { target: "vercel", fix: "donn agent run kody --dev" },
      },
    });
    expect(startCall()).toBeUndefined();
  });

  it(
    "donn daemon stop waits for an agent whose server is slow to stop",
    { timeout: 30_000 },
    async () => {
      spawn = fakeEve({
        replies: [
          { eve: ["build"] },
          // pnpm exec goes at once; the server takes 6 s, past the old 5 s stop wait.
          { eve: ["start"], lines: START_LINES(), hold: true, linger: 6_000 },
        ],
      });
      const daemon = await start();
      await call(daemon, "POST", "/agents/run", {
        project: s.repo,
        name: "kody",
      });
      const stopped = await zz(["daemon", "stop", "--json"], {
        cwd: s.root,
        home: s.home,
      });
      expect(stopped.stderr).toBe("");
      expect(stopped.code).toBe(0);
      expect(JSON.parse(stopped.stdout)).toEqual({
        running: false,
        stopped: true,
      });
      await daemon.closed;
      expect(startCall()!.kills).toEqual(["SIGTERM"]);
    },
  );

  it("stops every running agent when the daemon closes", async () => {
    const daemon = await start();
    await call(daemon, "POST", "/agents/run", {
      project: s.repo,
      name: "kody",
    });
    await daemon.close();
    expect(startCall()!.kills).toEqual(["SIGTERM"]);
  });

  it("emits agent.created when POST /run completes an agent create", async () => {
    spawn = installingEve();
    const daemon = await start();
    const ran = await call(daemon, "POST", "/run", {
      argv: [
        "agent",
        "create",
        "rex",
        "--template",
        "./templates/kody",
        "--target",
        "local",
        "--json",
      ],
      cwd: s.repo,
    });
    expect((ran.body as { exitCode: number }).exitCode).toBe(0);
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "agent.created",
          name: "rex",
          project: s.repo,
        }),
      ),
    );
    expect(existsSync(join(s.repo, "agents/rex/.donn/agent.json"))).toBe(true);
    // The index changed too: the daemon's own pass over it does not announce rex again.
    await call(daemon, "POST", "/refresh");
    expect(
      events.filter((e) => e.type === "agent.created" && e.name === "rex"),
    ).toHaveLength(1);
  });

  it("emits agent.created for an agent created in a terminal", async () => {
    await start();
    const created = await zz(
      [
        "agent",
        "create",
        "rex",
        "--template",
        "./templates/kody",
        "--target",
        "local",
        "--project",
        s.repo,
      ],
      {
        cwd: s.root,
        home: s.home,
        env: SECRETS,
        probe: agentProbe(),
        spawn: installingEve(),
      },
    );
    expect(created.code).toBe(0);
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "agent.created",
          name: "rex",
          project: s.repo,
        }),
      ),
    );
    expect(events.filter((e) => e.type === "agent.created")).toHaveLength(1);
  });
});

describe("the daemon keeps created agents current", () => {
  const persona = () => join(s.repo, ".donn/persona.yaml");
  const editPersona = (from: string, to: string) => {
    const text = readFileSync(persona(), "utf8");
    expect(text).toContain(from);
    writeFileSync(persona(), text.replace(from, to));
  };
  const agentDir = () => join(s.repo, "agents/kody");
  /** Every file under the agent's folder, by path, except node_modules. */
  const files = (dir = agentDir(), prefix = ""): Record<string, string> =>
    Object.fromEntries(
      readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.name !== "node_modules")
        .flatMap((d) =>
          d.isDirectory()
            ? Object.entries(files(join(dir, d.name), `${prefix}${d.name}/`))
            : [[`${prefix}${d.name}`, readFileSync(join(dir, d.name), "utf8")]],
        ),
    );
  const starts = () => spawn.calls.filter((c) => c.args.includes("start"));
  const daemonLog = () =>
    readFileSync(join(s.home, "daemon/daemon.log"), "utf8");

  it(
    "syncs on a persona edit and restarts a running agent",
    { timeout: 15_000 },
    async () => {
      const daemon = await start();
      await call(daemon, "POST", "/agents/run", {
        project: s.repo,
        name: "kody",
      });
      editPersona(
        "inline: Checkout overview.",
        "inline: Checkout overview v2.",
      );
      await vi.waitFor(
        () =>
          expect(events).toContainEqual(
            expect.objectContaining({ type: "agent.synced", name: "kody" }),
          ),
        { timeout: 5_000 },
      );
      const synced = events.find((e) => e.type === "agent.synced")!;
      expect(synced).toMatchObject({ project: s.repo, removed: [] });
      expect((synced.written as string[]).length).toBeGreaterThan(0);
      expect(Object.values(files()).join("\n")).toContain(
        "Checkout overview v2.",
      );
      // Stopped, then built and started again with a new route token.
      await vi.waitFor(() => expect(starts()).toHaveLength(2), {
        timeout: 5_000,
      });
      expect(starts()[0]!.kills).toEqual(["SIGTERM"]);
      expect(starts()[1]!.env.DONN_ROUTE_TOKEN).not.toBe(
        starts()[0]!.env.DONN_ROUTE_TOKEN,
      );
      expect(starts()[1]!.env.API_TOKEN).toBe("tok-SECRET");
      await vi.waitFor(() =>
        expect(events.map((e) => e.type)).toEqual([
          "agent.started",
          "agent.synced",
          "agent.stopped",
          "agent.started",
        ]),
      );
      const text = JSON.stringify(events);
      expect(text).not.toContain("tok-SECRET");
      expect(text).not.toContain(starts()[1]!.env.DONN_ROUTE_TOKEN);
    },
  );

  it(
    "restarts a running agent when only its env changed",
    { timeout: 15_000 },
    async () => {
      const daemon = await start();
      await call(daemon, "POST", "/agents/run", {
        project: s.repo,
        name: "kody",
      });
      expect(starts()[0]!.env.GREETING).toBe("hello");
      const before = files();
      editPersona("GREETING: hello", "GREETING: hello-again");
      await vi.waitFor(() => expect(starts()).toHaveLength(2), {
        timeout: 5_000,
      });
      expect(starts()[1]!.env.GREETING).toBe("hello-again");
      // No file donn owns changed: a restart for the env alone.
      expect(files()).toEqual(before);
      await vi.waitFor(() =>
        expect(events.map((e) => e.type)).toEqual([
          "agent.started",
          "agent.stopped",
          "agent.started",
        ]),
      );
      const text = JSON.stringify(events);
      expect(text).not.toContain("hello-again");
      expect(text).not.toContain("tok-SECRET");
    },
  );

  it(
    "leaves a running agent alone when nothing it runs with changed",
    { timeout: 15_000 },
    async () => {
      const daemon = await start();
      await call(daemon, "POST", "/agents/run", {
        project: s.repo,
        name: "kody",
      });
      // A comment: a sync that changes nothing, and the same env.
      editPersona("agents:\n", "agents:\n  # kody\n");
      await call(daemon, "POST", "/refresh");
      await vi.waitFor(() =>
        expect(daemonLog()).toMatch(/kody .*env unchanged/),
      );
      expect(starts()).toHaveLength(1);
    },
  );

  it(
    "syncs an agent that is not running without starting it",
    { timeout: 15_000 },
    async () => {
      await start();
      editPersona(
        "inline: Checkout overview.",
        "inline: Checkout overview v2.",
      );
      await vi.waitFor(
        () =>
          expect(events).toContainEqual(
            expect.objectContaining({ type: "agent.synced", name: "kody" }),
          ),
        { timeout: 5_000 },
      );
      expect(starts()).toHaveLength(0);
    },
  );

  it(
    "an edit to a shared layer syncs the agents that inherit it",
    { timeout: 15_000 },
    async () => {
      await start();
      writeFileSync(
        join(s.personas, "org/instructions/conduct.md"),
        "Review kindly, v2.",
      );
      await vi.waitFor(
        () =>
          expect(events).toContainEqual(
            expect.objectContaining({ type: "agent.synced", name: "kody" }),
          ),
        { timeout: 5_000 },
      );
      expect(Object.values(files()).join("\n")).toContain("Review kindly, v2.");
    },
  );

  it(
    "an edit the watchers miss while they arm is synced once they settle",
    { timeout: 15_000 },
    async () => {
      // fs.watch arms asynchronously (FSEvents on macOS), so an edit made just after the daemon
      // starts watching can go unseen. These watchers see nothing and settle when told to.
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => (settle = resolve));
      await start(SECRETS, {
        watch: (paths) => ({ paths, settled, close: () => {} }),
      });
      writeFileSync(
        join(s.personas, "org/instructions/conduct.md"),
        "Review kindly, v2.",
      );
      settle();
      await vi.waitFor(
        () =>
          expect(events).toContainEqual(
            expect.objectContaining({ type: "agent.synced", name: "kody" }),
          ),
        { timeout: 5_000 },
      );
      expect(Object.values(files()).join("\n")).toContain("Review kindly, v2.");
    },
  );

  it(
    "an edited owned file stops the sync: agent.sync-failed, a status line, no write",
    { timeout: 15_000 },
    async () => {
      const daemon = await start();
      await call(daemon, "POST", "/agents/run", {
        project: s.repo,
        name: "kody",
      });
      writeFileSync(join(agentDir(), "agent/lib/donn/config.ts"), "// mine\n");
      const before = files();
      editPersona(
        "inline: Checkout overview.",
        "inline: Checkout overview v2.",
      );
      await vi.waitFor(
        () =>
          expect(events).toContainEqual({
            type: "agent.sync-failed",
            name: "kody",
            project: s.repo,
            code: "owned-file-edited",
          }),
        { timeout: 5_000 },
      );
      expect(files()).toEqual(before);
      expect(events.map((e) => e.type)).not.toContain("agent.synced");
      // Never forced, and the running agent is left as it was.
      expect(starts()).toHaveLength(1);
      expect(starts()[0]!.kills).toEqual([]);

      const status = await zz(["status"], { cwd: s.root, home: s.home });
      expect(status.stdout).toContain(
        "agent  kody  local  running  stale  sync-failed: owned-file-edited",
      );
      const json = await zz(["status", "--json"], {
        cwd: s.root,
        home: s.home,
      });
      expect(JSON.parse(json.stdout).agents).toEqual([
        expect.objectContaining({
          name: "kody",
          syncFailed: "owned-file-edited",
        }),
      ]);
    },
  );

  it(
    "an invalid persona stops the sync with its code: agent.sync-failed",
    { timeout: 15_000 },
    async () => {
      await start();
      editPersona("targets:\n", "permisions: {}\ntargets:\n");
      await vi.waitFor(
        () =>
          expect(events).toContainEqual({
            type: "agent.sync-failed",
            name: "kody",
            project: s.repo,
            code: "invalid-persona",
          }),
        { timeout: 5_000 },
      );
    },
  );

  it(
    "a changed target is not synced: status says recreate needed",
    { timeout: 15_000 },
    async () => {
      await start();
      editPersona("target: local", "target: self-host");
      await vi.waitFor(
        () => expect(daemonLog()).toContain("recreate needed (target)"),
        { timeout: 5_000 },
      );
      expect(events.filter((e) => e.type.startsWith("agent.sync"))).toEqual([]);
      const status = await zz(["status"], { cwd: s.root, home: s.home });
      expect(status.stdout).toContain(
        "agent  kody  self-host  created  stale  recreate needed (target)",
      );
      const json = await zz(["status", "--json"], {
        cwd: s.root,
        home: s.home,
      });
      expect(JSON.parse(json.stdout).agents).toEqual([
        expect.objectContaining({ name: "kody", recreate: "target" }),
      ]);
    },
  );

  it("watches the projects with created agents, not the others", async () => {
    const other = join(s.root, "other-repo");
    mkdirSync(join(other, ".donn"), { recursive: true });
    writeFileSync(
      join(other, ".donn/persona.yaml"),
      readFileSync(persona(), "utf8"),
    );
    const daemon = await start();
    const { watching } = (await call(daemon, "GET", "/status")).body as {
      watching: string[];
    };
    expect(watching).toContain(join(s.repo, ".donn"));
    expect(watching).toContain(join(s.home, "agents", "index.json"));
    expect(watching).not.toContain(join(other, ".donn"));
  });

  it("serial goes on after work that fails, and settles", async () => {
    const one = serial();
    let calls = 0;
    const fail = async () => {
      calls++;
      throw new Error("boom");
    };
    const runs = [1, 2, 3].map(() => one.next("k", fail));
    for (const r of runs) await expect(r).rejects.toThrow("boom");
    expect(calls).toBe(2);
    await one.settled();
    // Not stuck: the key runs again.
    await expect(one.next("k", fail)).rejects.toThrow("boom");
    expect(calls).toBe(3);
  });

  it("serialises the syncs of one agent: a burst runs one, then one more", async () => {
    let active = 0;
    let most = 0;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runner = agentRunner({
      home: s.home,
      io: quietIo({ cwd: s.root, home: s.home }),
      emit: () => {},
      log: async () => {},
      now: Date.now,
      syncAgent: async () => {
        calls++;
        active++;
        most = Math.max(most, active);
        await gate;
        active--;
        return { written: [], removed: [] };
      },
    });
    const burst = [1, 2, 3, 4].map(() => runner.sync(s.repo, "kody"));
    release();
    await Promise.all(burst);
    expect(most).toBe(1);
    expect(calls).toBe(2);
    await runner.closeAll();
  });
});

describe("donn agent run|stop|list and status through the daemon", () => {
  it("runs through the daemon, shows it running, and stops it", async () => {
    await start();
    const cliSpawn = fakeEve();
    const ran = await cli(["run", "kody", "--json"], cliSpawn);
    // Only the first-run port note, which --json sends to stderr.
    expect(ran.stderr).toBe(
      `${keptNote((await storedPort(s.home, s.repo, "kody"))!, "kody")}\n`,
    );
    expect(ran.code).toBe(0);
    expect(cliSpawn.calls).toHaveLength(0);
    expect(JSON.parse(ran.stdout).agent).toMatchObject({
      name: "kody",
      url: "http://127.0.0.1:61131/",
      token: startCall()!.env.DONN_ROUTE_TOKEN,
    });

    const list = await cli(["list", "--json"]);
    expect(JSON.parse(list.stdout).agents).toEqual([
      expect.objectContaining({
        name: "kody",
        state: "running",
        url: "http://127.0.0.1:61131/",
      }),
    ]);
    const status = await zz(["status"], { cwd: s.root, home: s.home });
    expect(status.stdout).toContain("agent  kody  local  running  current");
    const statusJson = await zz(["status", "--json"], {
      cwd: s.root,
      home: s.home,
    });
    expect(JSON.parse(statusJson.stdout).agents).toEqual([
      expect.objectContaining({
        name: "kody",
        project: s.repo,
        target: "local",
        state: "running",
        current: true,
      }),
    ]);
    expect(statusJson.stdout).not.toContain(startCall()!.env.DONN_ROUTE_TOKEN);

    const stopped = await cli(["stop", "kody"]);
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain("stopped kody");
    expect(stopped.stdout).toContain(
      "1 eve-sbx- sandbox container still running",
    );
    expect(stopped.stdout).toContain(
      "1 stopped eve-sbx- sandbox container kept",
    );
    expect(startCall()!.kills).toEqual(["SIGTERM"]);
  });

  it("status lists created agents without a daemon, never running", async () => {
    const status = await zz(["status"], { cwd: s.root, home: s.home });
    expect(status.stdout).toContain("agent  kody  local  created  current");
  });

  it("POST /run runs agent run, stop and list in-process", async () => {
    const daemon = await start();
    const ran = await call(daemon, "POST", "/run", {
      argv: ["agent", "run", "kody", "--json"],
      cwd: s.repo,
    });
    expect(ran.body).toMatchObject({ exitCode: 0 });
    expect(startCall()).toBeDefined();
    const list = await call(daemon, "POST", "/run", {
      argv: ["agent", "list", "--json"],
      cwd: s.repo,
    });
    const rows = JSON.parse((list.body as { stdout: string }).stdout).agents;
    expect(rows[0]).toMatchObject({ name: "kody", state: "running" });
    const stop = await call(daemon, "POST", "/run", {
      argv: ["agent", "stop", "kody", "--json"],
      cwd: s.repo,
    });
    expect(JSON.parse((stop.body as { stdout: string }).stdout)).toEqual({
      agent: "kody",
      stopped: true,
      leftovers: 1,
      exited: 1,
    });
  });
});

describe("env-provider secrets of a run (spec 26 §2)", () => {
  /** Values only this test's terminal exports: the daemon's env has none of them. */
  const SHELL = { GATEWAY_KEY: "sk-gw-SHELLONLY", API_TOKEN: "tok-SHELLONLY" };
  const persona = () => join(s.repo, ".donn/persona.yaml");
  const starts = () => spawn.calls.filter((c) => c.args.includes("start"));
  const daemonLog = () =>
    readFileSync(join(s.home, "daemon/daemon.log"), "utf8");
  /** Everything the daemon shows or keeps about its runs, as text. */
  const shown = async (daemon: Daemon) =>
    [
      JSON.stringify((await call(daemon, "GET", "/agents")).body),
      JSON.stringify((await call(daemon, "GET", "/status")).body),
      JSON.stringify(events),
      daemonLog(),
      readFileSync(agentLogPath(s.home, s.repo, "kody"), "utf8"),
      (await zz(["status", "--json"], { cwd: s.root, home: s.home })).stdout,
    ].join("\n");

  it(
    "a terminal run sends its env-provider values; the daemon never shows them",
    { timeout: 15_000 },
    async () => {
      printed = ["using tok-SHELLONLY", ...START_LINES()];
      spawn = fakeEve({
        replies: [
          { eve: ["build"], lines: ["built"] },
          { eve: ["start"], lines: printed, hold: true },
        ],
      });
      const daemon = await start({});
      const ran = await cli(["run", "kody", "--json"], fakeEve(), SHELL);
      // Under --json the first-run port note goes to stderr, and nothing else.
      expect(ran.stderr).toBe(
        `${keptNote((await storedPort(s.home, s.repo, "kody"))!, "kody")}\n`,
      );
      expect(ran.code).toBe(0);
      expect(startCall()!.env.API_TOKEN).toBe("tok-SHELLONLY");
      expect(Object.values(startCall()!.env)).toContain("sk-gw-SHELLONLY");
      // The run answers once the agent listens; its log lines are appended after.
      await vi.waitFor(() =>
        expect(
          readFileSync(agentLogPath(s.home, s.repo, "kody"), "utf8"),
        ).toContain("using ***"),
      );
      const text = await shown(daemon);
      expect(text).toContain("using ***");
      expect(text).not.toContain("SHELLONLY");

      // Values that changed in the shell do not restart a running agent.
      const again = await cli(["run", "kody", "--json"], fakeEve(), {
        ...SHELL,
        API_TOKEN: "tok-CHANGED",
      });
      expect(JSON.parse(again.stdout)).toMatchObject({ already: true });
      expect(starts()).toHaveLength(1);
    },
  );

  it(
    "a restart after a sync keeps the values the run started with",
    { timeout: 15_000 },
    async () => {
      const daemon = await start({});
      expect(
        (await cli(["run", "kody", "--json"], fakeEve(), SHELL)).code,
      ).toBe(0);
      const text = readFileSync(persona(), "utf8");
      writeFileSync(
        persona(),
        text.replace("GREETING: hello", "GREETING: hello-again"),
      );
      await vi.waitFor(() => expect(starts()).toHaveLength(2), {
        timeout: 5_000,
      });
      expect(starts()[1]!.env.GREETING).toBe("hello-again");
      expect(starts()[1]!.env.API_TOKEN).toBe("tok-SHELLONLY");
      await vi.waitFor(() =>
        expect(events.map((e) => e.type)).toContain("agent.started"),
      );
      expect(await shown(daemon)).not.toContain("SHELLONLY");
    },
  );

  it(
    "a restart drops a sent value whose ref the persona no longer uses",
    { timeout: 15_000 },
    async () => {
      await start({ OTHER_TOKEN: "tok-DAEMON" });
      expect(
        (await cli(["run", "kody", "--json"], fakeEve(), SHELL)).code,
      ).toBe(0);
      const text = readFileSync(persona(), "utf8");
      writeFileSync(
        persona(),
        text.replace(
          "API_TOKEN: secret://env/API_TOKEN",
          "API_TOKEN: secret://env/OTHER_TOKEN",
        ),
      );
      await vi.waitFor(() => expect(starts()).toHaveLength(2), {
        timeout: 5_000,
      });
      expect(starts()[1]!.env.API_TOKEN).toBe("tok-DAEMON");
      expect(Object.values(starts()[1]!.env)).toContain("sk-gw-SHELLONLY");
    },
  );

  it("a terminal whose shell lacks a value fails before asking the daemon", async () => {
    await start();
    const ran = await cli(["run", "kody", "--json"], fakeEve(), {
      GATEWAY_KEY: "sk-gw-SECRET",
    });
    expect(ran.code).not.toBe(0);
    expect(JSON.parse(ran.stdout)).toMatchObject({
      error: { code: "secret-unresolved" },
    });
    expect(ran.stdout).toContain("secret://env/API_TOKEN");
    expect(startCall()).toBeUndefined();
  });

  it(
    "a terminal without the values finds a running agent running, resolving nothing",
    { timeout: 15_000 },
    async () => {
      await start({});
      expect(
        (await cli(["run", "kody", "--json"], fakeEve(), SHELL)).code,
      ).toBe(0);
      const fresh = await cli(["run", "kody", "--json"], fakeEve(), {});
      expect(fresh.stderr).toBe("");
      expect(fresh.code).toBe(0);
      expect(JSON.parse(fresh.stdout)).toMatchObject({ already: true });
      expect(starts()).toHaveLength(1);
    },
  );

  it("a deploy donn ui starts has no shell either: env-provider refs fail with the fix, nothing pushed", async () => {
    s.cleanup();
    s = seed();
    agentProject(s, "vercel");
    await createAgent(s);
    const daemon = await start();
    const opened = await call(daemon, "POST", "/ui/open", {});
    const { port, code } = opened.body as { port: number; code: string };
    const post = (path: string, body: unknown, token?: string) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token !== undefined && { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      }).then(async (res) => (await res.json()) as Record<string, unknown>);
    const { token } = (await post("/v1/session", { code })) as {
      token: string;
    };
    const argv = ["agent", "deploy", "kody", "--yes", "--json"];
    const ran = await post("/v1/run", { argv, cwd: s.repo }, token);
    expect(ran.exitCode).toBe(1);
    expect(JSON.parse(ran.stdout as string)).toMatchObject({
      error: {
        code: "secret-unresolved",
        fix: "a deploy started from donn ui has no shell environment: use the keychain provider for secret://env/API_TOKEN and secret://env/GATEWAY_KEY, or run donn agent deploy kody in a terminal",
      },
    });
    // Refused before eve link or eve deploy: nothing left the machine.
    const eveCalls = spawn.calls.map((c) => c.args.join(" "));
    expect(
      eveCalls.some((c) => c.includes("link") || c.includes("deploy")),
    ).toBe(false);
    // The dry run resolves nothing, so donn ui can show it.
    const dry = await post(
      "/v1/run",
      { argv: ["agent", "deploy", "kody", "--dry-run", "--json"], cwd: s.repo },
      token,
    );
    expect(dry.exitCode, dry.stdout as string).toBe(0);
    expect(JSON.parse(dry.stdout as string)).toMatchObject({
      dryRun: true,
      names: ["API_TOKEN", "DONN_SECRET_1", "GREETING"],
    });
  });

  it("a run donn ui starts has no shell: env-provider refs fail with the fix", async () => {
    // Even with the values in the daemon's own env: the UI is no shell.
    const daemon = await start();
    const opened = await call(daemon, "POST", "/ui/open", {});
    const { port, code } = opened.body as { port: number; code: string };
    const bridge = (path: string, body: unknown, token?: string) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: path.startsWith("/v1/jobs/") ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          ...(token !== undefined && { authorization: `Bearer ${token}` }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }).then(async (res) => (await res.json()) as Record<string, unknown>);
    const { token } = (await bridge("/v1/session", { code })) as {
      token: string;
    };
    const fix =
      "a run started from donn ui has no shell environment: use the keychain provider for secret://env/API_TOKEN and secret://env/GATEWAY_KEY, or run donn agent run kody in a terminal";
    const argv = ["agent", "run", "kody", "--json"];
    const ran = await bridge("/v1/run", { argv, cwd: s.repo }, token);
    expect(ran.exitCode).toBe(1);
    expect(JSON.parse(ran.stdout as string)).toMatchObject({
      error: { code: "secret-unresolved", fix },
    });
    const { id } = (await bridge("/v1/jobs", { argv, cwd: s.repo }, token)) as {
      id: string;
    };
    await vi.waitFor(async () =>
      expect(await bridge(`/v1/jobs/${id}`, undefined, token)).toMatchObject({
        state: "done",
      }),
    );
    const job = await bridge(`/v1/jobs/${id}`, undefined, token);
    expect(job.exitCode).toBe(1);
    expect(JSON.parse(job.stdout as string)).toMatchObject({
      error: { code: "secret-unresolved", fix },
    });
    expect(startCall()).toBeUndefined();
  });

  it("refuses an env that is not refs to strings, too big, or not the agent's", async () => {
    const daemon = await start({});
    for (const env of [
      "x",
      ["tok"],
      { "secret://env/API_TOKEN": 1 },
      { API_TOKEN: "tok" },
      Object.fromEntries(
        Array.from({ length: 101 }, (_, i) => [`secret://env/K${i}`, "v"]),
      ),
      { "secret://env/API_TOKEN": "x".repeat(65 * 1024) },
    ]) {
      const ran = await call(daemon, "POST", "/agents/run", {
        project: s.repo,
        name: "kody",
        env,
      });
      expect(ran.status, JSON.stringify(env).slice(0, 80)).toBe(400);
      expect(ran.body).toMatchObject({ error: { code: "bad-request" } });
    }
    const unused = await call(daemon, "POST", "/agents/run", {
      project: s.repo,
      name: "kody",
      env: { ...SHELL_REFS(), "secret://env/OTHER": "tok-NOTUSED" },
    });
    expect(unused.status).toBe(400);
    expect(unused.body).toMatchObject({ error: { code: "env-not-used" } });
    expect(JSON.stringify(unused.body)).not.toContain("tok-NOTUSED");
    expect(daemonLog()).not.toContain("tok-NOTUSED");
    expect(startCall()).toBeUndefined();
  });

  const SHELL_REFS = () => ({
    "secret://env/GATEWAY_KEY": SHELL.GATEWAY_KEY,
    "secret://env/API_TOKEN": SHELL.API_TOKEN,
  });
});

describe("allowedRun for agent", () => {
  it("accepts the agent subcommands the GUI sends", () => {
    for (const argv of [
      ["agent", "list", "--json"],
      ["agent", "list", "--project", "/r", "--json"],
      ["agent", "sync", "kody", "--dry-run", "--json"],
      ["agent", "sync", "kody", "--force", "--project", "/r", "--json"],
      ["agent", "run", "kody", "--json"],
      ["agent", "stop", "kody", "--json"],
      ["agent", "build", "kody", "--json"],
      ["agent", "env", "kody", "--format", "json", "--json"],
      [
        "agent",
        "create",
        "kody",
        "--template",
        "eve:blank",
        "--target",
        "local",
        "--path",
        "agents/k",
        "--eve",
        "0.83.2",
        "--accept-portability",
        "--force",
        "--dry-run",
        "--json",
      ],
    ]) {
      expect(allowedRun(argv), argv.join(" ")).toBe(true);
    }
  });

  it("refuses exec, logs, deploy, --resolve, --dev and malformed forms", () => {
    for (const argv of [
      ["agent", "exec", "kody", "--json"],
      ["agent", "logs", "kody", "--json"],
      ["agent", "deploy", "kody", "--json"],
      ["agent", "env", "kody", "--resolve", "--json"],
      ["agent", "run", "kody", "--dev", "--json"],
      ["agent", "run", "kody"],
      ["agent", "run", "--json"],
      ["agent", "run", "kody", "rex", "--json"],
      ["agent", "list", "kody", "--json"],
      ["agent", "sync", "kody", "--project", "--json"],
      ["agent", "sync", "kody", "--force", "--force", "--json"],
      ["agent", "--json"],
      ["agent", "env", "kody", "--format=json", "--json"],
    ]) {
      expect(allowedRun(argv), argv.join(" ")).toBe(false);
    }
  });
});

describe("a sticky port through the daemon", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((v) => new Promise((r) => v.close(r))),
    );
  });
  /** A free port, and one that is taken until the test ends. */
  const listen = async (keep: boolean) => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    if (keep) servers.push(server);
    else await new Promise((r) => server.close(r));
    return port;
  };
  const starts = () => spawn.calls.filter((c) => c.args.includes("start"));
  const portOf = (i: number) => {
    const args = starts()[i]!.args;
    return Number(args[args.indexOf("--port") + 1]);
  };
  const body = (extra: object = {}) => ({
    project: s.repo,
    name: "kody",
    ...extra,
  });
  const stored = () => storedPort(s.home, s.repo, "kody");

  it("a first daemon run stores a port and a second run reuses it", async () => {
    const daemon = await start();
    await call(daemon, "POST", "/agents/run", body());
    const port = portOf(0);
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(await stored()).toBe(port);
    await call(daemon, "POST", "/agents/stop", body());
    await call(daemon, "POST", "/agents/run", body());
    expect(portOf(1)).toBe(port);
  });

  it("a restart after a sync keeps the port", async () => {
    const runner = agentRunner({
      home: s.home,
      io: {
        ...quietIo({ cwd: s.root, home: s.home, env: SECRETS }),
        spawn,
        probe,
      },
      emit: (e) => events.push(e),
      log: async () => {},
      now: Date.now,
      syncAgent: async () => ({ written: ["x"], removed: [] }),
    });
    await runner.run(s.repo, "kody");
    await runner.sync(s.repo, "kody");
    await vi.waitFor(() => expect(starts()).toHaveLength(2));
    expect(portOf(0)).toBeGreaterThanOrEqual(1024);
    expect(portOf(1)).toBe(portOf(0));
    await runner.closeAll();
  });

  it("--port through the daemon replaces the stored port", async () => {
    const daemon = await start();
    await call(daemon, "POST", "/agents/run", body());
    await call(daemon, "POST", "/agents/stop", body());
    const port = await listen(false);
    await call(daemon, "POST", "/agents/run", body({ port }));
    expect(portOf(1)).toBe(port);
    expect(await stored()).toBe(port);
  });

  it("a taken port through the daemon is never stored", async () => {
    const daemon = await start();
    const port = await listen(true);
    const ran = await call(daemon, "POST", "/agents/run", body({ port }));
    expect(ran.status).toBe(400);
    expect(ran.body).toMatchObject({ error: { code: "port-in-use" } });
    expect(starts()).toHaveLength(0);
    expect(await stored()).toBeUndefined();
  });

  it("a restart that meets a taken port is a sync failure", async () => {
    const runner = agentRunner({
      home: s.home,
      io: {
        ...quietIo({ cwd: s.root, home: s.home, env: SECRETS }),
        spawn,
        probe,
      },
      emit: (e) => events.push(e),
      log: async () => {},
      now: Date.now,
      syncAgent: async () => {
        // The fake eve binds nothing, so the test takes the agent's port itself.
        const server = createServer();
        servers.push(server);
        await new Promise<void>((r) =>
          server.listen(portOf(0), "127.0.0.1", () => r()),
        );
        return { written: ["x"], removed: [] };
      },
    });
    await runner.run(s.repo, "kody");
    await runner.sync(s.repo, "kody");
    await vi.waitFor(() =>
      expect(runner.syncFailures()).toEqual([
        { name: "kody", project: s.repo, code: "port-in-use" },
      ]),
    );
    expect(events).toContainEqual({
      type: "agent.sync-failed",
      name: "kody",
      project: s.repo,
      code: "port-in-use",
    });
    expect(starts()).toHaveLength(1);
    // Freed, and the agent run again: the failure is over.
    await Promise.all(
      servers.splice(0).map((v) => new Promise((r) => v.close(r))),
    );
    await runner.run(s.repo, "kody");
    expect(starts()).toHaveLength(2);
    expect(runner.syncFailures()).toEqual([]);
    await runner.closeAll();
  });

  it("--port while a start of the same agent is pending is agent-running", async () => {
    const runner = agentRunner({
      home: s.home,
      io: {
        ...quietIo({ cwd: s.root, home: s.home, env: SECRETS }),
        spawn,
        probe,
      },
      emit: (e) => events.push(e),
      log: async () => {},
      now: Date.now,
    });
    const port = await listen(false);
    const first = runner.run(s.repo, "kody");
    await expect(runner.run(s.repo, "kody", { port })).rejects.toMatchObject({
      code: "agent-running",
      details: { fix: "donn agent stop kody" },
    });
    await first;
    expect(starts()).toHaveLength(1);
    await runner.closeAll();
  });

  it("a socket run with another port to a running agent is agent-running", async () => {
    const daemon = await start();
    await call(daemon, "POST", "/agents/run", body());
    const port = await listen(false);
    const ran = await call(daemon, "POST", "/agents/run", body({ port }));
    expect(ran.status).toBe(400);
    expect(ran.body).toMatchObject({
      error: {
        code: "agent-running",
        details: { port: 61131, fix: "donn agent stop kody" },
      },
    });
    expect(starts()).toHaveLength(1);
  });

  it("--dev next to a daemon-run agent is refused and spawns nothing", async () => {
    await start();
    await cli(["run", "kody", "--json"]);
    const before = await stored();
    const devSpawn = fakeEve({ replies: [{ eve: ["dev"] }] });
    const r = await cli(["run", "kody", "--dev", "--json"], devSpawn);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout || r.stderr).error).toMatchObject({
      code: "agent-running",
      message:
        "kody is running under the daemon on port 61131; stop it to run it with --dev",
      port: 61131,
      fix: "donn agent stop kody",
    });
    expect(devSpawn.calls).toHaveLength(0);
    expect(await stored()).toBe(before);
  });

  it("a different --port while running is agent-running", async () => {
    await start();
    await cli(["run", "kody", "--json"]);
    const r = await cli(["run", "kody", "--port", "8787", "--json"]);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout || r.stderr).error).toMatchObject({
      code: "agent-running",
      message: "kody is running on port 61131; stop it to change its port",
      port: 61131,
      fix: "donn agent stop kody",
    });
  });

  it("the same port while running is already running", async () => {
    await start();
    await cli(["run", "kody", "--json"]);
    const r = await cli(["run", "kody", "--port", "61131", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).already).toBe(true);
    expect(starts()).toHaveLength(1);
  });

  it("--port on a running self-host agent is port-local-only", async () => {
    s.cleanup();
    s = seed();
    agentProject(s, "self-host");
    await createAgent(s);
    await start();
    await cli(["run", "kody", "--json"]);
    const r = await cli(["run", "kody", "--port", "8787", "--json"]);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout || r.stderr).error.code).toBe("port-local-only");
  });

  it("POST /agents/run refuses port 80", async () => {
    const daemon = await start();
    for (const port of [80, 70000, 8787.5, "8787"]) {
      const ran = await call(daemon, "POST", "/agents/run", body({ port }));
      expect(ran.status).toBe(400);
      expect(ran.body).toMatchObject({
        error: {
          code: "bad-request",
          message: "port must be an integer from 1024 to 65535",
        },
      });
    }
    expect(starts()).toHaveLength(0);
  });

  it("warns when the daemon ignores --port", async () => {
    const port = await listen(false);
    const out = { stdout: "", stderr: "" };
    const io = {
      ...quietIo({ cwd: s.root, home: s.home, env: SECRETS }),
      stdout: { write: (t: string) => ((out.stdout += t), true) },
      stderr: { write: (t: string) => ((out.stderr += t), true) },
      agents: {
        list: async () => [],
        stop: async () => ({ stopped: false }),
        run: async () => ({
          already: false,
          agent: {
            name: "kody",
            project: s.repo,
            url: `http://127.0.0.1:${port === 61131 ? 61132 : 61131}/`,
            startedAt: new Date().toISOString(),
            token: "t",
          },
        }),
      },
    };
    const code = await run(io, "kody", { project: s.repo, port });
    expect(code).toBe(0);
    expect(out.stderr).toContain(
      "warning: the daemon ignored --port (it runs an older donn); run donn daemon install again",
    );
  });

  it("says the port is kept on a daemon run that picked one", async () => {
    await start();
    const r = await cli(["run", "kody"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(keptNote((await stored())!, "kody"));
    await cli(["stop", "kody"]);
    const again = await cli(["run", "kody"]);
    expect(again.stdout).not.toContain("is kept for");
  });
});
