import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, join, relative, sep } from "node:path";
import type { Probe } from "@zzpersona/adapter-sdk";
import { isAlive, nodeProbe } from "@zzpersona/executor";
import type { CliIo } from "../cli.js";
import { loadConfig } from "../config.js";
import { CliError } from "../errors.js";
import { writeFileAtomic } from "../fs.js";
import { listSessions, removeSession, type SessionInfo } from "../session.js";
import type {
  DaemonEvent,
  DaemonStatus,
  SessionState,
  SessionStatus,
} from "./client.js";
import { createLog } from "./log.js";
import { daemonPaths, privateSocketDir } from "./paths.js";
import { refreshSession, type RefreshOutcome } from "./refresh.js";
import { watchKey, watchSources, type Watch } from "./watch.js";

// The daemon: HTTP/1.1 with JSON bodies over a unix socket, a bearer token on every request.
// One per home, held by `daemon.lock`. See docs/planning/14-daemon.md §1 and §4.

export interface DaemonOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  version: string;
  /** Quiet period after the last file event before a refresh; 300 ms. */
  debounceMs?: number;
  /** How often running sessions' pids are checked, to notice one that died; 1 s. */
  pollMs?: number;
  /** Runs harness detection while compiling; defaults to the executor's node probe. */
  probe?: Probe;
  now?: () => number;
}

export interface Daemon {
  socket: string;
  token: string;
  startedAt: string;
  refresh(): Promise<void>;
  /** Stop serving and remove `sock`, `pid`, `where`, `token` and the lock. Safe to call twice. */
  close(): Promise<void>;
  /** Settles once the daemon has closed, by `close()` or `POST /shutdown`. */
  closed: Promise<void>;
}

/** Take `daemon.lock` (it holds the owner's pid); a lock whose owner is gone is replaced. */
async function acquireLock(lock: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const file = await open(lock, "wx", 0o600);
      await file.writeFile(`${process.pid}\n`);
      await file.close();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number.parseInt(
        await readFile(lock, "utf8").catch(() => ""),
        10,
      );
      if ((owner > 0 && isAlive(owner)) || attempt > 0) {
        throw new CliError("daemon-running", "already running", { lock });
      }
      await rm(lock, { force: true });
    }
  }
}

const sameToken = (header: string | undefined, token: string) => {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(`${JSON.stringify(body)}\n`);
}

const DEBOUNCE_MS = 300;
const POLL_MS = 1_000;
/** How long shutdown lets a request still being answered finish before cutting it. */
const CLOSE_GRACE_MS = 1_000;

interface Tracked {
  state: SessionState;
  /** When the state was reached; absent until the first change. */
  at?: string;
  held: string[];
  error?: string;
  pid: number;
}

