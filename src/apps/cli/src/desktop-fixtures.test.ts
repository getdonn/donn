import { writeBuild } from "@getdonn/executor";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareBuild } from "./build.js";
import { cliVersion } from "./commands/daemon.js";
import { createContext } from "./context.js";
import { daemonRequest, type DaemonStatus } from "./daemon/client.js";
import { startDaemon, type Daemon } from "./daemon/server.js";
import { selectPersona } from "./select.js";
import { buildHash, createSession } from "./session.js";
import { recordCreated } from "./agent/registry.js";
import {
  agentProbe,
  AGENT_PERSONA,
  agentProject,
  installingEve,
  SECRETS,
  START_LINES,
} from "./test/created-agent.js";
import { fakeEve } from "./test/fake-eve.js";
import {
  installedProbe,
  NO_USER_HOME,
  quietIo,
  seed,
  zz,
  type Seeded,
} from "./test/seed.js";

// The tray's input (docs/planning/28-desktop.md section 2): real `donn status --json` and
// `donn list --json` output, normalised, for the shell's Rust tests to parse. With
// DONN_UPDATE_FIXTURES=1 the files are written; otherwise they are compared exactly.

const FIXTURES = join(
  import.meta.dirname,
  "../../desktop/src-tauri/tests/fixtures",
);
const UPDATE = process.env.DONN_UPDATE_FIXTURES === "1";

let s: Seeded;
let daemons: Daemon[];
let children: ChildProcess[];
beforeEach(() => {
  s = seed();
  daemons = [];
  children = [];
});
afterEach(async () => {
  await Promise.all(daemons.map((d) => d.close()));
  for (const child of children) child.kill("SIGKILL");
  s.cleanup();
});

/** A process that stays alive until killed: a session's launcher. */
function owner(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"], {
    stdio: "ignore",
  });
  children.push(child);
  return child.pid!;
}

async function start(extra: Partial<Parameters<typeof startDaemon>[0]> = {}) {
  const daemon = await startDaemon({
    home: s.home,
    env: { VITEST: "true", NODE_ENV: "test", EVE_DEV: "1" },
    version: cliVersion(),
    debounceMs: 50,
    pollMs: 50,
    probe: installedProbe,
    passwdHome: () => NO_USER_HOME,
    ...extra,
  });
  daemons.push(daemon);
  return daemon;
}

/** A session record as `donn claude` writes it, owned by a live process. */
function fakeSession(project: string, persona = "team/payments") {
  const dir = join(
    s.home,
    "sessions",
    `s${readdirSafe(join(s.home, "sessions")).length}`,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "launched.json"),
    JSON.stringify({
      persona,
      source: "switch",
      pid: owner(),
      project,
      startedAt: "2026-10-21T00:00:00.000Z",
    }),
  );
}
const readdirSafe = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

/** A session compiled and launched for real, so an edit can make it stale. */
let launches = 0;
async function launch(
  project: string,
  /** What the session records as its project, when that is not the folder. */
  recorded = project,
): Promise<void> {
  // Distinct start times, so the daemon's session order is not left to the random folder names.
  const startedAt = new Date(Date.UTC(2026, 9, 21, 0, 0, launches++));
  const io = quietIo({ cwd: project, home: s.home });
  const ctx = await createContext(io);
  const build = await prepareBuild(ctx, io, {
    selection: await selectPersona("project/persona", ctx),
    harness: "claude-code",
    overlay: true,
    passthrough: [],
  });
  await writeBuild(build.output, {
    buildDir: build.buildDir,
    store: ctx.store,
  });
  await createSession(
    s.home,
    join(build.buildDir, "plugin"),
    {
      persona: "project/persona",
      source: "argument",
      overlay: true,
      harness: "claude-code",
      project: recorded,
      startedAt: startedAt.toISOString(),
      buildHash: buildHash(build.output),
      snapshot: {
        mcp: build.result.ir.mcp,
        permissions: build.result.ir.permissions,
        settings: build.result.ir.targets["claude-code"] ?? {},
      },
    },
    owner(),
  );
}

async function json(argv: string[]): Promise<unknown> {
  const r = await zz(argv, { cwd: s.root, home: s.home });
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout);
}

/**
 * Makes the output the same on every run: paths under the temp root become `/fixture`, session
 * folders `s0`, `s1`, ..., and times, pids and the version fixed values.
 */
