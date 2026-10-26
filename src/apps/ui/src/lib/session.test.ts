import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, endReasonOf, TOKEN_KEY } from "./session";

// The sign-in: `donn ui` opens `/#t=<one-time code>`; the page trades the code for the UI token
// once, keeps the token in sessionStorage and drops the fragment. Runs in jsdom: the real
// location, history and sessionStorage, with the bridge's `POST /v1/session` faked.

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch that answers `POST /v1/session` with `status` and `body`, recording each call. */
function bridge(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

const at = (url: string) => window.history.replaceState(null, "", url);

beforeEach(() => {
  sessionStorage.clear();
  at("/");
});
afterEach(() => sessionStorage.clear());

describe("createSession", () => {
  it("trades the fragment's code for a token, once, and clears the fragment", async () => {
    at("/projects?x=1#t=code-1");
    const fake = bridge(200, { token: "tok-1" });
    const session = createSession({ fetch: fake.fetch });

    const state = await session.start();

    expect(state).toEqual({ state: "ready", token: "tok-1" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toBe(`${window.location.origin}/v1/session`);
    expect(fake.calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(fake.calls[0]!.init?.body))).toEqual({
      code: "code-1",
    });
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe("tok-1");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname + window.location.search).toBe(
      "/projects?x=1",
    );
    expect(session.token()).toBe("tok-1");

    // A second start (a remount) has no code to spend: it keeps the token.
    expect(await session.start()).toEqual({ state: "ready", token: "tok-1" });
    expect(fake.calls).toHaveLength(1);
  });

  it("picks up the stored token after a reload, with no request", async () => {
    sessionStorage.setItem(TOKEN_KEY, "tok-kept");
    const fake = bridge(500, {});
    const session = createSession({ fetch: fake.fetch });

    expect(await session.start()).toEqual({
      state: "ready",
      token: "tok-kept",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("a fresh code replaces a stored token", async () => {
    sessionStorage.setItem(TOKEN_KEY, "tok-old");
    at("/#t=code-2");
    const session = createSession({
      fetch: bridge(200, { token: "tok-new" }).fetch,
    });

    expect(await session.start()).toEqual({ state: "ready", token: "tok-new" });
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe("tok-new");
  });

  it("a used or expired code ends the session and keeps no token", async () => {
    sessionStorage.setItem(TOKEN_KEY, "tok-old");
    at("/#t=used");
    const fake = bridge(401, {
      error: {
        code: "bad-code",
        message: "the code is wrong, used or expired",
      },
    });
    const session = createSession({ fetch: fake.fetch });

    expect(await session.start()).toEqual({
      state: "ended",
      reason: "bad-code",
    });
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("no code and no token: ended", async () => {
    const session = createSession({ fetch: bridge(200, {}).fetch });
    expect(await session.start()).toEqual({
      state: "ended",
      reason: "no-session",
    });
  });

  it("an unreachable bridge ends the session", async () => {
    at("/#t=code-3");
    const session = createSession({
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch,
    });
    expect(await session.start()).toEqual({
      state: "ended",
      reason: "unreachable",
    });
  });

  it("end() (a 401 anywhere) drops the token and tells subscribers", async () => {
    at("/#t=code-4");
    const session = createSession({
      fetch: bridge(200, { token: "tok-4" }).fetch,
    });
    await session.start();
    const seen: string[] = [];
    const unsubscribe = session.subscribe(() =>
      seen.push(session.current().state),
    );

    session.end("unauthorized");

    expect(session.current()).toEqual({
      state: "ended",
      reason: "unauthorized",
    });
    expect(session.token()).toBeUndefined();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(seen).toEqual(["ended"]);
    unsubscribe();
    session.end("unauthorized");
    expect(seen).toEqual(["ended"]);
  });
});

describe("endReasonOf", () => {
  it("ends the session when the bridge says it is closing, with its reason", () => {
    expect(endReasonOf({ type: "ui.closing", reason: "idle" })).toBe("idle");
    expect(endReasonOf({ type: "ui.closing", reason: "daemon-stopping" })).toBe(
      "daemon-stopped",
    );
    // A reason this app does not know yet still ends it.
    expect(endReasonOf({ type: "ui.closing", reason: "later" })).toBe(
      "unreachable",
    );
    expect(endReasonOf({ type: "daemon.stopping" })).toBe("daemon-stopped");
  });

  it("leaves it open on any other event", () => {
    expect(endReasonOf({ type: "session.added" })).toBeUndefined();
    expect(endReasonOf({ type: "job.done", id: "j" })).toBeUndefined();
  });
});
