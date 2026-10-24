import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../errors.js";

// Where a home's daemon keeps its files. See docs/planning/14-daemon.md §1.

/** macOS caps a socket path at 104 bytes, the terminating NUL included. */
const MAX_SOCKET_BYTES = 103;

/** This process's user id; -1 where there is none (never matches a file's owner). */
export const currentUid = () => process.getuid?.() ?? -1;

export interface DaemonPaths {
  dir: string;
  /**
   * The socket: `<dir>/sock`, or for a long home a short path in a folder of the user's own:
   * `$XDG_RUNTIME_DIR`, else `<tmpdir>/donnd-<uid>` (see `privateSocketDir`).
   */
  sock: string;
  token: string;
  pid: string;
  lock: string;
  log: string;
  /** Names the socket when it is not `<dir>/sock`. */
  where: string;
}

export function daemonPaths(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): DaemonPaths {
  const dir = join(home, "daemon");
  const inHome = join(dir, "sock");
  const short = `donnd-${createHash("sha256").update(home).digest("hex").slice(0, 8)}.sock`;
  // A shared temp directory (Linux's /tmp) is anyone's: never a bare name in it.
  const runtime =
    env.XDG_RUNTIME_DIR || join(tmpdir(), `donnd-${currentUid()}`);
  return {
    dir,
    sock:
      Buffer.byteLength(inHome) > MAX_SOCKET_BYTES
        ? join(runtime, short)
        : inHome,
    token: join(dir, "token"),
    pid: join(dir, "pid"),
    lock: join(dir, "daemon.lock"),
    log: join(dir, "daemon.log"),
    where: join(dir, "where"),
  };
}

/**
 * Create the folder for a fallback socket, or check the one there: it must be a real directory
 * (not a symlink), owned by `uid`, mode 0700, or another user could take or answer on the socket.
 */
export async function privateSocketDir(
  dir: string,
  uid = currentUid(),
): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stats = await lstat(dir);
  if (
    !stats.isDirectory() ||
    stats.uid !== uid ||
    (stats.mode & 0o777) !== 0o700
  ) {
    throw new CliError(
      "daemon-socket-dir",
      `refusing the socket folder ${dir}: it must be a directory of your own with mode 0700`,
      { dir },
    );
  }
}
