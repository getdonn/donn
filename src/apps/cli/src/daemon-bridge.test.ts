import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordCreated } from "./agent/registry.js";
import type { Opener } from "./daemon/bridge-open.js";
import { openBridge, type Bridge } from "./daemon/bridge.js";
import { daemonRequest } from "./daemon/client.js";
import { createJobs, type JobEvent } from "./daemon/jobs.js";
import { allowedRun, runInProcess, type RunResult } from "./daemon/run.js";
import { startDaemon, type Daemon } from "./daemon/server.js";
import { uiAllowed } from "./daemon/ui-allow.js";
import { createSession } from "./session.js";
import { installedProbe, quietIo, seed, zz, type Seeded } from "./test/seed.js";

// The loopback bridge for the local web UI: Host/Origin checks, the one-time code and the UI
// token, the UI allowlist, known projects, static files and the idle close.
// See docs/planning/26-gui.md §1–§2.

let s: Seeded;
let daemons: Daemon[];
let bridges: Bridge[];
let followed: (() => void)[];
beforeEach(() => {
  s = seed();
  daemons = [];
  bridges = [];
  followed = [];
});
afterEach(async () => {
  for (const stop of followed) stop();
  await Promise.all([
    ...bridges.map((b) => b.close()),
    ...daemons.map((d) => d.close()),
  ]);
  s.cleanup();
});

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** The projects the UI picked (`~/.donn/ui.json`). */
const pick = (...projects: string[]) =>
  put(join(s.home, "ui.json"), JSON.stringify({ projects }));

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  body: unknown;
}

/** One request to the bridge, with explicit Host and Origin (fetch cannot set Host). */
function call(
  port: number,
  method: string,
  path: string,
  options: {
    host?: string;
    origin?: string;
    token?: string;
    body?: unknown;
  } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        agent: false,
        headers: {
          host: options.host ?? `127.0.0.1:${port}`,
          ...(options.origin !== undefined && { origin: options.origin }),
          ...(options.token !== undefined && {
            authorization: `Bearer ${options.token}`,
          }),
          ...(options.body !== undefined && {
            "content-type": "application/json",
          }),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = undefined;
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            body,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(
      options.body === undefined
        ? undefined
        : typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body),
    );
  });
}

const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'";

function secured(answer: Answer) {
  expect(answer.headers["content-security-policy"]).toBe(CSP);
  expect(answer.headers["x-content-type-options"]).toBe("nosniff");
  expect(answer.headers["referrer-policy"]).toBe("no-referrer");
  expect(answer.headers["x-frame-options"]).toBe("DENY");
}

interface Spy {
  calls: { argv: string[]; cwd: string }[];
  run: typeof runInProcess;
}

/** The real in-process CLI, recording each call. */
function spy(): Spy {
  const calls: Spy["calls"] = [];
  return {
    calls,
    run: (io, argv, cwd, lines) => {
      calls.push({ argv, cwd });
      return runInProcess(io, argv, cwd, lines);
    },
  };
}

async function bridge(
  options: Partial<Parameters<typeof openBridge>[0]> = {},
): Promise<{ bridge: Bridge; spy: Spy }> {
  const recorder = spy();
  const opened = await openBridge({
    home: s.home,
    io: {
      ...quietIo({ cwd: s.repo, home: s.home }),
      env: { DONN_HOME: s.home, HOME: s.home },
    },
    runInProcess: recorder.run,
    uiDir: join(s.root, "no-ui"),
    ...options,
  });
  bridges.push(opened);
  return { bridge: opened, spy: recorder };
}

/** A UI token, from a fresh code. */
async function session(b: Bridge): Promise<string> {
  const res = await call(b.port, "POST", "/v1/session", {
    body: { code: b.code() },
  });
  expect(res.status).toBe(200);
  return (res.body as { token: string }).token;
}

async function startTestDaemon(
  now?: () => number,
  timing?: Parameters<typeof startDaemon>[0]["bridge"],
) {
  const daemon = await startDaemon({
    home: s.home,
    env: {},
    version: "9.9.9",
    debounceMs: 50,
    probe: installedProbe,
    ...(now && { now }),
    ...(timing && { bridge: timing }),
  });
  daemons.push(daemon);
  return daemon;
}

/**
 * Sends `bytes` of body to `path` and never ends the request. Settles once the bridge closes
 * the connection: with its answer's status, or how the connection ended. A bridge that drained
 * the body would never close it.
 */
function endless(
  port: number,
  path: string,
  bytes: number,
  token?: string,
): Promise<number | string> {
  return new Promise((resolve) => {
    let outcome: number | string = "closed";
    const req = request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path,
      agent: false,
      headers: {
        host: `127.0.0.1:${port}`,
        "content-type": "application/json",
        "transfer-encoding": "chunked",
        ...(token !== undefined && { authorization: `Bearer ${token}` }),
      },
    });
    req.on("response", (res) => {
      outcome = res.statusCode ?? 0;
      res.resume();
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (outcome === "closed") outcome = error.code ?? "error";
    });
    req.on("close", () => resolve(outcome));
    req.write("x".repeat(bytes));
  });
}

const uiOpen = (daemon: Daemon, body?: unknown) =>
  daemonRequest(
    daemon.socket,
    daemon.token,
    "POST",
    "/ui/open",
    10_000,
    body ?? {},
  );

describe("uiAllowed", () => {
  it("accepts the UI's forms, each with --json", () => {
    for (const argv of [
      ["list", "--json"],
      ["switch", "--json"],
      ["switch", "team/payments", "--json"],
      ["switch", "team/payments", "--default", "--json"],
      ["switch", "--clear", "--json"],
      ["switch", "--clear", "--default", "--json"],
      ["resolve", "--json"],
      ["resolve", "team/payments", "--explain", "--json"],
      ["resolve", "--json", "--no-overlay", "--local"],
      ["compile", "--json", "--dry-run", "--harness", "codex"],
      ["compile", "team/payments", "--json"],
      ["capabilities", "--json"],
      ["capabilities", "--harness", "codex", "--detect", "--json"],
      ["diff", "team/payments", "--json"],
      ["diff", "org/base", "team/payments", "--local", "--json"],
      ["status", "--json"],
      ["doctor", "--json"],
      ["doctor", "team/payments", "--fix", "--json"],
      ["whoami", "--json"],
      ["login", "https://registry.example", "--json"],
      ["login", "https://registry.example", "--no-browser", "--json"],
      ["logout", "--json"],
      ["pull", "--json"],
      ["publish", "team/web", "--dry-run", "--json"],
      ["publish", "team/web", "--force", "--json"],
      ["write", "--json"],
      ["write", "--check", "--harness", "agents-md", "--json"],
      ["write", "--remove", "--json"],
      ["managed", "build", "--json"],
      [
        "managed",
        "build",
        "--layer",
        "team/web",
        "--os",
        "linux",
        "--out",
        "out",
        "--from-registry",
        "--json",
      ],
      ["managed", "check", "--json"],
      ["agent", "list", "--json"],
      ["agent", "list", "--project", "/p", "--json"],
      ["agent", "create", "bot", "--template", "eve:blank", "--json"],
      [
        "agent",
        "create",
        "bot",
        "--target",
        "local",
        "--path",
        "agents/bot",
        "--eve",
        "0.83.2",
        "--dry-run",
        "--force",
        "--accept-portability",
        "--project",
        "/p",
        "--json",
      ],
      ["agent", "sync", "bot", "--dry-run", "--force", "--json"],
      ["agent", "build", "bot", "--force", "--json"],
      ["agent", "deploy", "bot", "--yes", "--json"],
      ["agent", "env", "bot", "--format", "dotenv", "--json"],
      ["agent", "run", "bot", "--json"],
      ["agent", "stop", "bot", "--json"],
      ["agent", "logs", "bot", "--json"],
    ]) {
      expect(uiAllowed(argv), argv.join(" ")).toMatchObject({ ok: true });
    }
  });

  it("names the --project and --out a command acts on", () => {
    expect(
      uiAllowed(["agent", "sync", "bot", "--project", "/p", "--json"]),
    ).toEqual({
      ok: true,
      name: "agent sync",
      project: true,
      projectDir: "/p",
    });
    expect(uiAllowed(["managed", "build", "--out", "b", "--json"])).toEqual({
      ok: true,
      name: "managed build",
      project: true,
      outDir: "b",
    });
  });

  it("says which commands need a project", () => {
    for (const command of [
      "status",
      "doctor",
      "whoami",
      "logout",
      "pull",
      "capabilities",
      "list",
    ])
      expect(uiAllowed([command, "--json"]), command).toMatchObject({
        project: false,
      });
    expect(uiAllowed(["login", "https://r", "--json"])).toMatchObject({
      project: false,
    });
    for (const argv of [
      ["resolve", "--json"],
      ["compile", "--json"],
      ["diff", "x", "--json"],
      ["write", "--json"],
      ["publish", "team/web", "--json"],
      ["switch", "--json"],
      ["managed", "check", "--json"],
      ["agent", "list", "--json"],
    ])
      expect(uiAllowed(argv), argv.join(" ")).toMatchObject({ project: true });
  });

  it("refuses everything else, naming the rule", () => {
    for (const [argv, rule] of [
      [[], /command/],
      [["--json"], /command/],
      [["nope", "--json"], /command/],
      [["list"], /--json/],
      [["agent", "list"], /--json/],
      [["list", "--json", "--json"], /twice/],
      [["list", "extra", "--json"], /argument/],
      [["agent", "exec", "x", "--", "rm"], /agent exec/],
      [["agent", "exec", "x", "--json"], /agent exec/],
      [["daemon", "stop"], /daemon/],
      [["daemon", "stop", "--json"], /daemon/],
      [["mod", "install", "--json"], /mod/],
      [["managed", "install", "dir", "--json"], /managed install/],
      [["managed", "uninstall", "--json"], /managed uninstall/],
      [["managed", "--json"], /managed/],
      [["migrate", "--json"], /migrate/],
      [["init", "--json"], /init/],
      [["live", "x", "--session", "/s", "--json"], /live/],
      [["claude", "--json"], /claude/],
      [["codex", "--json"], /codex/],
      [["switch", "--json", "--project", "/"], /switch/],
      [["switch", "--json", "--harness", "codex"], /switch/],
      [["switch", "--default", "--json"], /switch/],
      [["switch", "a", "b", "--json"], /switch/],
      [["agent", "run", "bot", "--dev", "--json"], /--dev/],
      [["agent", "logs", "bot", "--follow", "--json"], /--follow/],
      [["agent", "env", "bot", "--resolve", "--json"], /--resolve/],
      [["agent", "nope", "--json"], /agent/],
      [["agent", "--json", "list"], /agent/],
      [["agent", "run", "--json"], /argument/],
      [["agent", "run", "a", "b", "--json"], /argument/],
      [["agent", "run", "bot", "--project", "--json"], /--project/],
      [["agent", "run", "bot", "--project", "", "--json"], /--project/],
      [["agent", "run", "bot", "--project=/p", "--json"], /--project=/],
      [["login", "--json"], /argument/],
      [["login", "https://r", "--token", "--json"], /--token/],
      [["login", "https://r", "--token-stdin", "--json"], /--token-stdin/],
      [["resolve", "--json", "--help"], /--help/],
      [["resolve", "--json", "--version"], /--version/],
      [["resolve", "--json", "-V"], /-V/],
      [["resolve", "", "--json"], /empty/],
      [["resolve", "--json", "--"], /--/],
      [["compile", "--harness", "--json"], /--harness/],
      [["publish", "--json"], /argument/],
      [["diff", "--json"], /argument/],
      [["write", "--json", "--force"], /--force/],
    ] as const) {
      const verdict = uiAllowed(argv);
      expect(verdict.ok, JSON.stringify(argv)).toBe(false);
      if (!verdict.ok) expect(verdict.rule, JSON.stringify(argv)).toMatch(rule);
    }
  });

  it("leaves POST /run's allowlist as it was", () => {
    expect(allowedRun(["write", "--json"])).toBe(false);
    expect(allowedRun(["resolve", "--json"])).toBe(false);
    expect(allowedRun(["list", "--json"])).toBe(true);
  });
});

