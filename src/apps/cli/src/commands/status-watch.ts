import { watch, type FSWatcher } from "node:fs";
import type { CliIo } from "../cli.js";
import { homeOf } from "../context.js";
import { connectDaemon, type DaemonClient } from "../daemon/client.js";
import { statusSnapshot } from "./status.js";

// donn status --watch --json: the `status --json` object as one line, at once, after each daemon
// event and each change to state.json. See docs/planning/28-desktop.md §1.

export interface WatchOptions {
  /** Quiet period after a change before a line; 250 ms. */
  debounceMs?: number;
  /** How often a daemon that is not running is looked for; 5 s. */
  pollMs?: number;
}

export const WATCH_NEEDS_JSON = "--watch prints JSON lines; add --json";

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

const epipe = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === "EPIPE";

/**
 * Prints lines until `io.signal` aborts (SIGINT or SIGTERM by default) or stdout closes; 0 then.
 * It never starts the daemon.
 */
export async function watchStatus(
  io: CliIo,
  options: WatchOptions = {},
): Promise<number> {
  const debounceMs = options.debounceMs ?? 250;
  const pollMs = options.pollMs ?? 5_000;
  const home = homeOf(io);
  // A warning (a daemon of another version) is said once, not with every line.
  const said = new Set<string>();
  const snapshotIo: CliIo = {
    ...io,
    stderr: {
      write: (text) => {
        if (said.has(text)) return true;
        said.add(text);
        return io.stderr.write(text);
      },
    },
  };

  let stopped = false;
  let debounce: NodeJS.Timeout | undefined;
  let ticker: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;
  let unfollow: (() => void) | undefined;
  /** Whether a daemon's events are followed; bumped per stream, so a late end is ignored. */
  let following = false;
  let stream = 0;

  // Ctrl-C and SIGTERM are ours only while we watch; a closed stdout ends it too.
  const own = io.signal === undefined ? new AbortController() : undefined;
  const signal = io.signal ?? own!.signal;
  const onSignal = () => own?.abort();
  const out = io.stdout as Partial<NodeJS.EventEmitter>;
  const onOutError = (error: unknown) =>
    finish(epipe(error) ? undefined : error);

  let settle!: (error?: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    settle = (error) => (error === undefined ? resolve() : reject(error));
  });
  function finish(error?: unknown) {
    if (stopped) return;
    stopped = true;
    clearTimeout(debounce);
    clearTimeout(ticker);
    unfollow?.();
    watcher?.close();
    signal.removeEventListener("abort", onAbort);
    if (own) for (const s of SIGNALS) process.off(s, onSignal);
    out.off?.("error", onOutError);
    settle(error);
  }
  const onAbort = () => finish();

  // One line at a time, in order; a line equal to the last is not printed again.
  let last: string | undefined;
  let chain = Promise.resolve();
  const print = (daemon: boolean) =>
    (chain = chain
      .then(async () => {
        if (stopped) return;
        const text = JSON.stringify(
          await statusSnapshot(snapshotIo, { daemon }),
        );
        if (stopped || text === last) return;
        last = text;
        try {
          io.stdout.write(`${text}\n`);
        } catch (error) {
          finish(epipe(error) ? undefined : error);
        }
      })
      .catch((error: unknown) => finish(error)));

  const changed = () => {
    if (stopped) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => void print(following), debounceMs);
  };

  // `donn switch` replaces state.json by rename: watch the folder, not the file.
  const arm = () => {
    if (watcher || stopped) return;
    try {
      watcher = watch(home, (_, name) => {
        if (name === null || String(name) === "state.json") changed();
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      // No home yet: armed again on the next check.
    }
  };

  /** The daemon stopped or its stream ended: say so, then look for one every `pollMs`. */
  const lost = () => {
    following = false;
    unfollow?.();
    unfollow = undefined;
    clearTimeout(debounce);
    void print(false);
    later();
  };
  const follow = (client: DaemonClient) => {
    const mine = ++stream;
    following = true;
    const end = () => {
      if (mine === stream && following) lost();
    };
    unfollow = client.events(
      (event) => (event.type === "daemon.stopping" ? end() : changed()),
      end,
    );
  };
  const later = () => {
    if (!stopped) ticker = setTimeout(() => void check(), pollMs);
  };
  /** Follow the daemon when one runs and print a line; else print one without it. */
  const check = async () => {
    arm();
    const client = await connectDaemon(home).catch(() => undefined);
    if (stopped) return;
    arm();
    if (client) follow(client);
    await print(client !== undefined);
    if (!client) later();
  };

  signal.addEventListener("abort", onAbort, { once: true });
  if (own) for (const s of SIGNALS) process.on(s, onSignal);
  out.on?.("error", onOutError);
  if (signal.aborted) finish();
  else void check();
  try {
    await done;
  } finally {
    // A snapshot still being taken finishes before the command returns.
    await chain;
  }
  return 0;
}