function normalise(value: unknown): unknown {
  const roots = [realpathSync(s.root), s.root];
  const text = JSON.stringify(value, (key, v: unknown) => {
    if (key === "pid" && typeof v === "number") return 4242;
    if (key === "version" && v === cliVersion()) return "0.0.0";
    if (["startedAt", "at"].includes(key) && typeof v === "string")
      return "2026-10-26T00:00:00.000Z";
    return v;
  });
  let out = text;
  for (const root of roots) out = out.split(root).join("/fixture");
  for (const tmp of [realpathSync(tmpdir()), tmpdir()])
    out = out.split(tmp).join("/tmp");
  // Session folders are random: number them by project, then launched persona.
  const rows = (value as { sessions?: SessionRow[] }).sessions ?? [];
  [...rows]
    .sort((x, y) => rank(x).localeCompare(rank(y)))
    .forEach((row, i) => {
      for (const root of roots)
        out = out
          .split(row.dir.split(root).join("/fixture"))
          .join(`/fixture/home/sessions/@${i}`);
    });
  const normal = JSON.parse(
    out.replace(/sessions\/@(\d+)/g, "sessions/s$1"),
  ) as { sessions?: SessionRow[]; watching?: string[] };
  // The daemon lists sessions by their random folder: order them by what they are.
  normal.sessions?.sort((x, y) => rank(x).localeCompare(rank(y)));
  // The watched folders follow the session order: sort them too.
  normal.watching?.sort();
  return normal;
}

interface SessionRow {
  dir: string;
  project?: string;
  launched: string;
  harness: string;
}
const rank = (r: SessionRow) => `${r.project ?? ""}|${r.harness}|${r.launched}`;

function check(name: string, value: unknown): void {
  const file = join(FIXTURES, name);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (UPDATE) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return;
  }
  const stale = (detail: string) => {
    throw new Error(
      `${name}: fixtures are stale; run with DONN_UPDATE_FIXTURES=1\n${detail}`,
    );
  };
  if (!existsSync(file)) stale(`${file} does not exist`);
  const old = readFileSync(file, "utf8");
  if (old !== text) stale(firstDifference(old, text));
}

/** The first line where the fixture and the new output part. */
function firstDifference(old: string, now: string): string {
  const a = old.split("\n");
  const b = now.split("\n");
  const i = a.findIndex((line, n) => line !== b[n]);
  const at = i === -1 ? a.length : i;
  return `line ${at + 1}:\n- ${a[at] ?? "(end of file)"}\n+ ${b[at] ?? "(end of file)"}`;
}

const call = (daemon: Daemon, method: string, path: string, body?: unknown) =>
  daemonRequest(daemon.socket, daemon.token, method, path, 30_000, body);

