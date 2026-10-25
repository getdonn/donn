import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordCreated } from "./agent/registry.js";
import { openBridge, type Bridge } from "./daemon/bridge.js";
import { daemonRequest } from "./daemon/client.js";
import { allowedRun, runInProcess } from "./daemon/run.js";
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
beforeEach(() => {
  s = seed();
  daemons = [];
  bridges = [];
});
afterEach(async () => {
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
    run: (io, argv, cwd) => {
      calls.push({ argv, cwd });
      return runInProcess(io, argv, cwd);
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

async function startTestDaemon(now?: () => number) {
  const daemon = await startDaemon({
    home: s.home,
    env: {},
    version: "9.9.9",
    debounceMs: 50,
    probe: installedProbe,
    ...(now && { now }),
  });
  daemons.push(daemon);
  return daemon;
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

  it("names the --project an agent command acts on", () => {
    expect(
      uiAllowed(["agent", "sync", "bot", "--project", "/p", "--json"]),
    ).toEqual({ ok: true, project: "/p" });
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
      { argv: ["list", "--json"] },
      { argv: "list", cwd: s.repo },
      { argv: ["list", "--json"], cwd: "rel" },
    ]) {
      const res = await call(b.port, "POST", "/v1/run", { token, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toMatchObject({ error: { code: "bad-request" } });
    }
    const big = await call(b.port, "POST", "/v1/run", {
      token,
      body: { argv: ["list", "--json"], cwd: s.repo, pad: "x".repeat(2 ** 20) },
    });
    expect(big.status).toBe(413);
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
