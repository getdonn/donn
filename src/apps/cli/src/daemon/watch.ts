import { statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";

// The daemon's file watching: one debounced callback for a set of paths. See
// docs/planning/14-daemon.md §3.

export interface Watch {
  close(): void;
  /** The paths asked for, in order: what `GET /status` reports as `watching`. */
  paths: string[];
  /**
   * Settles once the watchers are taken to be live. `fs.watch` can arm asynchronously (FSEvents on
   * macOS): a change made in the first moments after it returns can go unseen, so whoever reads
   * the sources reads them again once this settles.
   */
  settled: Promise<void>;
}

let openWatchers = 0;

/**
 * How long after arming the watchers are taken to be live. Under heavy load on macOS a change
 * made up to ~10 ms after `fs.watch` returned was missed in about half of tries, never one made
 * 50 ms after; a second is a wide margin.
 */
const SETTLE_MS = 1_000;

/** Test-only: the folder watchers open in this process, to show none outlives `close()`. */
export const openWatcherCount = () => openWatchers;

const isDir = (path: string) =>
  statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

/** What a watch set looks like on disk now: it changes when a watched path appears or goes. */
export const watchKey = (paths: string[]) =>
  paths.map((p) => `${isDir(p) ? "d" : "f"}:${p}`).join("\n");

/**
 * Call `onChange` once `debounceMs` pass after the last change under `paths`. A folder is watched
 * recursively; a file, or a path that does not exist yet, through its parent folder filtered by
 * name, so an editor's atomic rename and the path's creation are both seen. `accept` filters
 * changes by absolute path. `onChange` gets the paths changed since its last call, or undefined
 * when that is not known: a watcher that fails counts as a change, and the caller recomputes.
 */
export function watchSources(
  paths: string[],
  onChange: (changed: ReadonlySet<string> | undefined) => void,
  debounceMs: number,
  accept: (path: string) => boolean = () => true,
): Watch {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let pending: Set<string> | undefined = new Set();
  const watchers: FSWatcher[] = [];
  const fire = () => {
    const changed = pending;
    pending = new Set();
    onChange(changed);
  };
  const changed = (path: string | undefined) => {
    if (closed || (path !== undefined && !accept(path))) return;
    if (path === undefined) pending = undefined;
    else pending?.add(path);
    clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
  };
  const add = (
    dir: string,
    recursive: boolean,
    on: (name: string | null) => void,
  ) => {
    try {
      const watcher = watch(dir, { recursive }, (_event, name) => on(name));
      watcher.on("error", () => {
        watcher.close();
        changed(undefined);
      });
      watchers.push(watcher);
      openWatchers++;
    } catch {
      // Gone between the check and the watch: the next recompute sees it.
    }
  };

  const byParent = new Map<string, Set<string>>();
  for (const path of paths) {
    if (isDir(path)) {
      add(path, true, (name) =>
        changed(name === null ? undefined : join(path, name)),
      );
    } else {
      const parent = dirname(path);
      if (!byParent.has(parent)) byParent.set(parent, new Set());
      byParent.get(parent)!.add(basename(path));
    }
  }
  for (const [parent, names] of byParent) {
    if (!isDir(parent)) continue;
    add(parent, false, (name) => {
      if (name === null || names.has(name)) {
        changed(name === null ? undefined : join(parent, name));
      }
    });
  }

  let settle: NodeJS.Timeout | undefined;
  const settled = new Promise<void>((resolve) => {
    settle = setTimeout(resolve, SETTLE_MS);
    settle.unref();
  });

  return {
    paths,
    settled,
    close() {
      closed = true;
      clearTimeout(timer);
      // Closed before it settled: it never does.
      clearTimeout(settle);
      for (const watcher of watchers) watcher.close();
      openWatchers -= watchers.length;
      watchers.length = 0;
    },
  };
}
