import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isAlive } from "@zzpersona/executor";
import type { CliIo } from "../cli.js";
import { homeOf } from "../context.js";
import { connectDaemon } from "../daemon/client.js";
import { daemonPaths } from "../daemon/paths.js";
import { isDaemonProcess } from "../daemon/process.js";
import { startDaemon } from "../daemon/server.js";
import {
  installedService,
  absoluteHome,
  serviceFor,
  serviceHome,
  serviceOf,
  type ServiceManager,
} from "../daemon/service.js";
import { CliError } from "../errors.js";
import { CLI_ON_PATH_FIX, findOnPath } from "../path.js";
import { NOT_RUNNING } from "./status.js";

// zzpersona daemon run|start|stop|status: the daemon's lifecycle. `run` is the daemon in the
// foreground; `start` spawns it detached, or starts the login service when it is installed;
// `install` and `uninstall` manage that service. See docs/planning/14-daemon.md §1 and
// 16-daemon-service.md §1.

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
      // Not the caller's folder: the daemon must not hold a directory the user may remove.
      cwd: home,
      stdio: ["ignore", out, out],
      env: { ...io.env, ZZPERSONA_HOME: home },
    }).unref();
  } finally {
    closeSync(out);
  }
}

/**
 * Start a daemon for `home` without waiting for it: through the service manager when its file
 * is installed, else detached.
 */
export async function startDaemonProcess(
  io: CliIo,
  home: string,
): Promise<void> {
  // The service only for the home it serves: another home's daemon would never answer here.
  const service = await serviceFor(io, home);
  if (service) {
    await service.manager.start();
    return;
  }
  await (io.spawnDaemon ?? ((h) => spawnDetached(io, h)))(home);
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
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  try {
    daemon = await startDaemon({
      home,
      env: io.env,
      version: cliVersion(),
      probe: io.probe,
      ...(io.now && { now: io.now }),
    });
  } catch (error) {
    // Under the service "already running" is success, or the manager would restart it in a loop.
    if (
      error instanceof CliError &&
      error.code === "daemon-running" &&
      io.env.ZZPERSONA_SERVICE === "1"
    ) {
      io.stdout.write(
        options.json
          ? `${JSON.stringify({ running: true, already: true })}\n`
          : "already running\n",
      );
      return 0;
    }
    throw error;
  }
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
  await startDaemonProcess(io, home);
  const status = await waitForDaemon(home);
  io.stdout.write(
    options.json
      ? `${JSON.stringify({ running: true, already: false, pid: status.pid, version: status.version }, null, 2)}\n`
      : `daemon started (pid ${status.pid})\n`,
  );
  return 0;
}

/** Wait until `home`'s daemon answers, and return its status. */
async function waitForDaemon(home: string) {
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
  return client.status();
}

/** Stop `home`'s daemon, if one runs; whether one was stopped. */
async function stopDaemon(home: string): Promise<boolean> {
  const paths = daemonPaths(home);
  // A daemon that refuses this CLI's token is stopped by pid, like one that does not answer.
  const client = await connectDaemon(home).catch((error: unknown) => {
    if (error instanceof CliError && error.code === "daemon-unauthorized")
      return undefined;
    throw error;
  });
  const pid = Number.parseInt(
    await readFile(paths.pid, "utf8").catch(() => ""),
    10,
  );
  // The pid only counts when it is another process (tests run the daemon in-process).
  const other = pid > 0 && pid !== process.pid;
  let stopped = false;
  let gone: () => boolean;
  if (client) {
    await client.shutdown();
    stopped = true;
    // Stopped once the lock is released (the daemon's last step) or its process is gone.
    gone = () => !existsSync(paths.lock) || (other && !isAlive(pid));
  } else {
    // No answer on the socket: a daemon that still runs gets SIGTERM by its pid; a process that
    // is not one (the OS reused a dead daemon's pid) is left alone.
    if (other && isDaemonProcess(pid)) {
      process.kill(pid, "SIGTERM");
      stopped = true;
    }
    gone = () => !isAlive(pid);
  }
  if (stopped && !(await waitUntil(async () => gone()))) {
    throw new CliError(
      "daemon-stop",
      `the daemon (pid ${pid}) did not stop; kill ${pid}`,
      { pid },
    );
  }
  return stopped;
}

