import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Where a home's daemon keeps its files. See docs/planning/14-daemon.md §1.

/** macOS caps a socket path at 104 bytes, the terminating NUL included. */
const MAX_SOCKET_BYTES = 103;

export interface DaemonPaths {
  dir: string;
  /** The socket: `<dir>/sock`, or a short path under the temp directory for a long home. */
  sock: string;
  token: string;
  pid: string;
  lock: string;
  log: string;
  /** Names the socket when it is not `<dir>/sock`. */
  where: string;
}

export function daemonPaths(home: string): DaemonPaths {
  const dir = join(home, "daemon");
  const inHome = join(dir, "sock");
  const short = `zzpd-${createHash("sha256").update(home).digest("hex").slice(0, 8)}.sock`;
  return {
    dir,
    sock:
      Buffer.byteLength(inHome) > MAX_SOCKET_BYTES
        ? join(tmpdir(), short)
        : inHome,
    token: join(dir, "token"),
    pid: join(dir, "pid"),
    lock: join(dir, "daemon.lock"),
    log: join(dir, "daemon.log"),
    where: join(dir, "where"),
  };
}
