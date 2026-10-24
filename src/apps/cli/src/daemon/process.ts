import { spawnSync } from "node:child_process";
import { isAlive } from "@getdonn/executor";

// Whether a pid is a daemon's. A pid file or lock outlives its daemon, and the OS may give the
// pid to an unrelated process: liveness alone would signal a stranger, or wait on one forever.
// See docs/planning/16-daemon-service.md, "Amendments from implementation".

/**
 * A process's command line, from `ps`; undefined on Windows or when ps cannot tell. `-ww`: a
 * long command line is never cut at a terminal's width before its `daemon run`.
 */
export function processCommand(
  pid: number,
  run: typeof spawnSync = spawnSync,
): string | undefined {
  if (process.platform === "win32") return undefined;
  const ps = run("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
  });
  // No such process is an empty answer; a ps that cannot run, or says why it failed, is none.
  if (ps.error || (ps.status !== 0 && ps.stderr.trim())) return undefined;
  return ps.stdout.trim();
}

/**
 * Whether `pid` is alive and runs `daemon run`. Where its command line cannot be read, plain
 * liveness decides.
 */
export function isDaemonProcess(
  pid: number,
  commandOf: (pid: number) => string | undefined = processCommand,
): boolean {
  if (!isAlive(pid)) return false;
  const command = commandOf(pid);
  if (command === undefined) return true;
  return /(^|\s)daemon\s+run(\s|$)/.test(command);
}
