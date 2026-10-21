import { spawn, type ChildProcess } from "node:child_process";
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { Probe } from "@zzpersona/adapter-sdk";
import { writeBuild } from "@zzpersona/executor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareBuild } from "./build.js";
import { createContext } from "./context.js";
import {
  daemonRequest,
  type DaemonEvent,
  type DaemonStatus,
} from "./daemon/client.js";
import { daemonPaths } from "./daemon/paths.js";
import { startDaemon, type Daemon } from "./daemon/server.js";
import type { LiveState } from "./live-apply.js";
import { selectPersona } from "./select.js";
import { buildHash, createSession } from "./session.js";
import { installedProbe, quietIo, seed, type Seeded } from "./test/seed.js";

// The daemon's watch and refresh (spec 14 §3), against a seeded store and fake sessions owned by
// child processes. Debounce 50 ms; every wait polls with a deadline.

let s: Seeded;
let children: ChildProcess[];
let daemons: Daemon[];
let streams: (() => void)[];
beforeEach(() => {
  s = seed();
  children = [];
  daemons = [];
  streams = [];
});
afterEach(async () => {
  for (const stop of streams) stop();
  await Promise.all(daemons.map((d) => d.close()));
  for (const child of children) child.kill("SIGKILL");
  s.cleanup();
});

const conduct = () => join(s.personas, "org/instructions/conduct.md");
const projectPersona = (repo = s.repo) => join(repo, ".zzpersona/persona.yaml");

/** A process that stays alive until killed: the session's launcher. */
function owner(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"], {
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

/** A session as `zzpersona claude` (or `codex`) records it, launched on today's files. */
async function launch(
  persona: string,
  options: { project?: string; harness?: "claude-code" | "codex" } = {},
): Promise<string> {
  const harness = options.harness ?? "claude-code";
  const io = quietIo({ cwd: options.project ?? s.home, home: s.home });
  const ctx = await createContext(io);
  const selection = await selectPersona(persona, ctx);
  const build = await prepareBuild(ctx, io, {
    selection,
    harness,
    overlay: true,
    passthrough: [],
  });
  let plugin: string | undefined;
  if (harness === "claude-code") {
    await writeBuild(build.output, {
      buildDir: build.buildDir,
      store: ctx.store,
    });
    plugin = join(build.buildDir, "plugin");
  }
  return createSession(
    s.home,
    plugin,
    {
      persona,
      source: "argument",
      overlay: true,
      harness,
      ...(options.project !== undefined && { project: options.project }),
      startedAt: new Date().toISOString(),
      buildHash: buildHash(build.output),
      snapshot: {
        mcp: build.result.ir.mcp,
        permissions: build.result.ir.permissions,
        settings: build.result.ir.targets["claude-code"] ?? {},
      },
    },
    owner().pid!,
  );
}

async function start(options: { debounceMs?: number; probe?: Probe } = {}) {
  const daemon = await startDaemon({
    home: s.home,
    env: {},
    version: "9.9.9",
    debounceMs: options.debounceMs ?? 50,
    pollMs: 50,
    probe: options.probe ?? installedProbe,
  });
  daemons.push(daemon);
  return daemon;
}

interface Stream {
  events: DaemonEvent[];
  raw: () => string;
  ended: Promise<void>;
}

/** Follow `GET /events`; resolves once the stream is open. */
function follow(daemon: Daemon): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const events: DaemonEvent[] = [];
    let raw = "";
    let markEnded!: () => void;
    const ended = new Promise<void>((r) => (markEnded = r));
    const req = request(
      {
        socketPath: daemon.socket,
        method: "GET",
        path: "/events",
        headers: { authorization: `Bearer ${daemon.token}` },
      },
      (res) => {
        res.setEncoding("utf8");
        let buffer = "";
        res.on("data", (chunk: string) => {
          raw += chunk;
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const data = buffer
              .slice(0, end)
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n");
            buffer = buffer.slice(end + 2);
            if (data) events.push(JSON.parse(data) as DaemonEvent);
          }
        });
        res.on("end", markEnded);
        res.on("close", markEnded);
        resolve({ events, raw: () => raw, ended });
      },
    );
    req.on("error", reject);
    req.end();
    streams.push(() => req.destroy());
  });
}

