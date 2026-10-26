import { randomBytes } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect } from "node:net";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Probe } from "@getdonn/adapter-sdk";
import { listCreated, type CreatedAgent } from "../agent/registry.js";
import type { Spawn } from "../agent/spawn.js";
import { isAlive, nodeProbe } from "@getdonn/executor";
import type { CliIo } from "../cli.js";
import { loadConfig } from "../config.js";
import { CliError, errorEnvelope } from "../errors.js";
import { writeFileAtomic } from "../fs.js";
import { listSessions, removeSession, type SessionInfo } from "../session.js";
import { agentRunner } from "./agents.js";
import { openBridge, type Bridge, type BridgeOptions } from "./bridge.js";
import type {
  DaemonEvent,
  DaemonStatus,
  SessionState,
  SessionStatus,
} from "./client.js";
import { failure, readBody, runRequest, sameToken } from "./http.js";
import { redactAnswers } from "./jobs.js";
import { createLog } from "./log.js";
import { daemonPaths, privateSocketDir } from "./paths.js";
import { isDaemonProcess } from "./process.js";
import { refreshSession, type RefreshOutcome } from "./refresh.js";
import { agentCreated, allowedRun, runInProcess } from "./run.js";
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
  /** Test seam: the system's record of the user's home folder (see userhome.ts). */
  passwdHome?: () => string | undefined;
  /** Runs the agents' own eve (spec 25); defaults to node:child_process. */
  spawn?: Spawn;
  /** Test seam: the file watching; watch.ts's by default. */
  watch?: typeof watchSources;
  /** Test seam: the UI bridge's idle timing and app folder (spec 26 §2). */
  bridge?: Pick<BridgeOptions, "idleMs" | "tickMs" | "uiDir">;
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

/** A takeover file older than this was left by a starter that crashed holding it. */
const TAKEOVER_STALE_MS = 10_000;

const running = (lock: string) =>
  new CliError("daemon-running", "already running", { lock });

const exists = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "EEXIST";

/**
 * The locks this process holds. A lock naming this process is only live if it is one of them
 * (a second daemon started in-process); else this process got a dead daemon's pid.
 */
const held = new Set<string>();

/** Whether the lock's `owner` is a daemon that still runs. */
const liveOwner = (lock: string, owner: number) =>
  owner === process.pid ? held.has(lock) : isDaemonProcess(owner);

/** Remove a lock this process holds. */
async function releaseLock(lock: string): Promise<void> {
  held.delete(lock);
  await rm(lock, { force: true });
}

/**
 * Create `lock` holding our pid; false when it already exists. The pid is written to a temp file
 * first and linked into place, so the lock is never seen empty: an empty one is a leftover.
 */
