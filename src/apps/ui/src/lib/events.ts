import { createContext, useContext, useEffect, useRef, useState } from "react";

// `/v1/events` (docs/planning/26-gui.md §2): the daemon's server-sent events (spec 14's
// `session.*`, spec 25's `agent.*`, `daemon.stopping`) and the bridge's `job.*`. Read over fetch,
// since the token is a header the native EventSource cannot send. One connection, opened for the
// first subscriber, reconnected with backoff; a 401 means the session ended, and so do five
// failed connections in a row (the daemon is gone). The bridge says `ui.closing` before it closes.

export interface DaemonEvent {
  type: string;
  [key: string]: unknown;
}

/** What the bridge client and the hook need of the stream. */
export interface EventSource {
  subscribe(listener: (event: DaemonEvent) => void): () => void;
  /** Called each time the stream (re)connects; events may have been missed in between. */
  onOpen(listener: () => void): () => void;
}

export interface EventStream extends EventSource {
  close(): void;
}

export interface EventStreamOptions {
  /** The bridge's origin. */
  base: string;
  token: () => string | undefined;
  fetch?: typeof fetch;
  onUnauthorized?: () => void;
  /** Called once `maxFailures` connections in a row have failed; the stream then stops. */
  onUnreachable?: () => void;
  /** Failed connections in a row before it gives up; 5. */
  maxFailures?: number;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

const FIRST_WAIT_MS = 500;
const MAX_WAIT_MS = 10_000;
const MAX_FAILURES = 5;

/**
 * A feed for SSE text, chunk by chunk: each complete frame's `data` parsed as JSON and passed
 * on, with `event:` as its type when the data names none. Comments (`: ping`) are skipped.
 */
export function parseSse(
  on: (event: DaemonEvent) => void,
): (chunk: string) => void {
  let buffer = "";
  let type: string | undefined;
  let data: string[] = [];
  const dispatch = () => {
    if (data.length > 0) {
      try {
        const value = JSON.parse(data.join("\n")) as unknown;
        if (typeof value === "object" && value !== null) {
          const event = value as Partial<DaemonEvent>;
          const named = event.type ?? type;
          if (typeof named === "string") on({ ...event, type: named });
        }
      } catch {
        // Not JSON: not an event of ours.
      }
    }
    type = undefined;
    data = [];
  };
  return (chunk) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.search(/\r?\n/)) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + (buffer[end] === "\r" ? 2 : 1));
      if (line === "") dispatch();
      else if (line.startsWith(":")) continue;
      else {
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value =
          colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") type = value;
        else if (field === "data") data.push(value);
      }
    }
  };
}

export function createEventStream(options: EventStreamOptions): EventStream {
  const doFetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const listeners = new Set<(event: DaemonEvent) => void>();
  const opens = new Set<() => void>();
  let running = false;
  let closed = false;
  let abort: AbortController | undefined;
  let reading: ReadableStreamDefaultReader<string> | undefined;
  /** Stops the connection in flight: the request, and the body being read. */
  const stop = () => {
    abort?.abort();
    void reading?.cancel().catch(() => {});
  };

  const emit = (event: DaemonEvent) => {
    for (const listener of [...listeners]) listener(event);
  };

  /** One connection, read to its end: "ended" on a 401, "opened" if it connected. */
  const connect = async (): Promise<"ended" | "opened" | "failed"> => {
    const token = options.token();
    if (token === undefined) return "ended";
    abort = new AbortController();
    const res = await doFetch(`${options.base}/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: abort.signal,
    }).catch(() => undefined);
    if (res === undefined) return "failed";
    if (res.status === 401) {
      options.onUnauthorized?.();
      return "ended";
    }
    if (!res.ok || res.body === null) return "failed";
    for (const open of [...opens]) open();
    const feed = parseSse(emit);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    reading = reader;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        feed(value);
      }
    } catch {
      // Cut off (or aborted): reconnect below unless closed.
    }
    return "opened";
  };

  const loop = async () => {
    running = true;
    let wait = FIRST_WAIT_MS;
    let failures = 0;
    while (!closed && listeners.size > 0) {
      const outcome = await connect();
      if (outcome === "ended") break;
      if (closed || listeners.size === 0) break;
      // A stream that connected starts the backoff, and the count of failures, over.
      if (outcome === "opened") {
        wait = FIRST_WAIT_MS;
        failures = 0;
      } else if (++failures >= (options.maxFailures ?? MAX_FAILURES)) {
        options.onUnreachable?.();
        break;
      }
      await sleep(wait);
      if (outcome === "failed") wait = Math.min(wait * 2, MAX_WAIT_MS);
    }
    running = false;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!running && !closed) void loop();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    onOpen(listener) {
      opens.add(listener);
      return () => opens.delete(listener);
    },
    close() {
      closed = true;
      stop();
    },
  };
}

/** Which events a hook wants: a type, a `prefix.*`, a list of either, or a test. */
export type EventFilter =
  string | readonly string[] | ((event: DaemonEvent) => boolean);

export function matches(filter: EventFilter, event: DaemonEvent): boolean {
  if (typeof filter === "function") return filter(event);
  const patterns = typeof filter === "string" ? [filter] : filter;
  return patterns.some((pattern) =>
    pattern.endsWith(".*")
      ? event.type.startsWith(pattern.slice(0, -1))
      : event.type === pattern,
  );
}

/** The app's event stream, provided once at the root (app/providers.tsx). */
export const EventsContext = createContext<EventSource | undefined>(undefined);

/**
 * The latest daemon event `filter` matches, and `on` called with each one, for as long as the
 * component is mounted.
 */
export function useDaemonEvents(
  filter: EventFilter,
  on?: (event: DaemonEvent) => void,
): DaemonEvent | undefined {
  const source = useContext(EventsContext);
  if (source === undefined)
    throw new Error("useDaemonEvents needs an EventsContext provider");
  const [last, setLast] = useState<DaemonEvent>();
  const latest = useRef({ filter, on });
  useEffect(() => {
    latest.current = { filter, on };
  });
  useEffect(
    () =>
      source.subscribe((event) => {
        if (!matches(latest.current.filter, event)) return;
        setLast(event);
        latest.current.on?.(event);
      }),
    [source],
  );
  return last;
}