async function until<T>(
  check: () => T | undefined | false,
  what: string,
  ms = 5_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const eventsOf = (stream: Stream, type: string, session?: string) =>
  stream.events.filter(
    (e) => e.type === type && (session === undefined || e.session === session),
  );

const waitEvent = (stream: Stream, type: string, session?: string, n = 1) =>
  until(
    () => eventsOf(stream, type, session).length >= n,
    `${n} ${type} event(s)`,
  ).then(() => eventsOf(stream, type, session)[n - 1]!);

/**
 * Write `content` (by default the file's own: a touch) until `done` holds. A watcher that has just
 * started can miss its first event (FSEvents arms asynchronously), so a write is repeated once a
 * second while nothing happens; repeating it is harmless, the build is the same.
 */
async function edit(
  path: string,
  content: string | undefined,
  done: () => boolean,
  what: string,
  options: { first?: boolean } = {},
) {
  const deadline = Date.now() + 8_000;
  for (let i = 0; ; i++) {
    if (i > 0 || options.first !== false) {
      writeFileSync(path, content ?? readFileSync(path, "utf8"));
    }
    const retry = Date.now() + 1_000;
    while (Date.now() < retry) {
      if (done()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
  }
}

const seen = (stream: Stream, type: string, session?: string) => () =>
  eventsOf(stream, type, session).length > 0;

const liveOf = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "live.json"), "utf8")) as LiveState;

async function status(daemon: Daemon): Promise<DaemonStatus> {
  const res = await daemonRequest(
    daemon.socket,
    daemon.token,
    "GET",
    "/status",
  );
  return res.body as DaemonStatus;
}

/** Log lines mentioning `text`: each refresh, skip and failure is one. */
const logLines = (text: string) =>
  (existsSync(daemonPaths(s.home).log)
    ? readFileSync(daemonPaths(s.home).log, "utf8")
    : ""
  )
    .split("\n")
    .filter((line) => line.includes(text));

