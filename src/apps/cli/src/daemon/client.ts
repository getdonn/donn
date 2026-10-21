import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { CliError } from "../errors.js";
import { daemonPaths } from "./paths.js";

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
  status(): Promise<DaemonStatus>;
  refresh(): Promise<void>;
  shutdown(): Promise<void>;
  /** Follow `GET /events`; returns a function that stops following. */
  events(on: (e: DaemonEvent) => void): () => void;
}

const PROBE_TIMEOUT_MS = 500;

export interface DaemonResponse {
  status: number;
  body: unknown;
}

/** One request to the daemon at `socket`; the body is parsed JSON. */
export function daemonRequest(
  socket: string,
  token: string | undefined,
  method: string,
  path: string,
  timeoutMs?: number,
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        method,
        path,
        headers:
          token === undefined ? {} : { authorization: `Bearer ${token}` },
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
    req.end();
  });
}

/** The socket a home's daemon listens on: `where` when present, else `<home>/daemon/sock`. */
export async function daemonSocket(home: string): Promise<string> {
  const paths = daemonPaths(home);
  const where = await readFile(paths.where, "utf8").catch(() => undefined);
  return where?.trim() || paths.sock;
}

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

/** A client of the home's daemon, or undefined when no socket answers within 500 ms. */
export async function connectDaemon(
  home: string,
): Promise<DaemonClient | undefined> {
  const socket = await daemonSocket(home);
  const token = await readFile(daemonPaths(home).token, "utf8").catch(
    () => undefined,
  );
  if (token === undefined) return undefined;
  const call = (method: string, path: string, timeoutMs?: number) =>
    daemonRequest(socket, token.trim(), method, path, timeoutMs).then(ok);
  const first = await call("GET", "/status", PROBE_TIMEOUT_MS).catch(
    () => undefined,
  );
  if (first === undefined) return undefined;
  return {
    status: async () => (await call("GET", "/status")) as DaemonStatus,
    refresh: async () => void (await call("POST", "/refresh")),
    shutdown: async () => void (await call("POST", "/shutdown")),
    events: (on) => {
      const req = request(
        {
          socketPath: socket,
          method: "GET",
          path: "/events",
          headers: { authorization: `Bearer ${token.trim()}` },
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
