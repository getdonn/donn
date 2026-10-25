import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentLogPath } from "./agent/run.js";
import { cliVersion } from "./commands/daemon.js";
import {
  connectDaemon,
  daemonRequest,
  type DaemonEvent,
} from "./daemon/client.js";
import { allowedRun } from "./daemon/run.js";
import { startDaemon, type Daemon } from "./daemon/server.js";
import {
  agentProbe,
  agentProject,
  createAgent,
  installingEve,
  SECRETS,
  START_LINES,
} from "./test/created-agent.js";
import { fakeEve, type FakeEve } from "./test/fake-eve.js";
import { NO_USER_HOME, seed, zz, type Seeded } from "./test/seed.js";

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
  probe = agentProbe(["sbx1"]);
});
afterEach(async () => {
  unfollow?.();
  unfollow = undefined;
  await Promise.all(daemons.map((d) => d.close()));
  s.cleanup();
});

async function start(env: NodeJS.ProcessEnv = SECRETS) {
  const daemon = await startDaemon({
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

const cli = (argv: string[], cliSpawn: FakeEve = fakeEve()) =>
  zz(["agent", ...argv, "--project", s.repo], {
    cwd: s.root,
    home: s.home,
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
    });
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(probe.dockerCalls).toEqual([
      ["ps", "-q", "--filter", "name=eve-sbx-"],
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
    expect(events[1]).toMatchObject({ name: "kody", leftovers: 1 });
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
  });
});

describe("donn agent run|stop|list and status through the daemon", () => {
  it("runs through the daemon, shows it running, and stops it", async () => {
    await start();
    const cliSpawn = fakeEve();
    const ran = await cli(["run", "kody", "--json"], cliSpawn);
    expect(ran.stderr).toBe("");
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
    expect(stopped.stdout).toContain("1 eve-sbx- sandbox container");
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
    });
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
