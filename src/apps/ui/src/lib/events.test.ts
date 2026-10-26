import { describe, expect, it } from "vitest";
import { createEventStream, parseSse, type DaemonEvent } from "./events";

// `/v1/events` read over fetch (the token is a header, so not the native EventSource): SSE
// frames split anywhere, reconnects with backoff, and a 401 that ends the session.

const encoder = new TextEncoder();

/** A text/event-stream response whose body is these chunks, then the end (or held open). */
function stream(chunks: string[], hold = false): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (!hold) controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("parseSse", () => {
  it("reads events split across chunks, skips comments", () => {
    const events: DaemonEvent[] = [];
    const feed = parseSse((event) => events.push(event));
    feed(": connected\n\nevent: session.added\nda");
    feed('ta: {"type":"session.added","session":"/s"}\n');
    feed("\n: ping\n\nevent: job.done\r\n");
    feed('data: {"type":"job.done","id":"j"}\r\n\r\n');
    expect(events).toEqual([
      { type: "session.added", session: "/s" },
      { type: "job.done", id: "j" },
    ]);
  });

  it("a frame whose data is not JSON is dropped", () => {
    const events: DaemonEvent[] = [];
    const feed = parseSse((event) => events.push(event));
    feed("event: x\ndata: not json\n\n");
    expect(events).toEqual([]);
  });
});

describe("createEventStream", () => {
  it("connects with the token, delivers events and reconnects with backoff", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const answers = [
      stream([
        ': connected\n\nevent: session.added\ndata: {"type":"session.added"}\n\n',
      ]),
      stream(
        ['event: session.ended\ndata: {"type":"session.ended"}\n\n'],
        true,
      ),
    ];
    const waits: number[] = [];
    const events = createEventStream({
      base: "http://127.0.0.1:1",
      token: () => "tok",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          auth: new Headers(init?.headers).get("authorization"),
        });
        const next = answers.shift();
        if (next === undefined) return new Promise<Response>(() => {});
        return next;
      }) as typeof fetch,
      sleep: async (ms) => void waits.push(ms),
    });
    const seen: string[] = [];
    let opens = 0;
    events.onOpen(() => opens++);
    const done = new Promise<void>((resolve) => {
      events.subscribe((event) => {
        seen.push(event.type);
        if (event.type === "session.ended") resolve();
      });
    });
    await done;
    events.close();

    expect(seen).toEqual(["session.added", "session.ended"]);
    expect(calls[0]).toEqual({
      url: "http://127.0.0.1:1/v1/events",
      auth: "Bearer tok",
    });
    expect(calls).toHaveLength(2);
    expect(opens).toBe(2);
    // A stream that delivered resets the backoff: the first wait is the shortest.
    expect(waits).toEqual([500]);
  });

  it("backs off further each time a connection fails", async () => {
    const waits: number[] = [];
    let tries = 0;
    const events = createEventStream({
      base: "http://127.0.0.1:1",
      token: () => "tok",
      fetch: (async () => {
        tries++;
        throw new TypeError("Failed to fetch");
      }) as typeof fetch,
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length === 6) events.close();
      },
    });
    events.subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 10000]);
    expect(tries).toBe(6);
  });

  it("a 401 ends the session and stops", async () => {
    let ended = 0;
    let tries = 0;
    const events = createEventStream({
      base: "http://127.0.0.1:1",
      token: () => "stale",
      fetch: (async () => {
        tries++;
        return new Response("{}", { status: 401 });
      }) as typeof fetch,
      sleep: async () => {},
      onUnauthorized: () => ended++,
    });
    events.subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ended).toBe(1);
    expect(tries).toBe(1);
  });
});
