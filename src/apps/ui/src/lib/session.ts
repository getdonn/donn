// The sign-in (docs/planning/26-gui.md §1): `donn ui` opens `/#t=<one-time code>`; the page
// trades the code for the UI token with `POST /v1/session` once, keeps the token in
// sessionStorage (no cookies) and drops the fragment from the address bar. A 401 from any later
// request ends the session: the app then shows "run `donn ui` again".

/** Where the token is kept for this tab. */
export const TOKEN_KEY = "donn.ui.token";

export type EndReason =
  /** No code in the URL and no token kept: the page was opened by hand. */
  | "no-session"
  /** The code was wrong, used or expired. */
  | "bad-code"
  /** A request was refused with 401: the bridge closed or rotated its token. */
  | "unauthorized"
  /** The bridge did not answer the code exchange, or the event stream could not reconnect. */
  | "unreachable"
  /** The daemon said it is stopping: its bridge goes with it. */
  | "daemon-stopped"
  /** The bridge closed after ten minutes without a session. */
  | "idle";

export type SessionState =
  | { state: "starting" }
  | { state: "ready"; token: string }
  | { state: "ended"; reason: EndReason };

/**
 * The end an event on `/v1/events` means, if any: the bridge's `ui.closing { reason }`, sent
 * before it closes its streams whatever the reason, or the daemon's `daemon.stopping`.
 */
export function endReasonOf(event: {
  type: string;
  [key: string]: unknown;
}): EndReason | undefined {
  if (event.type === "daemon.stopping") return "daemon-stopped";
  if (event.type !== "ui.closing") return undefined;
  if (event.reason === "idle") return "idle";
  if (event.reason === "daemon-stopping") return "daemon-stopped";
  return "unreachable";
}

export interface SessionEnv {
  fetch?: typeof fetch;
  location?: Pick<Location, "hash" | "pathname" | "search" | "origin">;
  history?: Pick<History, "replaceState" | "state">;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

export interface Session {
  /** Spends the fragment's code, if any, or picks up the kept token. Safe to call again. */
  start(): Promise<SessionState>;
  current(): SessionState;
  /** The token while the session is ready. */
  token(): string | undefined;
  /** Ends the session: drops the token and tells subscribers. */
  end(reason: EndReason): void;
  subscribe(listener: () => void): () => void;
}

/** The code in `#t=<code>`, if the fragment carries one. */
function codeIn(hash: string): string | undefined {
  const code = new URLSearchParams(hash.replace(/^#/, "")).get("t");
  return code === null || code === "" ? undefined : code;
}

export function createSession(env: SessionEnv = {}): Session {
  const doFetch = env.fetch ?? ((...args) => globalThis.fetch(...args));
  const location = env.location ?? window.location;
  const history = env.history ?? window.history;
  const storage = env.storage ?? window.sessionStorage;
  const listeners = new Set<() => void>();
  let state: SessionState = { state: "starting" };
  let starting: Promise<SessionState> | undefined;

  const set = (next: SessionState) => {
    state = next;
    for (const listener of listeners) listener();
    return next;
  };

  const read = (key: string) => {
    try {
      return storage.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  };
  const write = (token: string | undefined) => {
    try {
      if (token === undefined) storage.removeItem(TOKEN_KEY);
      else storage.setItem(TOKEN_KEY, token);
    } catch {
      // Storage refused (a private window): the token lives in memory for this page only.
    }
  };

  const exchange = async (code: string): Promise<SessionState> => {
    let res: Response;
    try {
      res = await doFetch(`${location.origin}/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
    } catch {
      return { state: "ended", reason: "unreachable" };
    }
    const body = (await res.json().catch(() => undefined)) as
      { token?: unknown } | undefined;
    if (!res.ok || typeof body?.token !== "string") {
      return {
        state: "ended",
        reason: res.status === 401 ? "bad-code" : "unreachable",
      };
    }
    return { state: "ready", token: body.token };
  };

  const begin = async (): Promise<SessionState> => {
    const code = codeIn(location.hash);
    if (code === undefined) {
      const kept = read(TOKEN_KEY);
      return kept === undefined
        ? { state: "ended", reason: "no-session" }
        : { state: "ready", token: kept };
    }
    // Gone from the address bar (and history) before it is spent: it works only once.
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${location.search}`,
    );
    return exchange(code);
  };

  return {
    start() {
      if (state.state !== "starting") return Promise.resolve(state);
      starting ??= begin().then((next) => {
        write(next.state === "ready" ? next.token : undefined);
        return set(next);
      });
      return starting;
    },
    current: () => state,
    token: () => (state.state === "ready" ? state.token : undefined),
    end(reason) {
      if (state.state === "ended") return;
      write(undefined);
      set({ state: "ended", reason });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