describe("the bridge", { timeout: 20_000 }, () => {
  it("listens on a free port", async () => {
    const { bridge: b } = await bridge();
    expect(b.port).toBeGreaterThan(0);
    const res = await call(b.port, "GET", "/v1/nothing");
    expect(res.status).toBe(401);
  });

  it("refuses a foreign Origin or a rebound Host before any CLI code runs, even with the token", async () => {
    pick(s.repo);
    const { bridge: b, spy: recorder } = await bridge();
    const token = await session(b);
    const body = { argv: ["list", "--json"], cwd: s.repo };
    for (const headers of [
      { origin: "https://evil.example" },
      { origin: "null" },
      { origin: `http://127.0.0.1:${b.port + 1}` },
      { origin: `https://127.0.0.1:${b.port}` },
      { host: `evil.example:${b.port}` },
      {
        host: `evil.example:${b.port}`,
        origin: `http://evil.example:${b.port}`,
      },
      { host: "127.0.0.1" },
      { host: `127.0.0.1:${b.port + 1}` },
      { host: `localhost:${b.port}`, origin: `http://127.0.0.1:${b.port}` },
    ]) {
      for (const t of [token, "guessed"]) {
        const res = await call(b.port, "POST", "/v1/run", {
          ...headers,
          token: t,
          body,
        });
        expect(res.status, JSON.stringify(headers)).toBe(403);
        expect(res.body).toMatchObject({ error: { code: "forbidden-host" } });
        secured(res);
      }
    }
    // The code exchange and the app's files are behind the same check.
    const exchange = await call(b.port, "POST", "/v1/session", {
      host: `evil.example:${b.port}`,
      body: { code: b.code() },
    });
    expect(exchange.status).toBe(403);
    const page = await call(b.port, "GET", "/", {
      origin: "https://evil.example",
    });
    expect(page.status).toBe(403);
    expect(recorder.calls).toEqual([]);
  });

  it("accepts the loopback names with a matching Origin", async () => {
    pick(s.repo);
    const { bridge: b } = await bridge();
    const token = await session(b);
    for (const headers of [
      {},
      { origin: `http://127.0.0.1:${b.port}` },
      { host: `localhost:${b.port}` },
      { host: `localhost:${b.port}`, origin: `http://localhost:${b.port}` },
    ]) {
      const res = await call(b.port, "POST", "/v1/run", {
        ...headers,
        token,
        body: { argv: ["list", "--json"], cwd: s.repo },
      });
      expect(res.status, JSON.stringify(headers)).toBe(200);
    }
  });

  it("refuses /v1 without the UI token, before routing", async () => {
    pick(s.repo);
    const daemon = await startTestDaemon();
    const opened = (await uiOpen(daemon)).body as { port: number };
    const body = { argv: ["list", "--json"], cwd: s.repo };
    for (const token of [undefined, "wrong", daemon.token]) {
      for (const [method, path] of [
        ["POST", "/v1/run"],
        ["GET", "/v1/nothing"],
      ] as const) {
        const res = await call(opened.port, method, path, {
          ...(token !== undefined && { token }),
          body,
        });
        expect(res.status, `${method} ${path} ${token}`).toBe(401);
        expect(res.body).toEqual({
          error: {
            code: "unauthorized",
            message: expect.any(String),
            details: { fix: "donn ui" },
          },
        });
        secured(res);
      }
    }
  });

  it("exchanges a one-time code for the UI token once", async () => {
    const { bridge: b } = await bridge();
    const code = b.code();
    const first = await call(b.port, "POST", "/v1/session", {
      body: { code },
    });
    expect(first.status).toBe(200);
    const { token } = first.body as { token: string };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.headers["cache-control"]).toBe("no-store");
    const again = await call(b.port, "POST", "/v1/session", { body: { code } });
    expect(again.status).toBe(401);
    expect(again.body).toMatchObject({ error: { code: "bad-code" } });
    for (const bad of [{ code: "nope" }, {}, { code: 7 }, "not json"]) {
      const res = await call(b.port, "POST", "/v1/session", { body: bad });
      expect(res.status, JSON.stringify(bad)).toBe(401);
    }
    // Another code gives the same token: one token per bridge.
    expect(await session(b)).toBe(token);
  });

  it("expires a code after 60 seconds", async () => {
    let t = 1_000_000;
    const { bridge: b } = await bridge({ now: () => t });
    const late = b.code();
    const onTime = b.code();
    t += 59_999;
    expect(
      (await call(b.port, "POST", "/v1/session", { body: { code: onTime } }))
        .status,
    ).toBe(200);
    t += 1;
    expect(
      (await call(b.port, "POST", "/v1/session", { body: { code: late } }))
        .status,
    ).toBe(401);
  });

  it("runs an allowed command in a known project, as the CLI would", async () => {
    pick(s.repo);
    const { bridge: b, spy: recorder } = await bridge();
    const token = await session(b);
    const res = await call(b.port, "POST", "/v1/run", {
      token,
      body: { argv: ["resolve", "--explain", "--json"], cwd: s.repo },
    });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    secured(res);
    const cli = await zz(["resolve", "--explain", "--json"], {
      cwd: s.repo,
      home: s.home,
      env: { HOME: s.home },
    });
    const answer = res.body as {
      exitCode: number;
      stdout: string;
      stderr: string;
    };
    expect(answer.exitCode).toBe(cli.code);
    expect(JSON.parse(answer.stdout)).toEqual(JSON.parse(cli.stdout));
    expect(recorder.calls).toEqual([
      { argv: ["resolve", "--explain", "--json"], cwd: s.repo },
    ]);
  });

  it("refuses smuggled argv with the rule, running nothing", async () => {
    pick(s.repo);
    const { bridge: b, spy: recorder } = await bridge();
    const token = await session(b);
    for (const argv of [
      ["agent", "exec", "x", "--", "rm"],
      ["daemon", "stop"],
      ["switch", "--json", "--project", "/"],
      ["list"],
      ["mod", "install", "--json"],
      ["agent", "run", "bot", "--dev", "--json"],
    ]) {
      const res = await call(b.port, "POST", "/v1/run", {
        token,
        body: { argv, cwd: s.repo },
      });
      const verdict = uiAllowed(argv);
      expect(verdict.ok).toBe(false);
      expect(res.status, JSON.stringify(argv)).toBe(403);
      expect(res.body).toEqual({
        error: {
          code: "not-allowed",
          message: expect.any(String),
          rule: verdict.ok ? undefined : verdict.rule,
        },
      });
    }
    expect(recorder.calls).toEqual([]);
  });

  it("refuses a malformed /v1/run body", async () => {
    const { bridge: b } = await bridge();
    const token = await session(b);
    for (const body of [
      "not json",
      null,
      { argv: "list", cwd: s.repo },
      { argv: ["list", "--json"], cwd: "rel" },
    ]) {
      const res = await call(b.port, "POST", "/v1/run", { token, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toMatchObject({ error: { code: "bad-request" } });
    }
    // Over 1 MiB the request is answered and cut, not read to its end.
    for (const [path, t] of [
      ["/v1/run", token],
      ["/v1/session", undefined],
    ] as const) {
      const outcome = await endless(b.port, path, 2 ** 20 + 1024, t);
      expect([413, "ECONNRESET", "EPIPE", "closed"], path).toContain(outcome);
    }
    // A body under the limit that never ends is not cut.
    let pending = true;
    void endless(b.port, "/v1/session", 1024).then(() => (pending = false));
    await new Promise((r) => setTimeout(r, 100));
    expect(pending).toBe(true);
    expect((await call(b.port, "GET", "/v1/x", { token })).status).toBe(404);
  });

  it("runs a project-independent command without a cwd, in the daemon's home", async () => {
    const { bridge: b, spy: recorder } = await bridge();
    const token = await session(b);
    const res = await call(b.port, "POST", "/v1/run", {
      token,
      body: { argv: ["whoami", "--json"] },
    });
    expect(res.status).toBe(200);
    const cli = await zz(["whoami", "--json"], {
      cwd: s.home,
      home: s.home,
      env: { HOME: s.home },
    });
    expect(JSON.parse((res.body as { stdout: string }).stdout)).toEqual(
      JSON.parse(cli.stdout),
    );
    expect(recorder.calls).toEqual([
      { argv: ["whoami", "--json"], cwd: s.home },
    ]);
    for (const argv of [
      ["status", "--json"],
      ["doctor", "--json"],
      ["logout", "--json"],
      ["capabilities", "--json"],
      ["list", "--json"],
    ]) {
      const ran = await call(b.port, "POST", "/v1/run", {
        token,
        body: { argv },
      });
      expect(ran.status, argv.join(" ")).toBe(200);
    }
    // Given, a cwd still has to be a known project.
    const given = await call(b.port, "POST", "/v1/run", {
      token,
      body: { argv: ["whoami", "--json"], cwd: s.repo },
    });
    expect(given.body).toMatchObject({ error: { code: "unknown-project" } });
  });

  it("refuses a project command without a cwd, naming the rule", async () => {
    pick(s.repo);
    const { bridge: b, spy: recorder } = await bridge();
    const token = await session(b);
    for (const argv of [
      ["resolve", "--json"],
      ["switch", "--json"],
      ["agent", "list", "--json"],
      ["managed", "check", "--json"],
    ]) {
      const res = await call(b.port, "POST", "/v1/run", {
        token,
        body: { argv },
      });
      expect(res.status, argv.join(" ")).toBe(403);
      expect(res.body).toEqual({
        error: {
          code: "not-allowed",
          message: expect.any(String),
          rule: expect.stringMatching(/acts on a project/),
        },
      });
    }
    for (const cwd of ["repo", null, 7]) {
      const res = await call(b.port, "POST", "/v1/run", {
        token,
        body: { argv: ["whoami", "--json"], cwd },
      });
      expect(res.status, String(cwd)).toBe(400);
    }
    expect(recorder.calls).toEqual([]);
  });

  it("keeps managed build --out inside a known project", async () => {
    pick(s.repo);
    const outside = mkdtempSync(join(tmpdir(), "donn-out-"));
    try {
      symlinkSync(outside, join(s.repo, "escape"));
      const { bridge: b, spy: recorder } = await bridge();
      const token = await session(b);
      const build = (out: string) =>
        call(b.port, "POST", "/v1/run", {
          token,
          body: {
            argv: ["managed", "build", "--out", out, "--json"],
            cwd: s.repo,
          },
        });
      for (const out of [
        outside,
        join(outside, "bundle"),
        "../bundle",
        "escape/bundle",
        "/tmp/bundle",
      ]) {
        const res = await build(out);
        expect(res.status, out).toBe(403);
        expect(res.body).toMatchObject({ error: { code: "outside-project" } });
      }
      expect(recorder.calls).toEqual([]);
      for (const out of ["bundle", join(s.repo, "nested/bundle")]) {
        expect((await build(out)).status, out).toBe(200);
      }
      expect(recorder.calls).toHaveLength(2);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("runs only in a project the daemon knows or the UI picked", async () => {
    const { bridge: b, spy: recorder } = await bridge();
    const token = await session(b);
    const run = (cwd: string, argv = ["list", "--json"]) =>
      call(b.port, "POST", "/v1/run", { token, body: { argv, cwd } });

    const unknown = await run(s.repo);
    expect(unknown.status).toBe(403);
    expect(unknown.body).toMatchObject({
      error: { code: "unknown-project" },
    });
    expect(recorder.calls).toEqual([]);

    // A session launched for the project.
    const plugin = join(s.root, "launched-plugin");
    put(
      join(plugin, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "donn-org--base" }),
    );
    const dir = await createSession(
      s.home,
      plugin,
      { persona: "org/base", source: "argument", project: s.repo },
      process.pid,
    );
    expect((await run(s.repo)).status).toBe(200);
    rmSync(dir, { recursive: true, force: true });
    expect((await run(s.repo)).status).toBe(403);

    // A created agent's project.
    const other = join(s.root, "other");
    mkdirSync(join(other, ".donn"), { recursive: true });
    expect((await run(other)).status).toBe(403);
    await recordCreated(s.home, { project: other, name: "bot" });
    expect((await run(other)).status).toBe(200);

    // One the UI's project picker recorded.
    pick(s.repo);
    expect((await run(s.repo)).status).toBe(200);

    // Not a folder inside one, and not --project pointing elsewhere.
    const inside = join(s.repo, ".donn");
    expect((await run(inside)).status).toBe(403);
    const elsewhere = join(s.root, "elsewhere");
    mkdirSync(elsewhere);
    const escaped = await run(s.repo, [
      "agent",
      "list",
      "--project",
      elsewhere,
      "--json",
    ]);
    expect(escaped.status).toBe(403);
    expect(escaped.body).toMatchObject({ error: { code: "unknown-project" } });
    const relative = await run(s.repo, [
      "agent",
      "list",
      "--project",
      "../other",
      "--json",
    ]);
    expect(relative.status).toBe(200);
  });

  it("serves the app's files with the security headers and an SPA fallback", async () => {
    const ui = mkdtempSync(join(tmpdir(), "donn-ui-"));
    const outside = mkdtempSync(join(tmpdir(), "donn-outside-"));
    try {
      put(join(ui, "index.html"), "<!doctype html><title>donn</title>");
      put(join(ui, "assets/app-1.js"), "console.log(1)");
      put(join(ui, "assets/app-1.css"), "body{}");
      put(join(ui, "icon.svg"), "<svg/>");
      put(join(ui, "manifest.json"), "{}");
      put(join(outside, "secret.txt"), "SECRET");
      symlinkSync(join(outside, "secret.txt"), join(ui, "link.txt"));
      symlinkSync(outside, join(ui, "linked"));
      const { bridge: b } = await bridge({ uiDir: ui });

      const root = await call(b.port, "GET", "/");
      expect(root.status).toBe(200);
      expect(root.text).toContain("<title>donn</title>");
      expect(root.headers["content-type"]).toMatch(/^text\/html/);
      expect(root.headers["cache-control"]).toBe("no-store");
      secured(root);

      for (const [path, type] of [
        ["/assets/app-1.js", /^text\/javascript/],
        ["/assets/app-1.css", /^text\/css/],
        ["/icon.svg", /^image\/svg\+xml/],
        ["/manifest.json", /^application\/json/],
      ] as const) {
        const res = await call(b.port, "GET", path);
        expect(res.status, path).toBe(200);
        expect(res.headers["content-type"], path).toMatch(type);
        secured(res);
      }

      for (const path of [
        "/agents",
        "/projects/x/personas?y=1",
        "/index.html",
      ]) {
        const res = await call(b.port, "GET", path);
        expect(res.status, path).toBe(200);
        expect(res.text, path).toContain("<title>donn</title>");
        expect(res.headers["cache-control"]).toBe("no-store");
      }

      for (const path of [
        "/../../../../etc/passwd",
        "/%2e%2e/%2e%2e/etc/passwd",
        "/assets/..%2f..%2f..%2fetc%2fpasswd",
        "/link.txt",
        "/linked/secret.txt",
        "/%00",
      ]) {
        const res = await call(b.port, "GET", path);
        expect(res.text, path).not.toContain("SECRET");
        expect(res.text, path).not.toContain("root:");
        secured(res);
      }

      const post = await call(b.port, "POST", "/");
      expect(post.status).toBe(404);
      secured(post);
    } finally {
      rmSync(ui, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("answers 503 ui-not-built when the app is not built", async () => {
    const { bridge: b } = await bridge();
    for (const path of ["/", "/agents"]) {
      const res = await call(b.port, "GET", path);
      expect(res.status, path).toBe(503);
      expect(res.body).toMatchObject({ error: { code: "ui-not-built" } });
      secured(res);
    }
  });

  it("closes after 10 idle minutes, measured on the injected clock", async () => {
    let t = 0;
    const { bridge: b } = await bridge({ now: () => t, tickMs: 5 });
    const token = await session(b);
    t = 9 * 60_000;
    // A /v1 request resets the clock.
    expect((await call(b.port, "GET", "/v1/nothing", { token })).status).toBe(
      404,
    );
    t = 9 * 60_000 + 599_999;
    await new Promise((r) => setTimeout(r, 30));
    let done = false;
    void b.closed.then(() => (done = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    t = 9 * 60_000 + 600_000;
    await b.closed;
    // A stale tab gets a refused connection, not a hang.
    await expect(call(b.port, "GET", "/v1/nothing", { token })).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it("stays open while held (an open event stream)", async () => {
    let t = 0;
    const { bridge: b } = await bridge({ now: () => t, tickMs: 5 });
    const release = b.hold();
    t = 3_600_000;
    await new Promise((r) => setTimeout(r, 40));
    let done = false;
    void b.closed.then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    release();
    // Idle counts from the release.
    t += 599_999;
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    t += 1;
    await b.closed;
  });

  it("restarts the idle clock with each code handed out", async () => {
    let t = 0;
    const { bridge: b } = await bridge({ now: () => t, tickMs: 5 });
    t = 599_999;
    const code = b.code();
    t = 600_000 + 30_000;
    await new Promise((r) => setTimeout(r, 30));
    expect(b.closing).toBe(false);
    const res = await call(b.port, "POST", "/v1/session", { body: { code } });
    expect(res.status).toBe(200);
  });

  it("says it is closing the moment close starts", async () => {
    const { bridge: b } = await bridge();
    expect(b.closing).toBe(false);
    const done = b.close();
    expect(b.closing).toBe(true);
    await done;
    expect(b.closing).toBe(true);
  });

  it("does not count an unauthenticated request as activity", async () => {
    let t = 0;
    const { bridge: b } = await bridge({ now: () => t, tickMs: 5 });
    t = 599_000;
    await call(b.port, "GET", "/v1/nothing", { token: "wrong" });
    t = 600_000;
    await b.closed;
  });
});

describe("POST /ui/open", { timeout: 20_000 }, () => {
  it("opens the bridge and gives a new code each time for the same bridge", async () => {
    const daemon = await startTestDaemon();
    const first = await uiOpen(daemon);
    expect(first.status).toBe(200);
    const a = first.body as { port: number; code: string };
    expect(a.port).toBeGreaterThan(0);
    expect(a.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const b = (await uiOpen(daemon)).body as { port: number; code: string };
    expect(b.port).toBe(a.port);
    expect(b.code).not.toBe(a.code);
    for (const code of [a.code, b.code]) {
      const res = await call(a.port, "POST", "/v1/session", { body: { code } });
      expect(res.status).toBe(200);
    }
  });

  it("opens a fresh bridge rather than hand out a code for a closing one", async () => {
    let t = 0;
    const daemon = await startTestDaemon(() => t, { tickMs: 5 });
    const first = (await uiOpen(daemon)).body as { port: number };
    // An unfinished request keeps the closing bridge from closing at once (its grace period).
    void endless(first.port, "/v1/session", 16);
    await new Promise((r) => setTimeout(r, 30));
    t = 600_000;
    await new Promise((r) => setTimeout(r, 30));
    const second = (await uiOpen(daemon)).body as {
      port: number;
      code: string;
    };
    expect(second.port).not.toBe(first.port);
    const res = await call(second.port, "POST", "/v1/session", {
      body: { code: second.code },
    });
    expect(res.status).toBe(200);
  });

  it("leaves no bridge listening when an open races shutdown", async () => {
    for (const delay of [0, 1, 2, 5]) {
      const daemon = await startTestDaemon();
      const opened = uiOpen(daemon).catch(() => undefined);
      await new Promise((r) => setTimeout(r, delay));
      await daemon.close();
      const answer = await opened;
      if (answer?.status === 200) {
        const { port } = answer.body as { port: number };
        await expect(call(port, "GET", "/v1/x")).rejects.toThrow(
          /ECONNREFUSED/,
        );
      } else if (answer !== undefined) {
        expect(answer.body).toMatchObject({ error: { code: "stopping" } });
      }
    }
  });

  it("answers 403 ui-disabled when daemon.ui is false", async () => {
    put(
      join(s.home, "config.yaml"),
      `personas: ${s.personas}\ndaemon:\n  ui: false\n`,
    );
    const daemon = await startTestDaemon();
    const res = await uiOpen(daemon);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "ui-disabled" } });
  });

  it("refuses a bad port", async () => {
    const daemon = await startTestDaemon();
    for (const body of [{ port: "80" }, { port: -1 }, { port: 70_000 }, []]) {
      const res = await uiOpen(daemon, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("listens on the port asked for", async () => {
    const free = await bridge();
    const port = free.bridge.port;
    await free.bridge.close();
    const daemon = await startTestDaemon();
    const res = await uiOpen(daemon, { port });
    expect(res.body).toMatchObject({ port });
  });

  it("runs the CLI with the daemon's home and the same handler as /run", async () => {
    pick(s.repo);
    const daemon = await startTestDaemon();
    const { port, code } = (await uiOpen(daemon)).body as {
      port: number;
      code: string;
    };
    const { token } = (
      await call(port, "POST", "/v1/session", { body: { code } })
    ).body as { token: string };
    const res = await call(port, "POST", "/v1/run", {
      token,
      body: { argv: ["switch", "team/payments", "--json"], cwd: s.repo },
    });
    expect(res.status).toBe(200);
    expect((res.body as { exitCode: number }).exitCode).toBe(0);
    const shown = await zz(["switch", "--json"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(JSON.parse(shown.stdout)).toMatchObject({
      persona: "team/payments",
    });
  });

  it("rotates the UI token when the bridge reopens, and closes it with the daemon", async () => {
    const daemon = await startTestDaemon();
    const first = (await uiOpen(daemon)).body as { port: number; code: string };
    const old = (
      await call(first.port, "POST", "/v1/session", {
        body: { code: first.code },
      })
    ).body as { token: string };
    await daemon.close();
    await expect(call(first.port, "GET", "/v1/nothing")).rejects.toThrow(
      /ECONNREFUSED/,
    );
    const again = await startTestDaemon();
    const second = (await uiOpen(again)).body as { port: number; code: string };
    const fresh = (
      await call(second.port, "POST", "/v1/session", {
        body: { code: second.code },
      })
    ).body as { token: string };
    expect(fresh.token).not.toBe(old.token);
    const stale = await call(second.port, "GET", "/v1/nothing", {
      token: old.token,
    });
    expect(stale.status).toBe(401);
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The daemon's io for a bridge, with `env` added (an editor, say). */
const ioWith = (env: NodeJS.ProcessEnv = {}) => ({
  ...quietIo({ cwd: s.repo, home: s.home }),
  env: { DONN_HOME: s.home, HOME: s.home, ...env },
});

interface Followed {
  status: Promise<number>;
  headers: Promise<Record<string, string | string[] | undefined>>;
  raw: () => string;
  /** The events received so far, in order. */
  events: () => { type: string; [key: string]: unknown }[];
  ended: Promise<void>;
  stop(): void;
}

/** Follow the bridge's `GET /v1/events` as the app does: a request with the token header. */
function follow(port: number, token?: string): Followed {
  let raw = "";
  let markEnded!: () => void;
  const ended = new Promise<void>((r) => (markEnded = r));
  let answered!: (res: import("node:http").IncomingMessage) => void;
  const response = new Promise<import("node:http").IncomingMessage>(
    (r) => (answered = r),
  );
  const req = request(
    {
      host: "127.0.0.1",
      port,
      method: "GET",
      path: "/v1/events",
      agent: false,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(token !== undefined && { authorization: `Bearer ${token}` }),
      },
    },
    (res) => {
      answered(res);
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (raw += chunk));
      res.on("close", markEnded);
    },
  );
  req.on("error", () => markEnded());
  req.end();
  const stop = () => req.destroy();
  followed.push(stop);
  return {
    status: response.then((r) => r.statusCode ?? 0),
    headers: response.then((r) => r.headers),
    raw: () => raw,
    events: () =>
      raw
        .split("\n\n")
        .slice(0, -1)
        .flatMap((block) => {
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          return data ? [JSON.parse(data) as { type: string }] : [];
        }),
    ended,
    stop,
  };
}

/** A stand-in for the in-process CLI: prints `lines` to stderr, answers as told, records calls. */
function scripted(
  answer: (
    argv: string[],
  ) => Partial<Omit<RunResult, "stderr">> & { lines?: string[] } = () => ({}),
  gate?: () => Promise<void>,
) {
  const calls: { argv: string[]; cwd: string }[] = [];
  const run: typeof runInProcess = async (_io, argv, cwd, lines) => {
    calls.push({ argv, cwd });
    await gate?.();
    const a = answer(argv);
    for (const line of a.lines ?? []) lines?.onStderr?.(line);
    return {
      exitCode: a.exitCode ?? 0,
      stdout: a.stdout ?? "{}\n",
      stderr: (a.lines ?? []).map((line) => `${line}\n`).join(""),
    };
  };
  return { calls, run };
}

/** A gate that holds every run until opened. */
function gated() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, wait: () => opened };
}

/** A recording opener: the command and arguments it would have spawned. */
function recorder(fail?: Error) {
  const calls: { command: string; args: string[] }[] = [];
  const open: Opener = async (command, args) => {
    calls.push({ command, args });
    if (fail) throw fail;
  };
  return { calls, open };
}

const jobOf = async (port: number, token: string, id: string) =>
  (await call(port, "GET", `/v1/jobs/${id}`, { token })).body as {
    state: string;
    [key: string]: unknown;
  };

describe("runInProcess", () => {
  it("hands each line to the callbacks as printed, keeping what it captures", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const listed = await runInProcess(ioWith(), ["list", "--json"], s.repo, {
      onStdout: (line) => out.push(line),
      onStderr: (line) => err.push(line),
    });
    expect(listed.exitCode).toBe(0);
    expect(out.length).toBeGreaterThan(0);
    expect(`${out.join("\n")}\n`).toBe(listed.stdout);
    const failed = await runInProcess(
      ioWith(),
      ["resolve", "no/such"],
      s.repo,
      {
        onStderr: (line) => err.push(line),
      },
    );
    expect(failed.exitCode).not.toBe(0);
    expect(err.length).toBeGreaterThan(0);
    expect(err.join("\n")).toBe(failed.stderr.replace(/\n$/, ""));
  });
});

describe("jobs", { timeout: 20_000 }, () => {
  it("streams a job's stderr lines as progress, then done with its JSON result", async () => {
    const fake = scripted(() => ({
      lines: ["fetching layers", "wrote 3 files"],
      stdout: '{"ok":true}\n',
    }));
    const { bridge: b } = await bridge({ runInProcess: fake.run });
    const token = await session(b);
    const stream = follow(b.port, token);
    expect(await stream.status).toBe(200);
    const res = await call(b.port, "POST", "/v1/jobs", {
      token,
      body: { argv: ["pull", "--json"] },
    });
    expect(res.status).toBe(202);
    secured(res);
    const { id } = res.body as { id: string };
    expect(id).toMatch(UUID);
    await vi.waitFor(() =>
      expect(stream.events().map((e) => e.type)).toContain("job.done"),
    );
    expect(stream.events()).toEqual([
      { type: "job.progress", id, line: "fetching layers" },
      { type: "job.progress", id, line: "wrote 3 files" },
      { type: "job.done", id, exitCode: 0, stdout: '{"ok":true}\n' },
    ]);
    expect(await jobOf(b.port, token, id)).toMatchObject({
      id,
      argv: ["pull", "--json"],
      state: "done",
      exitCode: 0,
      stdout: '{"ok":true}\n',
      stderr: "fetching layers\nwrote 3 files\n",
    });
    // A project-independent command, as on /v1/run: in the daemon's home.
    expect(fake.calls).toEqual([{ argv: ["pull", "--json"], cwd: s.home }]);
  });

  it("runs the CLI in a known project, as /v1/run does", async () => {
    pick(s.repo);
    const { bridge: b, spy: recorded } = await bridge();
    const token = await session(b);
    const res = await call(b.port, "POST", "/v1/jobs", {
      token,
      body: { argv: ["resolve", "--json"], cwd: s.repo },
    });
    const { id } = res.body as { id: string };
    await vi.waitFor(async () =>
      expect((await jobOf(b.port, token, id)).state).toBe("done"),
    );
    const cli = await zz(["resolve", "--json"], {
      cwd: s.repo,
      home: s.home,
      env: { HOME: s.home },
    });
    const job = await jobOf(b.port, token, id);
    expect(job.exitCode).toBe(cli.code);
    expect(JSON.parse(job.stdout as string)).toEqual(JSON.parse(cli.stdout));
    expect(recorded.calls).toEqual([
      { argv: ["resolve", "--json"], cwd: s.repo },
    ]);
  });

  it("runs up to four jobs at once: the rest wait queued", async () => {
    const gate = gated();
    const fake = scripted(undefined, gate.wait);
    const { bridge: b } = await bridge({ runInProcess: fake.run });
    const token = await session(b);
    const start = async () =>
      (
        (
          await call(b.port, "POST", "/v1/jobs", {
            token,
            body: { argv: ["whoami", "--json"] },
          })
        ).body as { id: string }
      ).id;
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await start());
    await vi.waitFor(() => expect(fake.calls).toHaveLength(4));
    const states = async () =>
      Promise.all(
        ids.map(async (id) => (await jobOf(b.port, token, id)).state),
      );
    expect(await states()).toEqual([
      "running",
      "running",
      "running",
      "running",
      "queued",
      "queued",
    ]);
    gate.open();
    await vi.waitFor(async () =>
      expect(await states()).toEqual(Array(6).fill("done")),
    );
    expect(fake.calls).toHaveLength(6);
  });

  it("cancels its queued jobs when it closes, telling the streams", async () => {
    const gate = gated();
    const fake = scripted(undefined, gate.wait);
    const { bridge: b } = await bridge({ runInProcess: fake.run });
    const token = await session(b);
    const stream = follow(b.port, token);
    await stream.status;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await call(b.port, "POST", "/v1/jobs", {
        token,
        body: { argv: ["whoami", "--json"] },
      });
      ids.push((res.body as { id: string }).id);
    }
    await vi.waitFor(() => expect(fake.calls).toHaveLength(4));
    await b.close();
    await stream.ended;
    expect(stream.events()).toEqual([
      {
        type: "job.done",
        id: ids[4],
        exitCode: null,
        stdout: "",
        cancelled: true,
      },
    ]);
    gate.open();
    await sleep(20);
    // The cancelled job never ran.
    expect(fake.calls).toHaveLength(4);
  });

  it("refuses what /v1/run refuses, starting nothing", async () => {
    const fake = scripted();
    const { bridge: b } = await bridge({ runInProcess: fake.run });
    const token = await session(b);
    const job = (body: unknown) =>
      call(b.port, "POST", "/v1/jobs", { token, body });
    const smuggled = await job({ argv: ["daemon", "stop"] });
    expect(smuggled.status).toBe(403);
    expect(smuggled.body).toMatchObject({ error: { code: "not-allowed" } });
    const projectless = await job({ argv: ["agent", "build", "x", "--json"] });
    expect(projectless.status).toBe(403);
    expect(projectless.body).toMatchObject({
      error: { code: "not-allowed", rule: expect.stringMatching(/project/) },
    });
    const unknown = await job({ argv: ["resolve", "--json"], cwd: s.repo });
    expect(unknown.status).toBe(403);
    expect(unknown.body).toMatchObject({ error: { code: "unknown-project" } });
    for (const body of ["not json", { argv: "pull" }, { argv: [], cwd: "x" }]) {
      expect((await job(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(fake.calls).toEqual([]);
  });

  it("answers 404 no-such-job for a job it does not have", async () => {
    const { bridge: b } = await bridge();
    const token = await session(b);
    for (const [method, path] of [
      ["GET", "/v1/jobs/nope"],
      ["POST", "/v1/jobs/nope/answer"],
    ] as const) {
      const res = await call(b.port, method, path, {
        token,
        body: method === "POST" ? { key: "k", value: 1 } : undefined,
      });
      expect(res.status, path).toBe(404);
      expect(res.body).toMatchObject({ error: { code: "no-such-job" } });
    }
  });

  it("holds the bridge open while a job is queued or running", async () => {
    let t = 0;
    const gate = gated();
    const fake = scripted(undefined, gate.wait);
    const { bridge: b } = await bridge({
      runInProcess: fake.run,
      now: () => t,
      tickMs: 5,
    });
    const token = await session(b);
    const res = await call(b.port, "POST", "/v1/jobs", {
      token,
      body: { argv: ["pull", "--json"] },
    });
    expect(res.status).toBe(202);
    t = 3_600_000;
    await sleep(40);
    expect(b.closing).toBe(false);
    gate.open();
    await sleep(20);
    t += 599_999;
    await sleep(30);
    expect(b.closing).toBe(false);
    t += 1;
    await b.closed;
  });

  it("turns a needs-answer result into job.question; the answer is checked like a run", async () => {
    pick(s.repo);
    const question = {
      key: "github.app",
      prompt: "Which GitHub App?",
      choices: ["donn-bot", "other"],
      secret: false,
    };
    const asked = JSON.stringify({
      status: "needs-answer",
      question,
      continue: ["agent", "create", "bot", "--json"],
    });
    const fake = scripted((argv) =>
      argv.some((a) => a.startsWith("--answer="))
        ? {}
        : argv.includes("create")
          ? { exitCode: 2, stdout: asked }
          : { exitCode: 2, stdout: '{"status":"failed"}' },
    );
    const { bridge: b } = await bridge({ runInProcess: fake.run });
    const token = await session(b);
    const stream = follow(b.port, token);
    await stream.status;
    const { id } = (
      await call(b.port, "POST", "/v1/jobs", {
        token,
        body: { argv: ["agent", "create", "bot", "--json"], cwd: s.repo },
      })
    ).body as { id: string };
    await vi.waitFor(() =>
      expect(stream.events().map((e) => e.type)).toContain("job.done"),
    );
    expect(stream.events()).toEqual([
      {
        type: "job.question",
        id,
        question,
        continue: ["agent", "create", "bot", "--json"],
      },
      { type: "job.done", id, exitCode: 2, stdout: asked },
    ]);
    expect(await jobOf(b.port, token, id)).toMatchObject({
      state: "done",
      question: { question, continue: ["agent", "create", "bot", "--json"] },
    });

    const answer = (body: unknown, job = id) =>
      call(b.port, "POST", `/v1/jobs/${job}/answer`, { token, body });
    for (const body of [
      { value: 1 },
      { key: "", value: 1 },
      { key: "k" },
      { key: "-k", value: 1 },
      { key: "--yes", value: 1 },
      { key: "a=b", value: 1 },
      { key: "a b", value: 1 },
      { key: "a..b", value: 1 },
      { key: "1a", value: 1 },
      7,
    ]) {
      expect((await answer(body)).status, JSON.stringify(body)).toBe(400);
    }
    // The continuation passes the UI allowlist again: today's has no --answer, so it is refused.
    const refused = await answer({ key: "github.app", value: "donn-bot" });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { code: "not-allowed" } });
    expect(fake.calls).toHaveLength(1);

    // An exit 2 that is not a needs-answer result asks nothing.
    const { id: plain } = (
      await call(b.port, "POST", "/v1/jobs", {
        token,
        body: { argv: ["pull", "--json"] },
      })
    ).body as { id: string };
    await vi.waitFor(async () =>
      expect((await jobOf(b.port, token, plain)).state).toBe("done"),
    );
    expect(await jobOf(b.port, token, plain)).not.toHaveProperty("question");
    const none = await answer({ key: "k", value: 1 }, plain);
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({ error: { code: "no-question" } });
  });
});

describe("createJobs", () => {
  const ok: RunResult = { exitCode: 0, stdout: "{}\n", stderr: "" };

  /** A started job, failing the test when it was refused. */
  const queued = (
    jobs: ReturnType<typeof createJobs>,
    argv: string[] = ["a"],
    cwd?: string,
    parent?: string,
  ) => {
    const job = jobs.start(argv, cwd, parent);
    if (typeof job === "string") throw new Error(`refused: ${job}`);
    return job;
  };

  it("continues a question as a new job linked to it, with --answer=<key>=<JSON>", async () => {
    const events: JobEvent[] = [];
    const runs: { argv: string[]; cwd: string | undefined }[] = [];
    const asked = JSON.stringify({
      status: "needs-answer",
      question: { key: "github.app" },
      continue: ["agent", "add", "x", "--json"],
    });
    const jobs = createJobs({
      run: async (argv, cwd) => {
        runs.push({ argv, cwd });
        return argv.some((a) => a.startsWith("--answer="))
          ? ok
          : { exitCode: 2, stdout: asked, stderr: "" };
      },
      emit: (event) => events.push(event),
    });
    const first = queued(jobs, ["agent", "add", "x", "--json"], "/p");
    await vi.waitFor(() => expect(jobs.get(first.id)?.state).toBe("done"));
    const next = jobs.continuation(first.id, "github.app", { id: 7 });
    expect(next).toEqual({
      argv: ["agent", "add", "x", "--json", '--answer=github.app={"id":7}'],
      cwd: "/p",
    });
    if (typeof next === "string") throw new Error(next);
    const second = queued(jobs, next.argv, next.cwd, first.id);
    await vi.waitFor(() => expect(jobs.get(second.id)?.state).toBe("done"));
    expect(jobs.view(second)).toMatchObject({
      parent: first.id,
      exitCode: 0,
    });
    expect(jobs.view(jobs.get(first.id)!)).toMatchObject({
      answeredBy: second.id,
    });
    expect(runs.map((r) => r.cwd)).toEqual(["/p", "/p"]);
    expect(jobs.continuation(first.id, "k", 1)).toBe("answered");
    expect(jobs.continuation(second.id, "k", 1)).toBe("no-question");
    expect(jobs.continuation("nope", "k", 1)).toBe("no-such-job");
    expect(events.filter((e) => e.type === "job.question")).toHaveLength(1);
  });

  it("asks only for an exit 2 whose stdout is a needs-answer result", async () => {
    const answers: RunResult[] = [
      {
        exitCode: 0,
        stdout: '{"status":"needs-answer","question":{},"continue":["a"]}',
        stderr: "",
      },
      { exitCode: 2, stdout: "not json", stderr: "" },
      {
        exitCode: 2,
        stdout: '{"status":"needs-answer","question":{}}',
        stderr: "",
      },
      {
        exitCode: 2,
        stdout: '{"status":"needs-answer","question":{},"continue":[1]}',
        stderr: "",
      },
      {
        exitCode: 2,
        stdout: '{"status":"needs-answer","continue":["a"]}',
        stderr: "",
      },
    ];
    const events: JobEvent[] = [];
    const jobs = createJobs({
      run: async () => answers.shift()!,
      emit: (event) => events.push(event),
    });
    const ids = Array.from({ length: 5 }, () => queued(jobs).id);
    await vi.waitFor(() =>
      expect(ids.every((id) => jobs.get(id)?.state === "done")).toBe(true),
    );
    expect(events.filter((e) => e.type === "job.question")).toEqual([]);
    expect(events.filter((e) => e.type === "job.done")).toHaveLength(5);
  });

  it("reports a run that throws as a failed job", async () => {
    const events: JobEvent[] = [];
    const jobs = createJobs({
      run: async () => {
        throw new Error("boom");
      },
      emit: (event) => events.push(event),
    });
    const job = queued(jobs);
    await vi.waitFor(() => expect(jobs.get(job.id)?.state).toBe("done"));
    expect(jobs.view(jobs.get(job.id)!)).toMatchObject({
      exitCode: 1,
      stderr: "boom",
    });
    expect(events).toEqual([
      { type: "job.done", id: job.id, exitCode: 1, stdout: "" },
    ]);
  });

  it("keeps a done job an hour, and at most 100 jobs", async () => {
    let t = 0;
    const jobs = createJobs({
      run: async () => ok,
      emit: () => undefined,
      now: () => t,
    });
    const first = queued(jobs);
    await vi.waitFor(() => expect(jobs.get(first.id)?.state).toBe("done"));
    t = 3_600_000 - 1;
    expect(jobs.get(first.id)).toBeDefined();
    t = 3_600_000;
    expect(jobs.get(first.id)).toBeUndefined();

    const ids = Array.from({ length: 100 }, () => queued(jobs).id);
    await vi.waitFor(() =>
      expect(ids.every((id) => jobs.get(id)?.state === "done")).toBe(true),
    );
    queued(jobs);
    // The oldest done job makes room.
    expect(jobs.get(ids[0]!)).toBeUndefined();
    expect(jobs.get(ids[1]!)).toBeDefined();
  });

  it("refuses a job when 100 are still queued or running", () => {
    const jobs = createJobs({
      run: () => new Promise<RunResult>(() => undefined),
      emit: () => undefined,
    });
    for (let i = 0; i < 100; i++) queued(jobs);
    expect(jobs.start(["a"], undefined)).toBe("full");
  });

  it("keeps the last 256 KiB of each output, saying it was cut", async () => {
    const events: JobEvent[] = [];
    const long = `${"x".repeat(300 * 1024)}END`;
    const asked = `${JSON.stringify({
      status: "needs-answer",
      question: { key: "k" },
      continue: ["a"],
    })}${" ".repeat(300 * 1024)}`;
    const answers: RunResult[] = [
      { exitCode: 0, stdout: long, stderr: long },
      { exitCode: 2, stdout: asked, stderr: "" },
      ok,
    ];
    const jobs = createJobs({
      run: async () => answers.shift()!,
      emit: (event) => events.push(event),
    });
    const [cut, question, whole] = [queued(jobs), queued(jobs), queued(jobs)];
    await vi.waitFor(() => expect(jobs.get(whole.id)?.state).toBe("done"));
    const view = jobs.view(jobs.get(cut.id)!) as {
      stdout: string;
      stderr: string;
      truncated?: boolean;
    };
    expect(view.truncated).toBe(true);
    expect(view.stdout).toHaveLength(256 * 1024);
    expect(view.stdout.endsWith("xEND")).toBe(true);
    expect(view.stderr).toHaveLength(256 * 1024);
    expect(events).toContainEqual({
      type: "job.done",
      id: cut.id,
      exitCode: 0,
      stdout: view.stdout,
      truncated: true,
    });
    // The question is read from the whole stdout, before it is cut.
    expect(jobs.view(jobs.get(question.id)!)).toMatchObject({
      truncated: true,
      question: { question: { key: "k" }, continue: ["a"] },
    });
    expect(jobs.view(jobs.get(whole.id)!)).not.toHaveProperty("truncated");
  });

  it("cancels the queued jobs on close, and starts none after", async () => {
    const gate = gated();
    const events: JobEvent[] = [];
    let runs = 0;
    const jobs = createJobs({
      run: async () => {
        runs++;
        await gate.wait();
        return ok;
      },
      emit: (event) => events.push(event),
      concurrency: 1,
    });
    const [first, second, third] = [queued(jobs), queued(jobs), queued(jobs)];
    jobs.close();
    expect(jobs.start(["a"], undefined)).toBe("closed");
    for (const job of [second, third]) {
      expect(jobs.view(jobs.get(job.id)!)).toMatchObject({
        state: "done",
        cancelled: true,
        exitCode: null,
      });
    }
    expect(events).toEqual([
      {
        type: "job.done",
        id: second.id,
        exitCode: null,
        stdout: "",
        cancelled: true,
      },
      {
        type: "job.done",
        id: third.id,
        exitCode: null,
        stdout: "",
        cancelled: true,
      },
    ]);
    // The running one finishes; nothing starts after it.
    gate.open();
    await vi.waitFor(() => expect(jobs.get(first.id)?.state).toBe("done"));
    expect(jobs.view(jobs.get(first.id)!)).toMatchObject({ exitCode: 0 });
    expect(runs).toBe(1);
  });
});

describe("GET /v1/events", { timeout: 20_000 }, () => {
  it("streams the daemon's events and the jobs', only with the token", async () => {
    const daemon = await startTestDaemon();
    const { port, code } = (await uiOpen(daemon)).body as {
      port: number;
      code: string;
    };
    const { token } = (
      await call(port, "POST", "/v1/session", { body: { code } })
    ).body as { token: string };
    expect(await follow(port).status).toBe(401);
    expect(await follow(port, "wrong").status).toBe(401);
    const stream = follow(port, token);
    expect(await stream.status).toBe(200);
    const headers = await stream.headers;
    expect(headers["content-type"]).toBe("text/event-stream");
    expect(headers["cache-control"]).toBe("no-store");
    expect(headers["x-content-type-options"]).toBe("nosniff");

    // A daemon event: a session it notices.
    const plugin = join(s.root, "launched-plugin");
    put(
      join(plugin, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "donn-org--base" }),
    );
    const dir = await createSession(
      s.home,
      plugin,
      { persona: "org/base", source: "argument", project: s.repo },
      process.pid,
    );
    await daemonRequest(
      daemon.socket,
      daemon.token,
      "POST",
      "/refresh",
      10_000,
    );
    await vi.waitFor(
      () =>
        expect(stream.events()).toContainEqual(
          expect.objectContaining({ type: "session.added", session: dir }),
        ),
      { timeout: 5_000 },
    );
    expect(stream.raw()).toMatch(/^event: session\.added\ndata: \{/m);

    // A job's.
    const { id } = (
      await call(port, "POST", "/v1/jobs", {
        token,
        body: { argv: ["whoami", "--json"] },
      })
    ).body as { id: string };
    await vi.waitFor(
      () =>
        expect(stream.events()).toContainEqual(
          expect.objectContaining({ type: "job.done", id, exitCode: 0 }),
        ),
      { timeout: 5_000 },
    );
    expect(stream.raw()).toMatch(/^event: job\.done\ndata: \{/m);
  });

  it("pings every 15 s and holds the bridge open while connected", async () => {
    let t = 0;
    const { bridge: b } = await bridge({ now: () => t, tickMs: 5, pingMs: 20 });
    const token = await session(b);
    const stream = follow(b.port, token);
    expect(await stream.status).toBe(200);
    await vi.waitFor(() => expect(stream.raw()).toContain("\n: ping\n\n"));
    t = 3_600_000;
    await sleep(40);
    expect(b.closing).toBe(false);
    stream.stop();
    await sleep(40);
    t += 600_000;
    await b.closed;
  });

  it("drops a stream whose reader falls 1 MiB behind", async () => {
    let t = 0;
    let emit!: (event: { type: string; [key: string]: unknown }) => void;
    const logged: string[] = [];
    const { bridge: b } = await bridge({
      now: () => t,
      tickMs: 5,
      events: (on) => {
        emit = on;
        return () => undefined;
      },
      log: (line) => logged.push(line),
    });
    const token = await session(b);
    // A reader that stops reading after the first bytes.
    const stalled = await new Promise<import("node:http").IncomingMessage>(
      (resolve) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: b.port,
            method: "GET",
            path: "/v1/events",
            agent: false,
            headers: {
              host: `127.0.0.1:${b.port}`,
              authorization: `Bearer ${token}`,
            },
          },
          (res) => {
            res.once("data", () => res.pause());
            resolve(res);
          },
        );
        req.on("error", () => undefined);
        req.end();
        followed.push(() => req.destroy());
      },
    );
    expect(stalled.statusCode).toBe(200);
    const big = "y".repeat(64 * 1024);
    for (let i = 0; i < 400 && logged.length === 0; i++) {
      emit({ type: "session.refreshed", big });
      await sleep(1);
    }
    expect(logged).toContain("ui dropped an event stream that fell behind");
    // Dropped, it no longer holds the bridge open.
    await sleep(20);
    t = 600_000;
    await b.closed;
  });

  it("ends its streams when it closes", async () => {
    const { bridge: b } = await bridge();
    const token = await session(b);
    const stream = follow(b.port, token);
    expect(await stream.status).toBe(200);
    const started = Date.now();
    await b.close();
    await stream.ended;
    // Ended, not cut after the close grace period.
    expect(Date.now() - started).toBeLessThan(900);
  });
});

describe("POST /v1/open", { timeout: 20_000 }, () => {
  /** `POST /v1/open` of each path on a bridge for `platform` with `env`; the answers. */
  async function openAll(
    paths: string[],
    options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
  ) {
    const opener = recorder();
    const { bridge: b } = await bridge({
      io: ioWith(options.env),
      opener: opener.open,
      ...(options.platform && { platform: options.platform }),
    });
    const token = await session(b);
    const answers: Answer[] = [];
    for (const path of paths) {
      answers.push(
        await call(b.port, "POST", "/v1/open", { token, body: { path } }),
      );
    }
    return { answers, calls: opener.calls };
  }

  it("opens with $VISUAL as given, never $EDITOR, else the OS opener", async () => {
    const file = join(s.personas, "org/instructions/conduct.md");
    const real = realpathSync(file);
    for (const [env, command, args] of [
      [{ VISUAL: "code --wait", EDITOR: "vim" }, "code", ["--wait", real]],
      [{ VISUAL: "  zed   -n " }, "zed", ["-n", real]],
      [{ EDITOR: "vim" }, "open", ["-t", real]],
      [{ VISUAL: " ", EDITOR: "nano" }, "open", ["-t", real]],
    ] as const) {
      const { answers, calls } = await openAll([file], {
        env,
        platform: "darwin",
      });
      expect(answers[0]!.status, JSON.stringify(env)).toBe(200);
      secured(answers[0]!);
      expect(answers[0]!.body).toEqual({ opened: real });
      expect(calls).toEqual([{ command, args: [...args] }]);
    }
  });

  it("on macOS opens a file as text and reveals a folder, so nothing launches", async () => {
    const app = join(s.personas, "org/Foo.app");
    const script = join(s.personas, "org/run.command");
    const link = join(s.personas, "org/site.webloc");
    put(join(app, "Contents/MacOS/Foo"), "#!/bin/sh\n");
    put(script, "#!/bin/sh\necho hi\n");
    put(link, "<plist/>\n");
    chmodSync(script, 0o755);
    const folder = join(s.personas, "org");
    const { answers, calls } = await openAll([app, script, link, folder], {
      platform: "darwin",
    });
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200]);
    expect(calls).toEqual([
      { command: "open", args: ["-R", realpathSync(app)] },
      { command: "open", args: ["-t", realpathSync(script)] },
      { command: "open", args: ["-t", realpathSync(link)] },
      { command: "open", args: ["-R", realpathSync(folder)] },
    ]);
    // Never a bare `open <path>`, which would launch the app, run the script, follow the link.
    expect(calls.every((c) => c.args.length === 2)).toBe(true);
  });

  it("on Linux refuses an executable or a .desktop file to xdg-open", async () => {
    const script = join(s.personas, "org/run.sh");
    const entry = join(s.personas, "org/app.desktop");
    const file = join(s.personas, "org/instructions/conduct.md");
    const folder = join(s.personas, "org");
    put(script, "#!/bin/sh\n");
    chmodSync(script, 0o755);
    put(entry, "[Desktop Entry]\nExec=sh\n");
    const { answers, calls } = await openAll([script, entry, file, folder], {
      platform: "linux",
    });
    expect(answers.map((a) => a.status)).toEqual([403, 403, 200, 200]);
    for (const answer of answers.slice(0, 2)) {
      expect(answer.body).toMatchObject({
        error: { code: "not-openable", details: { fix: expect.any(String) } },
      });
    }
    expect(calls).toEqual([
      { command: "xdg-open", args: [realpathSync(file)] },
      { command: "xdg-open", args: [realpathSync(folder)] },
    ]);
    // $VISUAL is the user's choice: it gets the script as is.
    const chosen = await openAll([script], {
      platform: "linux",
      env: { VISUAL: "gedit" },
    });
    expect(chosen.calls).toEqual([
      { command: "gedit", args: [realpathSync(script)] },
    ]);
  });

  it("opens inside the user's personas, a known project and a created agent's folder", async () => {
    pick(s.repo);
    const other = join(s.root, "other");
    mkdirSync(join(other, ".donn"), { recursive: true });
    await recordCreated(s.home, {
      project: other,
      name: "bot",
      path: "../bot-home",
    });
    const paths = [
      join(s.home, "personas/user/me.yaml"),
      // The user overlay layer is one file of the home.
      join(s.home, "overrides.yaml"),
      join(s.repo, ".donn/persona.yaml"),
      s.repo,
      join(s.root, "bot-home/agent.ts"),
    ];
    put(paths[0]!, "name: me\n");
    put(paths[4]!, "export {};\n");
    const { answers, calls } = await openAll(paths, {
      env: { VISUAL: "ed" },
    });
    expect(answers.map((a) => a.status)).toEqual(paths.map(() => 200));
    expect(calls.map((c) => c.args)).toEqual(
      paths.map((p) => [realpathSync(p)]),
    );
  });

  it("refuses .. and symlink escapes and paths outside every root, spawning nothing", async () => {
    const outside = mkdtempSync(join(tmpdir(), "donn-open-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "x");
      symlinkSync(outside, join(s.personas, "escape"));
      symlinkSync(join(outside, "secret.txt"), join(s.personas, "org/link.md"));
      const opener = recorder();
      const { bridge: b } = await bridge({ opener: opener.open });
      const token = await session(b);
      const open = (body: unknown) =>
        call(b.port, "POST", "/v1/open", { token, body });
      for (const path of [
        `${s.personas}/../home/config.yaml`,
        `${s.personas}/org/../../repo/.donn/persona.yaml`,
        `${s.personas}/..`,
        join(s.personas, "escape", "secret.txt"),
        join(s.personas, "escape", "missing.txt"),
        join(s.personas, "org/link.md"),
        join(outside, "secret.txt"),
        "/etc/hosts",
        s.root,
      ]) {
        const res = await open({ path });
        expect(res.status, path).toBe(403);
        expect(res.body).toMatchObject({
          error: { code: "outside-roots", details: { path } },
        });
      }
      // Inside a root but missing.
      const missing = await open({ path: join(s.personas, "nope.md") });
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ error: { code: "not-found" } });
      // Only an absolute path: never an option for the editor.
      for (const body of [
        { path: "org/instructions/conduct.md" },
        { path: "-n" },
        { path: "--version" },
        { path: "" },
        { path: 7 },
        { path: `${s.personas}\0x` },
        { path: s.personas, args: ["--wait"] },
        "not json",
      ]) {
        const res = await open(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body).toMatchObject({ error: { code: "bad-request" } });
      }
      expect(opener.calls).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("answers 500 open-failed when the editor cannot start", async () => {
    const opener = recorder(new Error("spawn nope ENOENT"));
    const { bridge: b } = await bridge({
      io: ioWith({ VISUAL: "nope" }),
      opener: opener.open,
    });
    const token = await session(b);
    const res = await call(b.port, "POST", "/v1/open", {
      token,
      body: { path: s.personas },
    });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      error: { code: "open-failed", details: { command: "nope" } },
    });
  });
});

describe("/v1/projects", { timeout: 20_000 }, () => {
  const uiJson = () =>
    JSON.parse(readFileSync(join(s.home, "ui.json"), "utf8")) as unknown;

  it("adds a project the user picks, only one with a persona, once", async () => {
    const { bridge: b } = await bridge();
    const token = await session(b);
    const add = (body: unknown) =>
      call(b.port, "POST", "/v1/projects", { token, body });
    const empty = join(s.root, "empty");
    mkdirSync(join(empty, ".donn"), { recursive: true });
    for (const path of [
      empty,
      join(s.root, "missing"),
      join(s.repo, ".donn"),
    ]) {
      const res = await add({ path });
      expect(res.status, path).toBe(400);
      expect(res.body).toMatchObject({
        error: { code: "not-a-project", details: { path } },
      });
    }
    for (const body of [{ path: "repo" }, {}, "x"]) {
      const res = await add(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toMatchObject({ error: { code: "bad-request" } });
    }
    expect(() => uiJson()).toThrow();
    // Not known yet.
    const before = await call(b.port, "POST", "/v1/run", {
      token,
      body: { argv: ["resolve", "--json"], cwd: s.repo },
    });
    expect(before.status).toBe(403);

    put(
      join(s.home, "ui.json"),
      JSON.stringify({ projects: [], theme: "dark" }),
    );
    const repo = realpathSync(s.repo);
    const res = await add({ path: s.repo });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: repo, projects: [repo] });
    // Twice, and by another spelling: recorded once; other keys kept.
    expect((await add({ path: `${s.repo}/` })).status).toBe(200);
    expect(uiJson()).toEqual({ projects: [repo], theme: "dark" });
    const after = await call(b.port, "POST", "/v1/run", {
      token,
      body: { argv: ["resolve", "--json"], cwd: s.repo },
    });
    expect(after.status).toBe(200);
  });

  it("refuses /, the user's home and the donn home as too broad", async () => {
    const user = join(s.root, "user-home");
    put(join(user, ".donn/persona.yaml"), "extends: org/base\n");
    put(join(s.home, ".donn/persona.yaml"), "extends: org/base\n");
    symlinkSync(s.home, join(s.root, "home-link"));
    const { bridge: b } = await bridge({ io: ioWith({ HOME: user }) });
    const token = await session(b);
    for (const path of [
      "/",
      user,
      s.home,
      `${s.home}/`,
      join(s.root, "home-link"),
    ]) {
      const res = await call(b.port, "POST", "/v1/projects", {
        token,
        body: { path },
      });
      expect(res.status, path).toBe(400);
      expect(res.body).toMatchObject({
        error: {
          code: "too-broad",
          details: { path, fix: "pick the repository folder" },
        },
      });
    }
    expect(() => uiJson()).toThrow();
  });

  it("records concurrent picks without losing one", async () => {
    const { bridge: b } = await bridge();
    const token = await session(b);
    const others = ["a", "b", "c"].map((name) => join(s.root, name));
    for (const dir of others)
      put(join(dir, ".donn/persona.yaml"), "extends: org/base\n");
    const results = await Promise.all(
      [...others, ...others].map((path) =>
        call(b.port, "POST", "/v1/projects", { token, body: { path } }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect((uiJson() as { projects: string[] }).projects.toSorted()).toEqual(
      others.map((dir) => realpathSync(dir)).toSorted(),
    );
  });

  it("lists the projects that sessions, created agents and the picker know", async () => {
    const plugin = join(s.root, "launched-plugin");
    put(
      join(plugin, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "donn-org--base" }),
    );
    await createSession(
      s.home,
      plugin,
      { persona: "org/base", source: "argument", project: s.repo },
      process.pid,
    );
    const other = join(s.root, "other");
    const picked = join(s.root, "picked");
    mkdirSync(join(other, ".donn"), { recursive: true });
    mkdirSync(picked);
    await recordCreated(s.home, { project: other, name: "bot" });
    pick(picked, s.repo);
    const { bridge: b } = await bridge();
    const token = await session(b);
    const res = await call(b.port, "GET", "/v1/projects", { token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      projects: [s.repo, other, picked].map((p) => realpathSync(p)).toSorted(),
    });
  });
});
