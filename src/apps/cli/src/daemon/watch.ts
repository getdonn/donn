import { statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";

// The daemon's file watching: one debounced callback for a set of paths. See
// docs/planning/14-daemon.md §3.

export interface Watch {
  close(): void;
  /** The paths asked for, in order: what `GET /status` reports as `watching`. */
  paths: string[];
}

const isDir = (path: string) =>
  statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

/** What a watch set looks like on disk now: it changes when a watched path appears or goes. */
export const watchKey = (paths: string[]) =>
  paths.map((p) => `${isDir(p) ? "d" : "f"}:${p}`).join("\n");

/**
 * Call `onChange` once `debounceMs` pass after the last change under `paths`. A folder is watched
 * recursively; a file, or a path that does not exist yet, through its parent folder filtered by
 * name, so an editor's atomic rename and the path's creation are both seen. `accept` filters
 * changes by absolute path. A watcher that fails counts as a change: the caller recomputes.
 */
export function watchSources(
  paths: string[],
  onChange: () => void,
  debounceMs: number,
  accept: (path: string) => boolean = () => true,
): Watch {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const watchers: FSWatcher[] = [];
  const changed = (path: string | undefined) => {
    if (closed || (path !== undefined && !accept(path))) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
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

  return {
    paths,
    close() {
      closed = true;
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    },
  };
}