/** Every file under a folder with its content, to show it did not change. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[path.slice(dir.length)] = readFileSync(path, "utf8");
  }
  return files;
}

describe("the daemon watches and refreshes", { timeout: 20_000 }, () => {
  it("refreshes a session when its instruction file changes", async () => {
    const dir = await launch("project/persona", { project: s.repo });
    const daemon = await start();
    const stream = await follow(daemon);
    expect((await status(daemon)).watching).toEqual(
      expect.arrayContaining([
        s.personas,
        join(s.home, "personas"),
        join(s.repo, ".zzpersona"),
        join(s.home, "overrides.yaml"),
        join(s.home, "config.yaml"),
        join(s.home, "sessions"),
      ]),
    );

    await edit(
      conduct(),
      "Review kindly, and say why.",
      seen(stream, "session.refreshed", dir),
      "a refresh",
    );
    const event = await waitEvent(stream, "session.refreshed", dir);
    expect(event).toMatchObject({
      type: "session.refreshed",
      session: dir,
      persona: "project/persona",
      harness: "claude-code",
    });
    expect(liveOf(dir).instructions).toContain("Review kindly, and say why.");
    expect(liveOf(dir).persona).toBe("project/persona");
    const [session] = (await status(daemon)).sessions;
    expect(session).toMatchObject({ dir, state: "refreshed" });
    expect(session!.at).toEqual(expect.any(String));
  });

  it("does nothing on an unchanged save", async () => {
    const dir = await launch("project/persona", { project: s.repo });
    await start();
    const skips = logLines(`skip ${dir}`).length;
    expect(skips).toBe(1);
    await edit(
      conduct(),
      undefined,
      () => logLines(`skip ${dir}`).length > skips,
      "a skip",
    );
    expect(existsSync(join(dir, "live.json"))).toBe(false);
  });

  it("keeps the last good build when the persona breaks", async () => {
    const dir = await launch("project/persona", { project: s.repo });
    const daemon = await start();
    const stream = await follow(daemon);
    const plugins = snapshot(join(dir, "plugins"));
    const good = readFileSync(projectPersona(), "utf8");

    await edit(
      projectPersona(),
      `${good}\n  : not: [yaml\n`,
      seen(stream, "session.refresh-failed", dir),
      "a failed refresh",
    );
    const failed = await waitEvent(stream, "session.refresh-failed", dir);
    expect(failed.error).toEqual(expect.any(String));
    expect(snapshot(join(dir, "plugins"))).toEqual(plugins);
    expect(existsSync(join(dir, "live.json"))).toBe(false);
    expect((await status(daemon)).sessions[0]).toMatchObject({
      state: "refresh-failed",
      error: failed.error,
    });

    writeFileSync(
      projectPersona(),
      good.replace("This repo is the checkout API.", "This repo is checkout."),
    );
    await waitEvent(stream, "session.refreshed", dir);
    expect(liveOf(dir).instructions).toContain("This repo is checkout.");
    expect((await status(daemon)).sessions[0]).toMatchObject({
      state: "refreshed",
    });
    expect((await status(daemon)).sessions[0]!.error).toBeUndefined();
  });

  it("marks a permissions change stale", async () => {
    const dir = await launch("project/persona", { project: s.repo });
    const daemon = await start();
    const stream = await follow(daemon);
    await edit(
      projectPersona(),
      readFileSync(projectPersona(), "utf8").replace(
        '    - "Bash(pnpm sim:*)"',
        '    - "Bash(pnpm sim:*)"\n    - "Bash(pnpm lint:*)"',
      ),
      seen(stream, "session.stale", dir),
      "a stale session",
    );
    const event = await waitEvent(stream, "session.stale", dir);
    expect(event).toMatchObject({ held: ["permissions"] });
    expect(liveOf(dir).held).toEqual(["permissions"]);
    expect((await status(daemon)).sessions[0]).toMatchObject({
      state: "stale",
      held: ["permissions"],
    });
  });

  it("marks a Codex session stale", async () => {
    const dir = await launch("project/persona", {
      project: s.repo,
      harness: "codex",
    });
    const daemon = await start();
    const stream = await follow(daemon);
    expect((await status(daemon)).sessions[0]).toMatchObject({
      harness: "codex",
      state: "current",
    });
    await edit(
      conduct(),
      "Review kindly, and say why.",
      seen(stream, "session.stale", dir),
      "a stale session",
    );
    expect(readdirSync(dir)).toEqual(["launched.json"]);
    expect((await status(daemon)).sessions[0]).toMatchObject({
      state: "stale",
    });
  });

  it("removes a session whose process died", async () => {
    const daemon = await start();
    const stream = await follow(daemon);
    const dir = await launch("project/persona", { project: s.repo });
    await edit(
      join(dir, "launched.json"),
      undefined,
      seen(stream, "session.added", dir),
      "an added session",
      { first: false },
    );
    children.at(-1)!.kill("SIGKILL");
    await waitEvent(stream, "session.ended", dir);
    expect(existsSync(dir)).toBe(false);
    expect((await status(daemon)).sessions).toEqual([]);
  });

  it("refreshes once for a burst of saves", async () => {
    const dir = await launch("project/persona", { project: s.repo });
    const daemon = await start();
    const stream = await follow(daemon);
    for (let i = 1; i <= 5; i++) {
      writeFileSync(conduct(), `Review kindly, take ${i}.`);
      await new Promise((r) => setTimeout(r, 4));
    }
    await edit(
      conduct(),
      "Review kindly, take 5.",
      seen(stream, "session.refreshed", dir),
      "a refresh",
      { first: false },
    );
    // A refresh now runs after anything the watcher still had queued.
    await daemonRequest(daemon.socket, daemon.token, "POST", "/refresh");
    expect(eventsOf(stream, "session.refreshed", dir)).toHaveLength(1);
    expect(liveOf(dir).instructions).toContain("Review kindly, take 5.");
  });

  it("isolates a session whose project is gone", async () => {
    const other = join(s.root, "other-repo");
    cpSync(s.repo, other, { recursive: true });
    const gone = await launch("project/persona", { project: other });
    const kept = await launch("project/persona", { project: s.repo });
    const daemon = await start();
    const stream = await follow(daemon);
    rmSync(other, { recursive: true, force: true });
    await edit(
      conduct(),
      "Review kindly, and say why.",
      () =>
        seen(stream, "session.refreshed", kept)() &&
        seen(stream, "session.refresh-failed", gone)(),
      "both sessions refreshed",
    );
    expect(liveOf(kept).instructions).toContain("Review kindly, and say why.");
    expect(existsSync(join(gone, "live.json"))).toBe(false);
    expect((await status(daemon)).watching).not.toContain(
      join(other, ".zzpersona"),
    );
  });

  it("serialises refreshes and applies the last edit", async () => {
    const dir = await launch("project/persona", { project: s.repo });
    let active = 0;
    let most = 0;
    let calls = 0;
    const slow: Probe = {
      ...installedProbe,
      run: async (...args) => {
        calls++;
        active++;
        most = Math.max(most, active);
        await new Promise((r) => setTimeout(r, 150));
        active--;
        return installedProbe.run(...args);
      },
    };
    const daemon = await start({ probe: slow });
    const stream = await follow(daemon);
    calls = 0;
    await edit(
      conduct(),
      "Review kindly, take 1.",
      () => calls > 0,
      "a refresh in flight",
    );
    writeFileSync(conduct(), "Review kindly, take 2.");
    await new Promise((r) => setTimeout(r, 60));
    writeFileSync(conduct(), "Review kindly, take 3.");
    await until(
      () =>
        existsSync(join(dir, "live.json")) &&
        liveOf(dir).instructions.includes("take 3"),
      "the last edit applied",
    );
    await daemonRequest(daemon.socket, daemon.token, "POST", "/refresh");
    expect(most).toBe(1);
    expect(
      eventsOf(stream, "session.refreshed", dir).length,
    ).toBeLessThanOrEqual(2);
  });

  it("re-checks every session on POST /refresh", async () => {
    const dir = await launch("project/persona", { project: s.repo });
    // A debounce longer than the test: only the request can trigger the check.
    const daemon = await start({ debounceMs: 60_000 });
    writeFileSync(conduct(), "Review kindly, and say why.");
    const res = await daemonRequest(
      daemon.socket,
      daemon.token,
      "POST",
      "/refresh",
    );
    expect(res.status).toBe(200);
    expect(liveOf(dir).instructions).toContain("Review kindly, and say why.");
    expect((await status(daemon)).sessions[0]).toMatchObject({
      state: "refreshed",
    });
  });

  it("streams events as server-sent events", async () => {
    const dir = await launch("project/persona", { project: s.repo });
    const daemon = await start();
    const stream = await follow(daemon);
    await edit(
      conduct(),
      "Review kindly, and say why.",
      seen(stream, "session.refreshed", dir),
      "a refresh",
    );
    expect(stream.raw()).toMatch(
      /(^|\n)event: session\.refreshed\ndata: \{.*"type":"session\.refreshed".*\}\n\n/,
    );
    await daemon.close();
    await stream.ended;
    expect(stream.raw()).toMatch(/event: daemon\.stopping\ndata: \{.*\}\n\n$/);
  });

  it("finishes an in-flight refresh before it stops", async () => {
    const dir = await launch("project/persona", { project: s.repo });
    let calls = 0;
    const slow: Probe = {
      ...installedProbe,
      run: async (...args) => {
        calls++;
        await new Promise((r) => setTimeout(r, 150));
        return installedProbe.run(...args);
      },
    };
    const daemon = await start({ probe: slow });
    calls = 0;
    await edit(
      conduct(),
      "Review kindly, and say why.",
      () => calls > 0,
      "a refresh in flight",
    );
    await daemon.close();
    expect(liveOf(dir).instructions).toContain("Review kindly, and say why.");
    expect(existsSync(daemon.socket)).toBe(false);
  });
});