async function createLock(
  lock: string,
  linkFile: typeof link = link,
): Promise<boolean> {
  const temp = `${lock}.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temp, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    try {
      await linkFile(temp, lock);
    } catch (error) {
      if (!NO_LINK.has((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
      await createLockInPlace(lock);
    }
    held.add(lock);
    return true;
  } catch (error) {
    if (exists(error)) return false;
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}

/** How long an empty lock may be one a starter is still writing its pid into. */
const EMPTY_LOCK_MS = 1000;

/** What `link()` fails with on a filesystem without hard links. */
const NO_LINK = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"]);

/**
 * Where there are no hard links: create the lock exclusively and write the pid into it. A racer
 * may see it empty for a moment; its second read, under the takeover file, sees the pid.
 */
async function createLockInPlace(lock: string): Promise<void> {
  const handle = await open(lock, "wx", 0o600);
  try {
    await handle.writeFile(`${process.pid}\n`);
  } finally {
    await handle.close();
  }
}

/** A unique name beside `file`, with this process's pid in it. */
const aside = (file: string) =>
  `${file}.${process.pid}.${randomBytes(6).toString("hex")}`;

/**
 * Remove the takeover file `seen` as stale; false when what is there now is another file (a
 * starter replaced it since the stat), which is left in place. It is renamed aside first, so the
 * file removed is always the one checked.
 */
async function removeStale(takeover: string, seen: Stats): Promise<boolean> {
  const moved = aside(takeover);
  try {
    await rename(takeover, moved);
  } catch (error) {
    // Already gone: nothing to remove.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const now = await stat(moved).catch(() => undefined);
  if (now?.ino === seen.ino && now.mtimeMs === seen.mtimeMs) {
    await rm(moved, { force: true });
    return true;
  }
  // Another starter's: put it back, unless yet another is already in its place.
  await link(moved, takeover).catch(async (error: NodeJS.ErrnoException) => {
    if (NO_LINK.has(error.code ?? "")) await rename(moved, takeover);
  });
  await rm(moved, { force: true });
  return false;
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Remove temp files next to `lock` (`<lock>.<pid>.<hex>`) left by starters that died. */
async function sweepTemps(lock: string): Promise<void> {
  const dir = dirname(lock);
  const pattern = new RegExp(
    `^${escapeRegExp(basename(lock))}\\.(?:takeover\\.)?(\\d+)\\.[0-9a-f]+$`,
  );
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names.map(async (name) => {
      const pid = Number(pattern.exec(name)?.[1]);
      if (pid > 0 && !isAlive(pid)) await rm(join(dir, name), { force: true });
    }),
  );
}

/**
 * Take `daemon.lock` (it holds the owner's pid). A lock whose owner is gone or is not a daemon
 * (its pid reused), or an empty or unreadable one, is replaced under `daemon.lock.takeover`, so
 * that of starters racing for it exactly one wins. See docs/planning/16-daemon-service.md §3.
 */
export interface LockOptions {
  now?: () => number;
  /** Test-only: the `link()` that puts the lock in place. */
  link?: typeof link;
  /** Test-only: runs after the lock was found to exist, before it is read. */
  afterExists?: () => Promise<void>;
  /** Test-only: runs after a takeover file was found stale, before it is removed. */
  beforeStaleRemove?: () => Promise<void>;
}

export async function acquireLock(
  lock: string,
  options: LockOptions = {},
): Promise<void> {
  await takeLock(lock, options);
  // Held: no other starter of this home runs, so a temp file of a dead pid is a leftover.
  // Best effort: a sweep that fails must not leave the lock held.
  await sweepTemps(lock).catch(() => {});
}

async function takeLock(lock: string, options: LockOptions): Promise<void> {
  const now = options.now ?? Date.now;
  const create = () => createLock(lock, options.link);
  if (await create()) return;
  await options.afterExists?.();
  // Unreadable reads as empty, here and below, so it is taken over once.
  const read = () => readFile(lock, "utf8").catch(() => "");
  // Gone since the create (its daemon stopping): create it once more before a takeover.
  const first = await readFile(lock, "utf8").catch((error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "",
  );
  if (first === undefined && (await create())) return;
  const seen = first ?? (await read());
  const owner = Number.parseInt(seen, 10);
  if (owner > 0 && liveOwner(lock, owner)) throw running(lock);
  // An empty lock under a second old may be one still being written (createLockInPlace).
  if (seen === "") {
    const found = await stat(lock).catch(() => undefined);
    if (found?.size === 0 && now() - found.mtimeMs < EMPTY_LOCK_MS)
      throw running(lock);
  }
  const takeover = `${lock}.takeover`;
  for (let attempt = 0; ; attempt++) {
    try {
      await (await open(takeover, "wx", 0o600)).close();
      break;
    } catch (error) {
      if (!exists(error)) throw error;
      const found = await stat(takeover).catch(() => undefined);
      if (attempt > 0 || !found || now() - found.mtimeMs <= TAKEOVER_STALE_MS)
        throw running(lock);
      await options.beforeStaleRemove?.();
      if (!(await removeStale(takeover, found))) throw running(lock);
    }
  }
  try {
    // Another starter may have replaced the lock since we read it: only ours to replace if not.
    if ((await read()) !== seen) throw running(lock);
    await releaseLock(lock);
    if (!(await create())) throw running(lock);
  } finally {
    await rm(takeover, { force: true });
  }
}

/** How long a connect to an existing socket may take before it counts as dead. */
const CONNECT_MS = 200;

/** Whether something accepts connections on the socket. */
const answers = (sock: string) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(sock);
    const done = (alive: boolean) => {
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(CONNECT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

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

/** At most this many env refs in a run request, and this many bytes of them in all. */
const MAX_ENV_REFS = 100;
const MAX_ENV_BYTES = 64 * 1024;

/**
 * `{ project, name, env? }` from `POST /agents/run|stop`'s body, or the reason it is not one.
 * `env` (run only) maps `secret://` refs to values; a reason never quotes a value.
 */
function agentRequest(
  text: string,
): { project: string; name: string; env?: Record<string, string> } | string {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return "the body is not JSON";
  }
  const { project, name, env } = (body ?? {}) as {
    project?: unknown;
    name?: unknown;
    env?: unknown;
  };
  if (typeof project !== "string" || !isAbsolute(project))
    return "project must be an absolute path";
  if (typeof name !== "string" || name === "")
    return "name must be an agent's name";
  if (env === undefined) return { project, name };
  if (typeof env !== "object" || env === null || Array.isArray(env))
    return "env must map secret:// refs to values";
  const pairs = Object.entries(env);
  if (
    pairs.some(
      ([ref, v]) => !ref.startsWith("secret://") || typeof v !== "string",
    )
  )
    return "env must map secret:// refs to values";
  if (pairs.length > MAX_ENV_REFS)
    return `env has more than ${MAX_ENV_REFS} refs`;
  const bytes = pairs.reduce(
    (n, [ref, v]) =>
      n + Buffer.byteLength(ref) + Buffer.byteLength(v as string),
    0,
  );
  if (bytes > MAX_ENV_BYTES) return "env is over 64 KiB";
  return { project, name, env: env as Record<string, string> };
}

