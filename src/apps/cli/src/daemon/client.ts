import type { Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { request } from "node:http";
import { CliError } from "../errors.js";
import { currentUid, daemonPaths } from "./paths.js";

// A client of a home's daemon, over its socket with its token. See docs/planning/14-daemon.md §4.

export type SessionState = "current" | "refreshed" | "stale" | "refresh-failed";

export interface SessionStatus {
  dir: string;
  harness: "claude-code" | "codex";
  project?: string;
  /** The persona the session launched with. */
  launched: string;
  /** The persona swapped in since, when there was a swap. */
  live?: string;
  startedAt?: string;
  /** What a relaunch would change that a swap cannot: mcp, permissions, settings. */
  held: string[];
  state: SessionState;
  /** When the state was reached. */
  at?: string;
  error?: string;
}

export interface DaemonStatus {
  version: string;
  pid: number;
  startedAt: string;
  /** Whether this daemon runs under the login service (`DONN_SERVICE=1`). */
  service: boolean;
  watching: string[];
  sessions: SessionStatus[];
}

export type DaemonEventType =
  | "session.added"
  | "session.ended"
  | "session.refreshed"
  | "session.stale"
  | "session.refresh-failed"
  | "daemon.stopping";

export interface DaemonEvent {
  type: DaemonEventType;
  [key: string]: unknown;
}

export interface DaemonClient {
  /** The status the connecting probe returned: no second request needed to show it. */
  probed: DaemonStatus;
  status(): Promise<DaemonStatus>;
  refresh(): Promise<void>;
  shutdown(): Promise<void>;
  /** Follow `GET /events`; returns a function that stops following. */
  events(on: (e: DaemonEvent) => void): () => void;
}

const PROBE_TIMEOUT_MS = 500;
/** A call after the probe: a daemon that wedges must not hang the CLI. */
const CALL_TIMEOUT_MS = 5_000;

export interface DaemonResponse {
  status: number;
  body: unknown;
}

/** One request to the daemon at `socket`, with `body` sent as JSON; the answer is parsed JSON. */
export function daemonRequest(
  socket: string,
  token: string | undefined,
  method: string,
  path: string,
  timeoutMs?: number,
  body?: unknown,
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        method,
        path,
        headers: {
          ...(token !== undefined && { authorization: `Bearer ${token}` }),
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(timeoutMs !== undefined && { timeout: timeoutMs }),
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
          } catch (error) {
            reject(error as Error);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** The socket a home's daemon listens on: `where` when present, else `<home>/daemon/sock`. */
export async function daemonSocket(home: string): Promise<string> {
  const paths = daemonPaths(home);
  const where = await readFile(paths.where, "utf8").catch(() => undefined);
  return where?.trim() || paths.sock;
}

/** Whether a socket's `lstat` shows a socket the user owns: only one gets the token. */
export const ownSocket = (
  stats: Pick<Stats, "uid" | "isSocket"> | undefined,
  uid = currentUid(),
): boolean => stats !== undefined && stats.isSocket() && stats.uid === uid;

/** The body of a successful response; an error response becomes a CliError with its code. */
function ok(res: DaemonResponse): unknown {
  if (res.status >= 200 && res.status < 300) return res.body;
  const error = (res.body as { error?: { code?: string; message?: string } })
    .error;
  throw new CliError(
    error?.code ?? "daemon",
    `daemon: ${error?.message ?? `HTTP ${res.status}`}`,
  );
}

/** How a daemon is restarted when no installed service runs it. */
export const RESTART = "donn daemon stop && donn daemon start";

/** The copy for a daemon that runs another version than this CLI; `fix` says what to run. */
export const versionMismatch = (daemon: string, cli: string, fix = RESTART) =>
  `daemon runs ${daemon}, CLI is ${cli}; ${fix}`;

export interface ConnectOptions {
  /** This CLI's version: a daemon that runs another is reported once, through `warn`. */
  version?: string;
  warn?: (message: string) => void;
  /**
   * What the version warning tells the user to run, asked only on a mismatch: an installed
   * service is updated by `daemon install`. A restart by default.
   */
  fix?: () => Promise<string>;
  /** The user the socket must belong to; this process's. */
  uid?: number;
  /** Reads the token file; injected in tests. */
  readToken?: () => Promise<string | undefined>;
}

const REFUSED = `daemon: it refused this CLI's token; ${RESTART}`;

/** A client of the home's daemon, or undefined when no socket answers within 500 ms. */
export async function connectDaemon(
  home: string,
  options: ConnectOptions = {},
): Promise<DaemonClient | undefined> {
  // The socket and token are read on every call: a daemon restarted in the same home has a new token.
  // A socket that is not the user's own is someone else's listener: no token goes to it.
  const target = async () => {
    const socket = await daemonSocket(home);
    const stats = await lstat(socket).catch(() => undefined);
    if (!ownSocket(stats, options.uid)) return { socket, token: undefined };
    const token = await (
      options.readToken ??
      (() => readFile(daemonPaths(home).token, "utf8").catch(() => undefined))
    )();
    return { socket, token: token?.trim() };
  };
  const call = async (method: string, path: string, timeoutMs: number) => {
    // A refusal is retried once with the token read again: the daemon may have restarted between
    // the read and the request.
    for (let attempt = 0; ; attempt++) {
      const { socket, token } = await target();
      if (token === undefined) {
        throw new CliError("daemon", "daemon: not running");
      }
      const res = await daemonRequest(socket, token, method, path, timeoutMs);
      if (res.status !== 401) return ok(res);
      if (attempt > 0) throw new CliError("daemon-unauthorized", REFUSED);
    }
  };
  const probe = await target();
  if (probe.token === undefined) return undefined;
  // Not answering means not running; refusing the token is a daemon that runs.
  const first = await call("GET", "/status", PROBE_TIMEOUT_MS).catch(
    (error: unknown) => {
      if (error instanceof CliError && error.code === "daemon-unauthorized")
        throw error;
      return undefined;
    },
  );
  if (first === undefined) return undefined;
  const probed = first as DaemonStatus;
  const running = probed.version;
  if (options.version !== undefined && running !== options.version) {
    const fix = options.fix && (await options.fix().catch(() => undefined));
    options.warn?.(versionMismatch(running, options.version, fix));
  }
  return {
    probed,
    status: async () =>
      (await call("GET", "/status", CALL_TIMEOUT_MS)) as DaemonStatus,
    refresh: async () => void (await call("POST", "/refresh", CALL_TIMEOUT_MS)),
    shutdown: async () =>
      void (await call("POST", "/shutdown", CALL_TIMEOUT_MS)),
    events: (on) => {
      const req = request(
        {
          socketPath: probe.socket,
          method: "GET",
          path: "/events",
          headers: { authorization: `Bearer ${probe.token}` },
        },
        (res) => {
          let buffer = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buffer += chunk;
            // Server-sent events: blank-line separated, the JSON in `data:` lines.
            let end;
            while ((end = buffer.indexOf("\n\n")) !== -1) {
              const data = buffer
                .slice(0, end)
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim())
                .join("\n");
              buffer = buffer.slice(end + 2);
              if (data) on(JSON.parse(data) as DaemonEvent);
            }
          });
        },
      );
      req.on("error", () => {});
      req.end();
      return () => req.destroy();
    },
  };
}
