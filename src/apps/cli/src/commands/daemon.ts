import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isAlive } from "@zzpersona/executor";
import type { CliIo } from "../cli.js";
import { homeOf } from "../context.js";
import { connectDaemon } from "../daemon/client.js";
import { daemonPaths } from "../daemon/paths.js";
import { startDaemon } from "../daemon/server.js";
import { CliError } from "../errors.js";

// zzpersona daemon run|start|stop|status: the daemon's lifecycle. `run` is the daemon in the
// foreground; `start` spawns it detached. See docs/planning/14-daemon.md §1.

export interface DaemonCommandOptions {
  json?: boolean;
}

const WAIT_MS = 5_000;
const POLL_MS = 25;

/** This CLI's version, from its package.json (src/ and dist/ sit side by side). */
export function cliVersion(): string {
  return (
    createRequire(import.meta.url)("../../package.json") as { version: string }
  ).version;
}

/** Spawn `zzpersona daemon run` detached, its output appended to daemon.log. */
async function spawnDetached(io: CliIo, home: string): Promise<void> {
  const paths = daemonPaths(home);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const out = openSync(paths.log, "a", 0o600);
  try {
    const bin = fileURLToPath(new URL("../bin.js", import.meta.url));
    spawn(process.execPath, [bin, "daemon", "run"], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...io.env, ZZPERSONA_HOME: home },
    }).unref();
  } finally {
    closeSync(out);
  }
}

/** Poll until `done` holds or the wait runs out. */
async function waitUntil(done: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (await done()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return false;
}

export async function daemonRun(
  io: CliIo,
  options: DaemonCommandOptions,
): Promise<number> {
  const home = homeOf(io);
  const daemon = await startDaemon({
    home,
    env: io.env,
    version: cliVersion(),
    ...(io.now && { now: io.now }),
  });
  const stop = () => void daemon.close();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  io.stdout.write(
    options.json
      ? `${JSON.stringify({ running: true, pid: process.pid, socket: daemon.socket })}\n`
      : `daemon running (pid ${process.pid}) on ${daemon.socket}\n`,
  );
  await daemon.closed;
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  return 0;
}

export async function daemonStart(
  io: CliIo,
  options: DaemonCommandOptions,
): Promise<number> {
  const home = homeOf(io);
  const running = await connectDaemon(home);
  if (running) {
    const status = await running.status();
    io.stdout.write(
      options.json
        ? `${JSON.stringify({ running: true, already: true, pid: status.pid, version: status.version }, null, 2)}\n`
        : `already running (pid ${status.pid})\n`,
    );
    return 0;
  }
  await (io.spawnDaemon ?? ((h) => spawnDetached(io, h)))(home);
  let client: Awaited<ReturnType<typeof connectDaemon>>;
  const up = await waitUntil(
    async () => (client = await connectDaemon(home)) !== undefined,
  );
  if (!up || !client) {
    const log = daemonPaths(home).log;
    throw new CliError("daemon-start", `the daemon did not start; see ${log}`, {
      log,
    });
  }
  const status = await client.status();
  io.stdout.write(
    options.json
      ? `${JSON.stringify({ running: true, already: false, pid: status.pid, version: status.version }, null, 2)}\n`
      : `daemon started (pid ${status.pid})\n`,
  );
  return 0;
}

export async function daemonStop(
  io: CliIo,
  options: DaemonCommandOptions,
): Promise<number> {
  const home = homeOf(io);
  const paths = daemonPaths(home);
  const client = await connectDaemon(home);
  let stopped = false;
  if (client) {
    await client.shutdown();
    stopped = true;
  } else {
    // No answer on the socket: a daemon that still runs gets SIGTERM by its pid.
    const pid = Number.parseInt(
      await readFile(paths.pid, "utf8").catch(() => ""),
      10,
    );
    if (pid > 0 && pid !== process.pid && isAlive(pid)) {
      process.kill(pid, "SIGTERM");
      stopped = true;
    }
  }
  if (stopped) {
    const gone = await waitUntil(
      async () => (await connectDaemon(home)) === undefined,
    );
    if (!gone) {
      throw new CliError("daemon-stop", "the daemon did not stop", {
        pid: paths.pid,
      });
    }
  }
  io.stdout.write(
    options.json
      ? `${JSON.stringify({ running: false, stopped }, null, 2)}\n`
      : stopped
        ? "daemon stopped\n"
        : "daemon not running\n",
  );
  return 0;
}

const uptime = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

export async function daemonStatus(
  io: CliIo,
  options: DaemonCommandOptions,
): Promise<number> {
  const client = await connectDaemon(homeOf(io));
  if (!client) {
    io.stdout.write(
      options.json
        ? `${JSON.stringify({ running: false }, null, 2)}\n`
        : "daemon not running\n",
    );
    return 0;
  }
  const status = await client.status();
  const up = (io.now ?? Date.now)() - Date.parse(status.startedAt);
  if (options.json) {
    io.stdout.write(
      `${JSON.stringify(
        {
          running: true,
          version: status.version,
          pid: status.pid,
          startedAt: status.startedAt,
          uptimeMs: up,
          sessions: status.sessions.length,
          watching: status.watching,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  const count = status.sessions.length;
  io.stdout.write(
    `daemon running: pid ${status.pid}, version ${status.version}, up ${uptime(up)}, ${count} session${count === 1 ? "" : "s"} watched\n`,
  );
  return 0;
}
