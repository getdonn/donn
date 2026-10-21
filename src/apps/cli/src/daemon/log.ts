import { appendFile, rename, stat } from "node:fs/promises";

// The daemon's log: one timestamped line per event, rotated to `daemon.log.1` past 1 MiB.
// Lines carry persona refs and paths, never secret values. See docs/planning/14-daemon.md §1.

const MAX_BYTES = 1024 * 1024;

export interface DaemonLog {
  (line: string): Promise<void>;
}

export function createLog(path: string, now: () => number): DaemonLog {
  let tail: Promise<void> = Promise.resolve();
  return (line) => {
    // Chained so concurrent lines never race the rotation.
    tail = tail
      .then(async () => {
        const size = await stat(path).then(
          (s) => s.size,
          () => 0,
        );
        if (size > MAX_BYTES) await rename(path, `${path}.1`);
        await appendFile(path, `${new Date(now()).toISOString()} ${line}\n`, {
          mode: 0o600,
        });
      })
      .catch(() => {});
    return tail;
  };
}
