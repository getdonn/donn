import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { isAlive } from "@zzpersona/executor";
import { CliError } from "../errors.js";
import { writeFileAtomic } from "../fs.js";
import { listSessions } from "../session.js";
import type { DaemonStatus, SessionStatus } from "./client.js";
import { createLog } from "./log.js";
import { daemonPaths } from "./paths.js";

// The daemon: HTTP/1.1 with JSON bodies over a unix socket, a bearer token on every request.
// One per home, held by `daemon.lock`. See docs/planning/14-daemon.md §1 and §4.

export interface DaemonOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  version: string;
  /** Quiet period after the last file event before a refresh; 300 ms. */
  debounceMs?: number;
  now?: () => number;
}

export interface Daemon {
  socket: string;
  token: string;
  startedAt: string;
  refresh(): Promise<void>;
  /** Stop serving and remove `sock`, `pid`, `where` and the lock. Safe to call twice. */
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

const failure = (code: string, message: string) => ({
  error: { code, message },
});

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const now = options.now ?? Date.now;
  const paths = daemonPaths(options.home);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await chmod(paths.dir, 0o700);
  await acquireLock(paths.lock);

  const log = createLog(paths.log, now);
  const token = randomBytes(32).toString("hex");
  const startedAt = new Date(now()).toISOString();

  const status = async (): Promise<DaemonStatus> => ({
    version: options.version,
    pid: process.pid,
    startedAt,
    watching: [],
    sessions: (await listSessions(options.home))
      .filter((s) => s.running)
      .map((s): SessionStatus => ({
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
        held: s.live?.held ?? [],
        state: "current",
      })),
  });

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
      await log("stopping");
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await Promise.all(
        [paths.sock, paths.pid, paths.where, paths.lock].map((p) =>
          rm(p, { force: true }),
        ),
      );
      await log("stopped");
      markClosed();
    })());

  try {
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
    if (paths.sock !== join(paths.dir, "sock")) {
      await writeFileAtomic(paths.where, `${paths.sock}\n`, 0o600);
    }
    await writeFileAtomic(paths.pid, `${process.pid}\n`, 0o600);
  } catch (error) {
    server.close();
    await rm(paths.lock, { force: true });
    throw error;
  }
  await log(`started ${options.version} pid ${process.pid} on ${paths.sock}`);

  return {
    socket: paths.sock,
    token,
    startedAt,
    // Watching and refresh arrive with the watcher (spec 14 §3).
    refresh: async () => {},
    close,
    closed,
  };
}