/** `{ port? }` from `POST /ui/open`'s body (empty is `{}`), or the reason it is not one. */
function uiOpenRequest(text: string): { port?: number } | string {
  let body: unknown;
  try {
    body = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return "the body is not JSON";
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return "the body must be { port? }";
  const { port } = body as { port?: unknown };
  if (port === undefined) return {};
  if (
    !Number.isInteger(port) ||
    (port as number) < 1 ||
    (port as number) > 65535
  )
    return "port must be a whole number from 1 to 65535";
  return { port: port as number };
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const now = options.now ?? Date.now;
  const paths = daemonPaths(options.home, options.env);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await chmod(paths.dir, 0o700);
  const sessionsDir = join(options.home, "sessions");
  const agentsIndex = join(options.home, "agents", "index.json");
  await acquireLock(paths.lock);
  try {
    await mkdir(sessionsDir, { recursive: true });
    // So the created agents' index is watched before the first create writes it.
    await mkdir(dirname(agentsIndex), { recursive: true, mode: 0o700 });
  } catch (error) {
    // Held, but not started: a lock left here would hold off every later start.
    await releaseLock(paths.lock);
    throw error;
  }

  const log = createLog(paths.log, now);
  const token = randomBytes(32).toString("hex");
  const startedAt = new Date(now()).toISOString();
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;

  // Compiling runs as the CLI would in the session's folder; what it prints goes to the log.
  const toLog = {
    write: (text: string) => {
      for (const line of text.split("\n")) if (line.trim()) void log(line);
      return true;
    },
  };
  const io: CliIo = {
    env: { ...options.env, DONN_HOME: options.home },
    cwd: options.home,
    stdout: toLog,
    stderr: toLog,
    probe: options.probe ?? nodeProbe(),
    now,
    ...(options.passwdHome && { passwdHome: options.passwdHome }),
    ...(options.spawn && { spawn: options.spawn }),
  };

  /** What the daemon last found for each running session, by folder. */
  const tracked = new Map<string, Tracked>();
  const streams = new Set<ServerResponse>();
  let watcher: Watch | undefined;
  let watchedKey = "";
  let stopping = false;

  /** Followers in process: the UI bridge's `/v1/events` (spec 26 §2). */
  const followers = new Set<(event: DaemonEvent) => void>();
  const emit = (event: DaemonEvent) => {
    const text = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const stream of streams) stream.write(text);
    for (const follower of followers) follower(event);
  };

  // The CLI run in-process (POST /run) starts and stops agents here, not over the socket.
  const agents = agentRunner({ home: options.home, io, emit, log, now });
  io.agents = agents;

  const status = async (): Promise<DaemonStatus> => ({
    version: options.version,
    pid: process.pid,
    startedAt,
    service: options.env.DONN_SERVICE === "1",
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
    agents: (await agents.list()).map(({ token: _, ...agent }) => agent),
    syncFailed: agents.syncFailures(),
  });

  // The session registry only changes by a folder coming or going, or its launch record: the
  // daemon's own swaps write live.json and plugins/, which must not start another refresh.
  const accept = (path: string) => {
    const rel = relative(sessionsDir, path);
    if (rel.startsWith("..")) return true;
    const parts = rel.split(sep);
    return parts.length === 1 || parts[1] === "launched.json";
  };

  /**
   * Watch the personas roots, the projects of running sessions and of created agents, the
   * overlay, config, the registry index, sessions and the created agents' index.
   */
  const rewatch = async (running: SessionInfo[], created: CreatedAgent[]) => {
    const config = await loadConfig(options.home, io.env, io.passwdHome).catch(
      () => ({
        personas: undefined,
      }),
    );
    // Shutdown may have begun during the read: it closes the watchers, so start none.
    if (stopping) return;
    const projects = [
      ...new Set([
        ...running.flatMap((s) =>
          s.launched.project === undefined
            ? []
            : [join(s.launched.project, ".donn")],
        ),
        ...created.map((c) => join(c.project, ".donn")),
      ]),
    ].filter((dir) => existsSync(dir));
    watchedProjects = projects.map((dir) => dirname(dir));
    const paths = [
      ...(config.personas !== undefined ? [config.personas] : []),
      // The store's user layer: user personas live under <home>/personas.
      join(options.home, "personas"),
      ...projects,
      join(options.home, "overrides.yaml"),
      join(options.home, "config.yaml"),
      // A pull replaces the registry index by rename: published layers changed.
      join(options.home, "cache", "registry", "index.json"),
      sessionsDir,
      // `donn agent create` in a terminal: announced, and its project watched.
      agentsIndex,
    ];
    const key = watchKey(paths);
    if (watcher && key === watchedKey) return;
    watcher?.close();
    const armed = (options.watch ?? watchSources)(
      paths,
      changed,
      debounceMs,
      accept,
    );
    watcher = armed;
    watchedKey = key;
    // An edit made while the watchers arm can go unseen: once they settle, one more pass over
    // every source catches up on it. Unchanged sources make it a pass of skips.
    void armed.settled.then(() => {
      if (watcher === armed && !stopping) void refreshAll();
    });
  };

  /** What changed since the last pass, for the agents: every source, or these paths. */
  let agentScope: "all" | Set<string> = "all";
  /** The projects watched, by root folder, as of the last rewatch. */
  let watchedProjects: string[] = [];
  const changed = (paths: ReadonlySet<string> | undefined) => {
    if (paths === undefined) agentScope = "all";
    else if (agentScope !== "all") for (const p of paths) agentScope.add(p);
    void refresh();
  };
  /** An explicit refresh, and the first pass, sync every created agent. */
  const refreshAll = () => {
    agentScope = "all";
    return refresh();
  };

  const under = (path: string, dir: string) =>
    path === dir || path.startsWith(`${dir}${sep}`);

  /**
   * The created agents a change reaches: those of a project whose `.donn/` changed, or all of
   * them when a shared source did (personas, the overlay, config, the registry index), since
   * any project can inherit from it. Sessions and the agents' index reach none.
   */
  const reached = (
    created: CreatedAgent[],
    scope: "all" | Set<string>,
  ): CreatedAgent[] => {
    if (scope === "all") return created;
    const projects = new Set<string>();
    for (const path of scope) {
      if (under(path, sessionsDir) || path === agentsIndex) continue;
      const project = watchedProjects.find((p) =>
        under(path, join(p, ".donn")),
      );
      if (project === undefined) return created;
      projects.add(project);
    }
    return created.filter((c) => projects.has(c.project));
  };

  /** The created agents announced so far, by project and name; undefined before the first pass. */
  let announced: Set<string> | undefined;
  /** The index as the last pass read it: an entry gone from it since can be announced again. */
  let listed = new Set<string>();
  const createdKey = (c: { project: string; name: string }) =>
    `${c.project}\0${c.name}`;
  const announce = async (c: { project: string; name: string }) => {
    announced?.add(createdKey(c));
    await log(`agent ${c.name} created in ${c.project}`);
    emit({ type: "agent.created", name: c.name, project: c.project });
  };

  const record = async (session: SessionInfo, outcome: RefreshOutcome) => {
    const prior = tracked.get(session.dir);
    const persona = session.live?.persona ?? session.launched.persona;
    const at = new Date(now()).toISOString();
    // The user switched mid-refresh: their switch stands, and the state is left as it was.
    if (outcome.superseded) {
      await log(`skip ${session.dir} ${persona}: superseded`);
      // One more check, so the persona they chose is compiled from today's files.
      void refresh();
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

  /** Dead sessions whose folder could not be removed. */
  const abandoned = new Set<string>();

  const ended = async (dir: string) => {
    tracked.delete(dir);
    await log(`ended ${dir}`);
    emit({ type: "session.ended", session: dir });
  };

  /**
   * One pass: drop dead sessions, note new ones and new created agents, rewatch, refresh each
   * running session, sync the created agents the changes reach.
   */
  const cycle = async () => {
    const scope = agentScope;
    agentScope = new Set();
    const running: SessionInfo[] = [];
    for (const session of await listSessions(options.home)) {
      if (!session.running) {
        if (abandoned.has(session.dir)) continue;
        // A folder that cannot be removed is let go of, not retried every poll.
        await removeSession(session.dir).catch(async (error: Error) => {
          abandoned.add(session.dir);
          await log(`could not remove ${session.dir}: ${error.message}`);
        });
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
    const created = await listCreated(options.home).catch(async (error) => {
      await log(`error agents index: ${String(error)}`);
      return [] as CreatedAgent[];
    });
    // One created since the last pass (POST /run's are announced as they finish).
    const keys = new Set(created.map(createdKey));
    if (announced === undefined) announced = new Set(keys);
    else {
      for (const k of listed) if (!keys.has(k)) announced.delete(k);
      for (const c of created)
        if (!announced.has(createdKey(c))) await announce(c);
    }
    listed = keys;
    await rewatch(running, created);
    for (const session of running) {
      // Shutdown finishes the swap in flight, not the ones after it.
      if (stopping) return;
      await record(session, await refreshSession(io, session));
    }
    for (const c of reached(created, scope)) {
      if (stopping) return;
      await agents.sync(c.project, c.name);
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

  /** Runs a `POST /run` or a bridge's `/v1/run`: logged, and an agent it creates announced. */
  const runAndAnnounce: typeof runInProcess = async (
    runIo,
    argv,
    cwd,
    lines,
  ) => {
    // An answer's value is the user's: never in the log.
    await log(
      `run ${JSON.stringify(redactAnswers(argv))} in ${JSON.stringify(cwd)}`,
    );
    const result = await runInProcess(runIo, argv, cwd, lines);
    const created = result.exitCode === 0 && agentCreated(argv, cwd);
    // Unless the pass the index change started has announced it already.
    if (created && !announced?.has(createdKey(created)))
      await announce(created);
    return result;
  };

  /** The loopback bridge for the UI (spec 26 §2), while one is open. */
  let bridge: Bridge | undefined;
  let opening: Promise<Bridge> | undefined;
  const shuttingDown = () => new CliError("stopping", "the daemon is stopping");
  const openUi = (port: number | undefined): Promise<Bridge> => {
    // One closing (idle) is not handed out again: a code for it would die with it.
    if (bridge && !bridge.closing) return Promise.resolve(bridge);
    // Shutdown may have begun while the request read the config: open nothing to outlive it.
    if (stopping) return Promise.reject(shuttingDown());
    opening ??= openBridge({
      home: options.home,
      io,
      runInProcess: runAndAnnounce,
      now,
      events: (on) => {
        followers.add(on);
        return () => followers.delete(on);
      },
      ...(port !== undefined && { port }),
      ...options.bridge,
      log,
    })
      .then(async (opened) => {
        // Opened while shutdown passed its bridge close: close this one too.
        if (stopping) {
          await opened.close("daemon-stopping");
          throw shuttingDown();
        }
        bridge = opened;
        await log(`ui open on 127.0.0.1:${opened.port}`);
        void opened.closed.then(() => {
          if (bridge === opened) bridge = undefined;
        });
        return opened;
      })
      .finally(() => (opening = undefined));
    return opening;
  };

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
        await refreshAll();
        return send(res, 200, await status());
      }
      if (route === "POST /run") {
        const text = await readBody(req);
        if (text === undefined) {
          return send(res, 413, failure("too-large", "the body is over 1 MiB"));
        }
        const run = await runRequest(text);
        if (typeof run === "string") {
          return send(res, 400, failure("bad-request", run));
        }
        if (!allowedRun(run.argv)) {
          return send(
            res,
            403,
            failure(
              "not-allowed",
              `not a command the socket runs: ${run.argv.join(" ")}`,
            ),
          );
        }
        return send(res, 200, await runAndAnnounce(io, run.argv, run.cwd));
      }
      if (route === "POST /ui/open") {
        const text = await readBody(req);
        if (text === undefined) {
          return send(res, 413, failure("too-large", "the body is over 1 MiB"));
        }
        const open = uiOpenRequest(text);
        if (typeof open === "string") {
          return send(res, 400, failure("bad-request", open));
        }
        if (stopping) {
          return send(res, 503, failure("stopping", "the daemon is stopping"));
        }
        try {
          const config = await loadConfig(options.home, io.env, io.passwdHome);
          if (config.daemon?.ui === false) {
            return send(
              res,
              403,
              failure("ui-disabled", "the UI is turned off in config.yaml", {
                file: join(options.home, "config.yaml"),
                fix: "remove daemon.ui: false from config.yaml",
              }),
            );
          }
          const opened = await openUi(open.port);
          return send(res, 200, { port: opened.port, code: opened.code() });
        } catch (error) {
          const known = errorEnvelope(error);
          if (known === undefined) throw error;
          return send(
            res,
            known.code === "stopping" ? 503 : 400,
            failure(known.code, known.message, known.details),
          );
        }
      }
      if (route === "GET /agents") {
        return send(res, 200, { agents: await agents.list() });
      }
      if (route === "POST /agents/run" || route === "POST /agents/stop") {
        const text = await readBody(req);
        if (text === undefined) {
          return send(res, 413, failure("too-large", "the body is over 1 MiB"));
        }
        const target = agentRequest(text);
        if (typeof target === "string") {
          return send(res, 400, failure("bad-request", target));
        }
        try {
          return send(
            res,
            200,
            route === "POST /agents/run"
              ? await agents.run(
                  target.project,
                  target.name,
                  target.env && { env: target.env },
                )
              : {
                  agent: target.name,
                  ...(await agents.stop(target.project, target.name)),
                },
          );
        } catch (error) {
          const known = errorEnvelope(error);
          if (known === undefined) throw error;
          return send(
            res,
            400,
            failure(known.code, known.message, known.details),
          );
        }
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
      // The UI's listener first: no new runs start from it.
      await opening?.catch(() => undefined);
      await bridge?.close("daemon-stopping");
      watcher?.close();
      // Finish the swap in flight: a session is never left half-swapped.
      while (inFlight || queued) await (queued ?? inFlight);
      // Agents are this daemon's children: none outlives it.
      await agents.closeAll();
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
      await releaseLock(paths.lock);
      await log("stopped");
      markClosed();
    })());

  // A daemon whose lock was removed by hand still answers: leave it, and release only our lock.
  if (await answers(paths.sock)) {
    clearInterval(poll);
    await releaseLock(paths.lock);
    throw running(paths.lock);
  }
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
    await releaseLock(paths.lock);
    throw error;
  }
  await log(`started ${options.version} pid ${process.pid} on ${paths.sock}`);
  // The first pass: learn the sessions, start watching, catch up on edits made while stopped.
  await refreshAll();

  return {
    socket: paths.sock,
    token,
    startedAt,
    refresh: refreshAll,
    close,
    closed,
  };
}