describe("the desktop shell's fixtures", () => {
  it("no-daemon.json: sessions from the registry, no daemon", async () => {
    fakeSession(s.repo);
    fakeSession(join(s.root, "other"), "org/base");
    check("no-daemon.json", normalise(await json(["status", "--json"])));
  });

  it("two-projects.json: two projects, one stale, a default and a project switch", async () => {
    const other = join(s.root, "repo2");
    cpSyncRepo(other);
    await launch(s.repo);
    await launch(other);
    for (const [argv, cwd] of [
      [["switch", "org/base", "--default"], s.root],
      [["switch", "team/payments"], s.repo],
    ] as const) {
      const r = await zz([...argv], { cwd, home: s.home });
      expect(r.code, r.stderr).toBe(0);
    }
    const daemon = await start();
    // A permissions change cannot be swapped in live: the session goes stale.
    const persona = join(s.repo, ".donn/persona.yaml");
    const text = readFileSync(persona, "utf8");
    const edited = text.replace(
      '    - "Bash(pnpm sim:*)"',
      '    - "Bash(pnpm sim:*)"\n    - "Bash(pnpm lint:*)"',
    );
    expect(edited).not.toBe(text);
    await vi.waitFor(
      async () => {
        writeFileSync(persona, edited);
        const status = (await call(daemon, "GET", "/status"))
          .body as DaemonStatus;
        expect(status.sessions.map((x) => x.state).sort()).toEqual([
          "current",
          "stale",
        ]);
      },
      { timeout: 10_000, interval: 300 },
    );
    check("two-projects.json", normalise(await json(["status", "--json"])));
  });

  it("agents.json: one agent per state, and a failed sync", async () => {
    agentProject(s);
    const put = (path: string, text: string) => {
      mkdirSync(dirname(join(s.repo, path)), { recursive: true });
      writeFileSync(join(s.repo, path), text);
    };
    const define = (name: string, target = "local") =>
      `    ${name}:\n      template: ./templates/kody\n      target: ${target}\n`;
    const persona = AGENT_PERSONA("local").replace(
      /agents:\n {2}define:\n[\s\S]*?(?=targets:)/,
      `agents:\n  define:\n${["alpha", "bravo", "delta", "echo"].map((n) => define(n)).join("")}${define("charlie", "self-host")}`,
    );
    put(".donn/persona.yaml", persona);
    const create = (name: string) =>
      zz(["agent", "create", name, "--project", s.repo], {
        cwd: s.root,
        home: s.home,
        env: SECRETS,
        probe: agentProbe(),
        spawn: installingEve(),
      }).then((r) => expect(r.code, r.stderr).toBe(0));
    for (const name of ["alpha", "bravo", "charlie", "delta", "echo"])
      await create(name);
    // built: charlie's image inputs exist.
    const building = fakeEve({
      replies: [
        {
          eve: ["build"],
          lines: ["built"],
          effect: (c) => {
            mkdirSync(join(c.cwd, ".output/server"), { recursive: true });
            writeFileSync(join(c.cwd, ".output/server/index.mjs"), "//\n");
            mkdirSync(join(c.cwd, ".output/.eve/compile"), { recursive: true });
            writeFileSync(
              join(
                c.cwd,
                ".output/.eve/compile/sandbox-prepared-artifacts.json",
              ),
              JSON.stringify({
                entries: [
                  {
                    artifact: { imageReference: "eve-sandbox-template:abc123" },
                    nodeId: "__root__",
                    providerName: "docker",
                  },
                ],
                kind: "eve-sandbox-prepared-artifacts",
                version: 2,
              }),
            );
          },
        },
      ],
    });
    const built = await zz(["agent", "build", "charlie", "--project", s.repo], {
      cwd: s.root,
      home: s.home,
      env: SECRETS,
      probe: agentProbe(),
      spawn: building,
    });
    expect(built.code, built.stderr).toBe(0);
    // deployed: delta is linked to a Vercel project.
    put("agents/delta/.vercel/project.json", '{"projectId":"p","orgId":"o"}\n');
    // unknown: an agent whose project is gone.
    await recordCreated(s.home, {
      project: join(s.root, "gone"),
      name: "foxtrot",
    });
    const spawnEve = fakeEve({
      replies: [
        { eve: ["build"], lines: ["built"] },
        { eve: ["start"], lines: START_LINES(), hold: true },
      ],
    });
    const daemon = await start({
      probe: agentProbe(["running", "exited"]),
      spawn: spawnEve,
      env: { ...SECRETS, VITEST: "true", NODE_ENV: "test", EVE_DEV: "1" },
    });
    const ran = await call(daemon, "POST", "/agents/run", {
      project: s.repo,
      name: "bravo",
    });
    expect(ran.status).toBe(200);
    // echo's owned file was edited: the next sync of it stops.
    writeFileSync(
      join(s.repo, "agents/echo/agent/lib/donn/config.ts"),
      "// mine\n",
    );
    const file = join(s.repo, ".donn/persona.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "Checkout overview.",
        "Checkout overview v2.",
      ),
    );
    let out: unknown;
    await vi.waitFor(
      async () => {
        out = normalise(await json(["status", "--json"]));
        const agents = (out as { agents: Record<string, unknown>[] }).agents;
        expect(agents.find((a) => a.name === "echo")).toHaveProperty(
          "syncFailed",
        );
        expect(agents.find((a) => a.name === "bravo")).toHaveProperty("url");
      },
      { timeout: 15_000, interval: 200 },
    );
    check("agents.json", out);
  }, 40_000);

  it("same-name.json: two projects called api", async () => {
    for (const dir of ["a", "b"]) {
      const root = join(s.root, dir, "api");
      cpSyncRepo(root);
      await launch(root, join(root, ".donn"));
    }
    await start();
    check("same-name.json", normalise(await json(["status", "--json"])));
  });

  it("personas.json: donn list --json", async () => {
    check("personas.json", normalise(await json(["list", "--json"])));
  });
});

function cpSyncRepo(to: string): void {
  mkdirSync(join(to, ".donn"), { recursive: true });
  writeFileSync(
    join(to, ".donn/persona.yaml"),
    readFileSync(join(s.repo, ".donn/persona.yaml")),
  );
  for (const file of ["instructions/checkout-overview.md", "hooks/format.sh"]) {
    mkdirSync(dirname(join(to, ".donn", file)), { recursive: true });
    writeFileSync(
      join(to, ".donn", file),
      readFileSync(join(s.repo, ".donn", file)),
    );
  }
}