const failure = (code: string, message: string) => ({
  error: { code, message },
});

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const now = options.now ?? Date.now;
  const paths = daemonPaths(options.home, options.env);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await chmod(paths.dir, 0o700);
  await acquireLock(paths.lock);

  const log = createLog(paths.log, now);
  const token = randomBytes(32).toString("hex");
  const startedAt = new Date(now()).toISOString();
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const sessionsDir = join(options.home, "sessions");
  await mkdir(sessionsDir, { recursive: true });

  // Compiling runs as the CLI would in the session's folder; what it prints goes to the log.
  const toLog = {
    write: (text: string) => {
      for (const line of text.split("\n")) if (line.trim()) void log(line);
      return true;
    },
  };
  const io: CliIo = {
    env: { ...options.env, ZZPERSONA_HOME: options.home },
    cwd: options.home,
    stdout: toLog,
    stderr: toLog,
    probe: options.probe ?? nodeProbe(),
    now,
  };

  /** What the daemon last found for each running session, by folder. */
  const tracked = new Map<string, Tracked>();
  const streams = new Set<ServerResponse>();
  let watcher: Watch | undefined;
  let watchedKey = "";
  let stopping = false;

  const emit = (event: DaemonEvent) => {
    const text = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const stream of streams) stream.write(text);
  };

  const status = async (): Promise<DaemonStatus> => ({
    version: options.version,
    pid: process.pid,
    startedAt,
    watching: watcher?.paths ?? [],
    sessions: (await listSessions(options.home))
      .filter((s) => s.running)
      .map((s): SessionStatus => {
        const t = tracked.get(s.dir);
        return {
          dir: s.dir,
          harness: s.launched.harness,
          ...(s.launched.project !== undefined && {
            project: s.launched.project,
          }),
          launched: s.launched.persona,
          ...(s.live && { live: s.live.persona }),
          ...(s.launched.startedAt !== undefined && {
            startedAt: s.launched.startedAt,
          }),
          held: t?.held ?? s.live?.held ?? [],
          state: t?.state ?? "current",
          ...(t?.at !== undefined && { at: t.at }),
          ...(t?.error !== undefined && { error: t.error }),
        };
      }),
  });

  // The session registry only changes by a folder coming or going, or its launch record: the
  // daemon's own swaps write live.json and plugins/, which must not start another refresh.
  const accept = (path: string) => {
    const rel = relative(sessionsDir, path);
    if (rel.startsWith("..")) return true;
    const parts = rel.split(sep);
    return parts.length === 1 || parts[1] === "launched.json";
  };

  /** Watch the personas roots, running sessions' projects, the overlay, config and sessions. */
  const rewatch = async (running: SessionInfo[]) => {
    const config = await loadConfig(options.home, io.env).catch(() => ({
      personas: undefined,
    }));
    // Shutdown may have begun during the read: it closes the watchers, so start none.
    if (stopping) return;
    const projects = [
      ...new Set(
        running.flatMap((s) =>
          s.launched.project === undefined
            ? []
            : [join(s.launched.project, ".zzpersona")],
        ),
      ),
    ].filter((dir) => existsSync(dir));
    const paths = [
      ...(config.personas !== undefined ? [config.personas] : []),
      // The store's user layer: user personas live under <home>/personas.
      join(options.home, "personas"),
      ...projects,
      join(options.home, "overrides.yaml"),
      join(options.home, "config.yaml"),
      sessionsDir,
    ];
    const key = watchKey(paths);
    if (watcher && key === watchedKey) return;
    watcher?.close();
    watcher = watchSources(paths, () => void refresh(), debounceMs, accept);
    watchedKey = key;
  };

  const record = async (session: SessionInfo, outcome: RefreshOutcome) => {
    const prior = tracked.get(session.dir);
    const persona = session.live?.persona ?? session.launched.persona;
    const at = new Date(now()).toISOString();
    // The user switched mid-refresh: their switch stands, and the state is left as it was.
    if (outcome.superseded) {
      await log(`skip ${session.dir} ${persona}: superseded`);
      return;
    }
    if (outcome.state === "current") {
      await log(`skip ${session.dir} ${persona}: current`);
      // Unchanged since the last swap: a Claude Code session keeps saying when it was refreshed,
      // or that it is stale; only a failure clears. Codex compares with its launch every time.
      const keep =
        prior !== undefined &&
        session.launched.harness === "claude-code" &&
        prior.state !== "refresh-failed" &&
        prior.state !== "current";
      tracked.set(session.dir, {
        ...(keep ? prior : { state: "current" }),
        held: outcome.held,
        pid: session.launched.pid,
      });
      return;
    }
    let state: SessionState = outcome.state;
    // A swap that holds back what was already held is still stale: it still needs a relaunch.
    if (
      state === "refreshed" &&
      prior?.state === "stale" &&
      prior.held.length > 0 &&
      prior.held.every((part) => outcome.held.includes(part))
    ) {
      state = "stale";
    }
    tracked.set(session.dir, {
      state,
      at,
      held: outcome.held,
      ...(outcome.error !== undefined && { error: outcome.error }),
      pid: session.launched.pid,
    });
    const detail =
      outcome.error !== undefined
        ? `: ${outcome.error.replaceAll("\n", " ")}`
        : outcome.held.length > 0
          ? `: held ${outcome.held.join(", ")}`
          : "";
    await log(`${state} ${session.dir} ${persona}${detail}`);
    emit({
      type: `session.${state}`,
      session: session.dir,
      harness: session.launched.harness,
      persona,
      held: outcome.held,
      at,
      ...(outcome.error !== undefined && { error: outcome.error }),
    });
  };

  const ended = async (dir: string) => {
    tracked.delete(dir);
    await log(`ended ${dir}`);
    emit({ type: "session.ended", session: dir });
  };

  /** One pass: drop dead sessions, note new ones, rewatch, refresh each running session. */
  const cycle = async () => {
    const running: SessionInfo[] = [];
    for (const session of await listSessions(options.home)) {
      if (!session.running) {
        await removeSession(session.dir);
        await ended(session.dir);
        continue;
      }
      running.push(session);
      if (!tracked.has(session.dir)) {
        tracked.set(session.dir, {
          state: "current",
          held: session.live?.held ?? [],
          pid: session.launched.pid,
        });
        await log(`added ${session.dir} ${session.launched.persona}`);
        emit({
          type: "session.added",
          session: session.dir,
          harness: session.launched.harness,
          persona: session.launched.persona,
        });
      }
    }
    // Folders removed by their launcher on exit.
    const live = new Set(running.map((s) => s.dir));
    for (const dir of [...tracked.keys()]) {
      if (!live.has(dir)) await ended(dir);
    }
    if (stopping) return;
    await rewatch(running);
    for (const session of running) {
      // Shutdown finishes the swap in flight, not the ones after it.
      if (stopping) return;
      await record(session, await refreshSession(io, session));
    }
  };

  // One refresh at a time; a change during one schedules exactly one more.
  let inFlight: Promise<void> | undefined;
  let queued: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    if (stopping) return queued ?? inFlight ?? Promise.resolve();
    if (!inFlight) {
      inFlight = cycle()
        .catch((error: unknown) => log(`error refresh: ${String(error)}`))
        .finally(() => (inFlight = undefined));
      return inFlight;
    }
    queued ??= inFlight.then(() => {
      queued = undefined;
      return refresh();
    });
    return queued;
  };

  // A launcher killed outright leaves its folder behind and no file changes: check the pids.
  const poll = setInterval(() => {
    for (const t of tracked.values()) {
      if (!isAlive(t.pid)) return void refresh();
    }
  }, options.pollMs ?? POLL_MS);
  poll.unref();

  let closing: Promise<void> | undefined;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => (markClosed = resolve));

  const server = createServer((req: IncomingMessage, res) => {
    void (async () => {
      if (!sameToken(req.headers.authorization, token)) {
        return send(
          res,
          401,
          failure("unauthorized", "missing or wrong token"),
        );
      }
      const route = `${req.method} ${req.url}`;
      if (route === "GET /status") return send(res, 200, await status());
      if (route === "GET /events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        // A comment, so the client knows the stream is open.
        res.write(": connected\n\n");
        streams.add(res);
        req.on("close", () => streams.delete(res));
        return;
      }
      if (route === "POST /refresh") {
        await refresh();
        return send(res, 200, await status());
      }
      if (route === "POST /shutdown") {
        send(res, 200, { stopping: true });
        void close();
        return;
      }
      send(res, 404, failure("not-found", `no such endpoint: ${route}`));
    })().catch((error: unknown) => {
      void log(`error ${req.method} ${req.url}: ${String(error)}`);
      if (!res.headersSent) {
        send(res, 500, failure("internal", "the daemon failed this request"));
      }
    });
  });

  const close = () =>
    (closing ??= (async () => {
      stopping = true;
      await log("stopping");
      clearInterval(poll);
      watcher?.close();
      // Finish the swap in flight: a session is never left half-swapped.
      while (inFlight || queued) await (queued ?? inFlight);
      // Again: the refresh just finished may have rewatched before it saw `stopping`.
      watcher?.close();
      watcher = undefined;
      emit({ type: "daemon.stopping" });
      for (const stream of streams) stream.end();
      streams.clear();
      // Before the socket, which closing the server unlinks: a client that sees the socket gone
      // finds the pid gone too.
      await Promise.all(
        [paths.pid, paths.where, paths.token].map((p) =>
          rm(p, { force: true }),
        ),
      );
      await new Promise<void>((resolve) => {
        // Requests still being answered get a grace period, then are cut.
        const force = setTimeout(
          () => server.closeAllConnections(),
          CLOSE_GRACE_MS,
        );
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      });
      await rm(paths.sock, { force: true });
      // Last: `daemon stop` waits for the lock to go before it reports stopped.
      await rm(paths.lock, { force: true });
      await log("stopped");
      markClosed();
    })());

  const fallback = paths.sock !== join(paths.dir, "sock");
  try {
    // A long home's socket lives in a folder that must be the user's alone.
    if (fallback) await privateSocketDir(dirname(paths.sock));
    // We hold the lock: anything at these paths is left from a daemon that died.
    await rm(paths.sock, { force: true });
    await rm(paths.where, { force: true });
    await writeFileAtomic(paths.token, token, 0o600);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.sock, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(paths.sock, 0o600);
    if (fallback) {
      await writeFileAtomic(paths.where, `${paths.sock}\n`, 0o600);
    }
    await writeFileAtomic(paths.pid, `${process.pid}\n`, 0o600);
  } catch (error) {
    clearInterval(poll);
    server.close();
    await rm(paths.token, { force: true });
    await rm(paths.lock, { force: true });
    throw error;
  }
  await log(`started ${options.version} pid ${process.pid} on ${paths.sock}`);
  // The first pass: learn the sessions, start watching, catch up on edits made while stopped.
  await refresh();

  return {
    socket: paths.sock,
    token,
    startedAt,
    refresh,
    close,
    closed,
  };
}