export async function daemonStop(
  io: CliIo,
  options: DaemonCommandOptions,
): Promise<number> {
  const stopped = await stopDaemon(homeOf(io));
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

/** The service manager, or the refusal where there is none. */
function requireService(io: CliIo): ServiceManager {
  const service = serviceOf(io);
  if (service) return service;
  throw new CliError(
    "service-unsupported",
    io.probe.platform === "win32"
      ? "the daemon service is not supported on Windows yet"
      : "the daemon service needs HOME to be set",
  );
}

export async function daemonInstall(
  io: CliIo,
  options: DaemonCommandOptions,
): Promise<number> {
  const service = requireService(io);
  const cli = findOnPath("zzpersona", io.env);
  if (!cli) {
    throw new CliError(
      "cli-not-on-path",
      `zzpersona is not on PATH, so the service cannot run it; ${CLI_ON_PATH_FIX}`,
    );
  }
  // Absolute: the service manager runs the daemon from another folder.
  const home = absoluteHome(io, homeOf(io));
  // A daemon started outside the service would hold the lock, and the service's would exit.
  await stopDaemon(home);
  const paths = daemonPaths(home);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  await service.install({
    command: [cli, "daemon", "run"],
    env: {
      PATH: io.env.PATH ?? "",
      ...(io.env.ZZPERSONA_HOME && { ZZPERSONA_HOME: home }),
      ZZPERSONA_SERVICE: "1",
    },
    log: paths.log,
  });
  const status = await waitForDaemon(home);
  io.stdout.write(
    options.json
      ? `${JSON.stringify({ installed: true, path: service.path, command: cli, pid: status.pid }, null, 2)}\n`
      : `service installed (${service.path}); daemon running (pid ${status.pid})\n`,
  );
  return 0;
}

export async function daemonUninstall(
  io: CliIo,
  options: DaemonCommandOptions,
): Promise<number> {
  const service = requireService(io);
  const installed = existsSync(service.path);
  if (installed) await service.uninstall();
  io.stdout.write(
    options.json
      ? `${JSON.stringify({ installed: false, removed: installed, path: service.path }, null, 2)}\n`
      : installed
        ? `service uninstalled (${service.path})\n`
        : "not installed\n",
  );
  return 0;
}

export async function daemonStatus(
  io: CliIo,
  options: DaemonCommandOptions,
): Promise<number> {
  const home = homeOf(io);
  const client = await connectDaemon(home);
  const status = client && (await client.status());
  // Where the platform has no service manager, status says nothing about one.
  const manager = serviceOf(io);
  const file = manager && (await installedService(manager));
  // The home the service serves, which may be another than this one.
  const served = file && serviceHome(io, file);
  const service = manager && {
    installed: file !== undefined,
    path: manager.path,
    ...(served !== undefined && { home: served }),
    managed: status?.service === true,
  };
  const serviceLine = !manager
    ? ""
    : !file
      ? "service: not installed\n"
      : `service: installed (${manager.path})${
          served !== absoluteHome(io, home)
            ? ` for ${served}`
            : !status
              ? ""
              : status.service
                ? "; the daemon runs under it"
                : "; the running daemon was started outside it"
        }\n`;
  if (!status) {
    io.stdout.write(
      options.json
        ? `${JSON.stringify({ running: false, ...(service && { service }) }, null, 2)}\n`
        : `daemon not running\n${serviceLine}`,
    );
    return 0;
  }
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
          ...(service && { service }),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  const count = status.sessions.length;
  io.stdout.write(
    `daemon running: pid ${status.pid}, version ${status.version}, up ${uptime(up)}, ${count} session${count === 1 ? "" : "s"} watched\n${serviceLine}`,
  );
  return 0;
}

export async function daemonRefresh(
  io: CliIo,
  options: DaemonCommandOptions,
): Promise<number> {
  const client = await connectDaemon(homeOf(io), {
    version: cliVersion(),
    warn: (message) => io.stderr.write(`${message}\n`),
  });
  if (client) await client.refresh();
  io.stdout.write(
    options.json
      ? `${JSON.stringify({ running: client !== undefined, refreshed: client !== undefined }, null, 2)}\n`
      : client
        ? "refreshed\n"
        : `${NOT_RUNNING}\n`,
  );
  return 0;
}
