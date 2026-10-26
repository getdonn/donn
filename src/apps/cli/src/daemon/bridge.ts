import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ANSWER_KEY } from "../agent/questions.js";
import { CliError } from "../errors.js";
import {
  knownProjects,
  openRoutes,
  real,
  under,
  type Answer,
  type Opener,
} from "./bridge-open.js";
import { failure, readBody, runRequest, sameToken } from "./http.js";
import { createJobs, secretVariable, type JobEvent } from "./jobs.js";
import type { runInProcess } from "./run.js";
import { uiAllowed } from "./ui-allow.js";

// The loopback bridge: the daemon serves the local web UI over HTTP on 127.0.0.1 while a UI
// session is open. A browser cannot reach the unix socket; this listener lets the app run the
// same in-process CLI as `POST /run`, under its own allowlist (ui-allow.ts). Every request must
// name the loopback host (DNS rebinding) and, under /v1, carry the UI token (a header, never a
// cookie, so another site cannot send one). Long runs are jobs (jobs.ts) the app follows on
// `/v1/events`, with the daemon's own events. See docs/planning/26-gui.md §1–§2.

/** An event on `/v1/events`: the daemon's (spec 14, `agent.*` of spec 25) or a job's. */
export interface BridgeEvent {
  type: string;
  [key: string]: unknown;
}

export interface BridgeOptions {
  home: string;
  /** The daemon's io, for the runs. */
  io: Parameters<typeof runInProcess>[0];
  /** Runs the CLI in-process: the daemon passes the handler `POST /run` uses. */
  runInProcess: typeof runInProcess;
  now?: () => number;
  /** Closes after this long without a `/v1` request or a hold (an open event stream); 10 min. */
  idleMs?: number;
  /** How often idleness is checked; 15 s. */
  tickMs?: number;
  /** The port to listen on; a free one when absent. */
  port?: number;
  /** The app's built files; `<cli dist>/ui/`. */
  uiDir?: string;
  log?: (line: string) => unknown;
  /** Follows the daemon's events, for `/v1/events`; returns a function that stops following. */
  events?: (on: (event: BridgeEvent) => void) => () => void;
  /** How often an event stream gets a `: ping`; 15 s. */
  pingMs?: number;
  /** Opens a path in the user's editor (`/v1/open`); defaults to node:child_process. */
  opener?: Opener;
  /** Test seam: the OS whose opener `/v1/open` uses without `$VISUAL`. */
  platform?: NodeJS.Platform;
}

/**
 * The daemon's io marked as donn ui's (`fromUi`, and its agent runs' origin): an agent run or
 * deploy it starts has no shell environment, so an env-provider ref fails rather than resolve in
 * the daemon's (spec 26 §2). Set in process only: nothing a request or a terminal sends can mark
 * or unmark a run.
 */
function fromUi(io: BridgeOptions["io"]): BridgeOptions["io"] {
  const agents = io.agents;
  return {
    ...io,
    fromUi: true,
    ...(agents !== undefined && {
      agents: {
        ...agents,
        run: (project, name) => agents.run(project, name, { origin: "ui" }),
      },
    }),
  };
}

/**
 * Why the bridge closes, told to its event streams as `ui.closing` before they end, so a page
 * still open ends its session rather than reconnect to a closed port.
 */
export type BridgeCloseReason = "idle" | "daemon-stopping";

export interface Bridge {
  port: number;
  /** A new one-time code, good for 60 s, that `POST /v1/session` exchanges for the UI token. */
  code(): string;
  /** Keeps the bridge open (an event stream) until the returned release is called. */
  hold(): () => void;
  /** Whether it is closing or closed (set the moment `close()` starts): never reuse it then. */
  readonly closing: boolean;
  /**
   * Stop listening and cut every connection, after telling the event streams why (the daemon
   * stopping when no reason is given: it is the only caller outside the bridge). Safe to call
   * twice; the first reason is the one told.
   */
  close(reason?: BridgeCloseReason): Promise<void>;
  /** Settles once the bridge has closed: by `close()` or idleness. */
  closed: Promise<void>;
}

const IDLE_MS = 10 * 60_000;
const TICK_MS = 15_000;
const CODE_MS = 60_000;
const PING_MS = 15_000;
/** How far an event stream's reader may fall behind before it is dropped. */
const STREAM_BUFFER = 1024 * 1024;
/** How long close lets a request still being answered finish before cutting it. */
const CLOSE_GRACE_MS = 1_000;

/** The built app, beside this module in the CLI's `dist/`. */
const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));

const SECURITY: OutgoingHttpHeaders = {
  "content-security-policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: OutgoingHttpHeaders = {},
) {
  res.writeHead(status, {
    ...SECURITY,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(`${JSON.stringify(body)}\n`);
}

/** `{ key, value }` (`/v1/jobs/<id>/answer`), or why not. */
function answerRequest(text: string): string | { key: string; value: unknown } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return "the body is not JSON";
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return "the body must be { key, value }";
  const { key } = body as { key?: unknown };
  if (typeof key !== "string" || !ANSWER_KEY.test(key))
    return "key must be a question's key: letters, digits and -, in .-separated parts";
  if (!("value" in body)) return "value is missing";
  return { key, value: (body as { value: unknown }).value };
}

/**
 * `{ argv, cwd? }` from `POST /v1/run`'s body, or the reason it is not one. Unlike `POST /run`,
 * `cwd` may be left out: a project-independent command then runs in the daemon's home.
 */
async function uiRunRequest(
  text: string,
): Promise<{ argv: string[]; cwd?: string } | string> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return "the body is not JSON";
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    (body as { cwd?: unknown }).cwd !== undefined
  )
    return runRequest(text);
  const { argv } = body as { argv?: unknown };
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === "string"))
    return "argv must be an array of strings";
  return { argv: argv as string[] };
}

/** Why a refused request is refused: the status and body to answer with. */
type Refusal = Answer;

type Found = { file: string } | "not-found" | "not-built";

/**
 * The file under `root` a GET of `path` serves: the file itself, `index.html` for `/` and for
 * any path that names no file (the app's routes). Nothing outside `root`, even by a symlink.
 */
async function staticFile(root: string, path: string): Promise<Found> {
  const top = await realpath(root).catch(() => undefined);
  const index = top && join(top, "index.html");
  if (!index || !(await stat(index).catch(() => undefined))?.isFile())
    return "not-built";
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return "not-found";
  }
  const parts = decoded.split("/").filter((part) => part !== "");
  if (
    parts.some(
      (part) =>
        part === "." ||
        part === ".." ||
        part.includes("\\") ||
        part.includes("\0"),
    )
  )
    return "not-found";
  if (parts.length === 0) return { file: index };
  const target = await realpath(join(top, ...parts)).catch(() => undefined);
  if (target === undefined) return { file: index };
  if (!under(target, top)) return "not-found";
  return (await stat(target)).isFile() ? { file: target } : { file: index };
}

export async function openBridge(options: BridgeOptions): Promise<Bridge> {
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? IDLE_MS;
  const uiDir = options.uiDir ?? UI_DIR;
  /** The io every run gets: agent runs marked as donn ui's. */
  const runIo = fromUi(options.io);
  const token = randomBytes(32).toString("base64url");
  /** Outstanding one-time codes, with when each expires. */
  const codes = new Map<string, number>();
  let port = 0;

  let last = now();
  let holds = 0;
  const hold = () => {
    holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds--;
      last = now();
    };
  };

  /** The code's entry, compared in constant time; consumed whether or not it is still good. */
  const redeem = (given: string): boolean => {
    const buffer = Buffer.from(given);
    for (const [code, expires] of codes) {
      const expected = Buffer.from(code);
      if (
        expected.length === buffer.length &&
        timingSafeEqual(expected, buffer)
      ) {
        codes.delete(code);
        return now() < expires;
      }
    }
    return false;
  };

  /** Host must name this listener by its loopback name; a present Origin must be that host. */
  const fromLoopback = (req: IncomingMessage) => {
    const host = req.headers.host?.toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
      return false;
    const origin = req.headers.origin;
    return origin === undefined || origin === `http://${host}`;
  };

  const exchange = async (req: IncomingMessage, res: ServerResponse) => {
    const text = await readBody(req, { stopAtLimit: true });
    if (text === undefined) {
      return send(res, 413, failure("too-large", "the body is over 1 MiB"));
    }
    let code: unknown;
    try {
      code = (JSON.parse(text) as { code?: unknown } | null)?.code;
    } catch {
      code = undefined;
    }
    if (typeof code !== "string" || !redeem(code)) {
      return send(
        res,
        401,
        failure("bad-code", "the code is wrong, used or expired", {
          fix: "donn ui",
        }),
      );
    }
    last = now();
    return send(res, 200, { token });
  };

  /**
   * Whether the UI may run `argv` in `cwd` (a known project; none for a project-independent
   * command): the UI allowlist, the project rules and `--out` containment. Yields the folder it
   * runs in, or the refusal.
   */
  const admit = async (
    argv: string[],
    asked: string | undefined,
  ): Promise<{ cwd: string } | Refusal> => {
    const verdict = uiAllowed(argv);
    if (!verdict.ok) {
      return {
        status: 403,
        body: {
          error: {
            code: "not-allowed",
            message: `not a command the UI runs: ${argv.join(" ")}`,
            rule: verdict.rule,
          },
        },
      };
    }
    if (asked === undefined && verdict.project) {
      return {
        status: 403,
        body: {
          error: {
            code: "not-allowed",
            message: `${verdict.name} needs a project`,
            rule: `${verdict.name} acts on a project: send it as cwd`,
          },
        },
      };
    }
    // A project-independent command runs where the daemon's own runs do: its home.
    const cwd = asked ?? options.home;
    const known = await knownProjects(options.home);
    for (const dir of [
      ...(asked === undefined ? [] : [asked]),
      ...(verdict.projectDir === undefined
        ? []
        : [resolve(cwd, verdict.projectDir)]),
    ]) {
      if (!known.has(await real(dir))) {
        return {
          status: 403,
          body: failure("unknown-project", `not a project donn knows: ${dir}`, {
            project: dir,
            fix: "pick the project in the app",
          }),
        };
      }
    }
    if (verdict.outDir !== undefined) {
      const out = await real(resolve(cwd, verdict.outDir));
      if (![...known].some((project) => under(out, project))) {
        return {
          status: 403,
          body: failure(
            "outside-project",
            `--out is not inside a project: ${out}`,
            { out, fix: "write the bundle inside the project" },
          ),
        };
      }
    }
    return { cwd };
  };

  /** The body of a run or job request, or the answer that refuses it. */
  const runBody = async (
    req: IncomingMessage,
  ): Promise<{ argv: string[]; cwd?: string } | Refusal> => {
    const text = await readBody(req, { stopAtLimit: true });
    if (text === undefined) {
      return {
        status: 413,
        body: failure("too-large", "the body is over 1 MiB"),
      };
    }
    const request = await uiRunRequest(text);
    if (typeof request === "string") {
      return { status: 400, body: failure("bad-request", request) };
    }
    return request;
  };

  const run = async (req: IncomingMessage, res: ServerResponse) => {
    const request = await runBody(req);
    if ("status" in request) return send(res, request.status, request.body);
    const admitted = await admit(request.argv, request.cwd);
    if ("status" in admitted) return send(res, admitted.status, admitted.body);
    return send(
      res,
      200,
      await options.runInProcess(runIo, request.argv, admitted.cwd),
    );
  };

  /** The open event streams, each answered with `text/event-stream`. */
  const streams = new Set<ServerResponse>();
  /** Writes to an event stream; one whose reader has fallen 1 MiB behind is dropped. */
  const deliver = (stream: ServerResponse, text: string) => {
    stream.write(text);
    if (stream.writableLength <= STREAM_BUFFER) return;
    streams.delete(stream);
    stream.destroy();
    void options.log?.("ui dropped an event stream that fell behind");
  };
  const broadcast = (event: BridgeEvent) => {
    const text = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const stream of streams) deliver(stream, text);
  };

  const jobs = createJobs({
    // Checked as it was admitted; run where admit said (a global command: the home).
    run: (argv, cwd, lines) =>
      options.runInProcess(runIo, argv, cwd ?? options.home, lines),
    emit: (event: JobEvent) => broadcast(event),
    now,
    hold,
  });

  /** A job's id once queued; refused when every kept job is still queued or running. */
  const started = (
    res: ServerResponse,
    job: { id: string } | "full" | "closed",
  ) =>
    job === "full"
      ? send(
          res,
          429,
          failure("too-many-jobs", "100 jobs are queued or running", {
            fix: "wait for one to finish",
          }),
        )
      : job === "closed"
        ? send(
            res,
            503,
            failure("closing", "the bridge is closing", { fix: "donn ui" }),
          )
        : send(res, 202, { id: job.id });

  const startJob = async (req: IncomingMessage, res: ServerResponse) => {
    const request = await runBody(req);
    if ("status" in request) return send(res, request.status, request.body);
    const admitted = await admit(request.argv, request.cwd);
    if ("status" in admitted) return send(res, admitted.status, admitted.body);
    return started(res, jobs.start(request.argv, request.cwd));
  };

  const noSuchJob = (res: ServerResponse, id: string) =>
    send(res, 404, failure("no-such-job", `no job ${id}`, { id }));

  const answer = async (
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ) => {
    const text = await readBody(req, { stopAtLimit: true });
    if (text === undefined) {
      return send(res, 413, failure("too-large", "the body is over 1 MiB"));
    }
    const body = answerRequest(text);
    if (typeof body === "string") {
      return send(res, 400, failure("bad-request", body));
    }
    /** The continuation, or the answer refusing it when there is none to run. */
    const continuation = () => {
      const next = jobs.continuation(id, body.key, body.value);
      if (typeof next !== "string") return next;
      if (next === "no-such-job") noSuchJob(res, id);
      else if (next === "secret-question") {
        // 25 §6: a secret is never answered on a command line; eve reads its variable.
        const variable = secretVariable(jobs.get(id)?.question?.question);
        send(
          res,
          400,
          failure(
            "secret-question",
            `job ${id} asks for a secret: set ${variable} where eve runs, never as an answer`,
            {
              id,
              variable,
              fix: `a job runs eve in the daemon's environment: set ${variable} there and start the job again, or run the same donn agent add in a terminal with ${variable} set`,
            },
          ),
        );
      } else if (next === "not-asked") {
        send(
          res,
          400,
          failure(
            "not-asked",
            `job ${id} did not ask ${body.key}; answer the question it asked`,
            { id, key: body.key },
          ),
        );
      } else
        send(
          res,
          409,
          next === "answered"
            ? failure("answered", `job ${id}'s question is answered already`, {
                id,
              })
            : failure("no-question", `job ${id} asked no question`, { id }),
        );
      return undefined;
    };
    const next = continuation();
    if (next === undefined) return;
    // The continuation is a new run: the allowlist and project rules again.
    const admitted = await admit(next.argv, next.cwd);
    if ("status" in admitted) return send(res, admitted.status, admitted.body);
    // Another answer may have come in meanwhile: only one continues.
    if (continuation() === undefined) return;
    return started(res, jobs.start(next.argv, next.cwd, id));
  };

  const follow = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      ...SECURITY,
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    });
    // A comment, so the app knows the stream is open.
    res.write(": connected\n\n");
    streams.add(res);
    // A connected app keeps the bridge open.
    const release = hold();
    req.on("close", () => {
      streams.delete(res);
      release();
    });
  };

  const files = openRoutes({
    home: options.home,
    io: options.io,
    ...(options.opener && { opener: options.opener }),
    ...(options.platform && { platform: options.platform }),
    ...(options.log && { log: options.log }),
  });

  /** A body read for `handle`, or 413 when it is over the limit. */
  const withBody = async (
    req: IncomingMessage,
    res: ServerResponse,
    handle: (text: string) => Promise<Answer>,
  ) => {
    const text = await readBody(req, { stopAtLimit: true });
    if (text === undefined) {
      return send(res, 413, failure("too-large", "the body is over 1 MiB"));
    }
    const answer = await handle(text);
    return send(res, answer.status, answer.body);
  };

  const serveStatic = async (res: ServerResponse, path: string) => {
    const found = await staticFile(uiDir, path);
    if (found === "not-built") {
      return send(
        res,
        503,
        failure("ui-not-built", "the app is not built: there is no dist/ui", {
          fix: "pnpm build",
        }),
      );
    }
    if (found === "not-found") {
      return send(res, 404, failure("not-found", `no such file: ${path}`));
    }
    const body = await readFile(found.file);
    res.writeHead(200, {
      ...SECURITY,
      "content-type":
        TYPES[extname(found.file).toLowerCase()] ?? "application/octet-stream",
      ...(found.file.endsWith(`${sep}index.html`) && {
        "cache-control": "no-store",
      }),
    });
    res.end(body);
  };

  const server = createServer((req, res) => {
    // A body left unread (a refusal, or one over the limit) is not drained: the connection goes.
    res.on("finish", () => {
      if (!req.complete) req.destroy();
    });
    void (async () => {
      // Before anything else, the token included: a rebound page must learn nothing.
      if (!fromLoopback(req)) {
        return send(
          res,
          403,
          failure("forbidden-host", "Host or Origin is not this bridge"),
        );
      }
      const path = (req.url ?? "").split("?")[0]!;
      if (path === "/v1" || path.startsWith("/v1/")) {
        if (req.method === "POST" && path === "/v1/session")
          return exchange(req, res);
        if (!sameToken(req.headers.authorization, token)) {
          return send(
            res,
            401,
            failure("unauthorized", "missing or wrong UI token", {
              fix: "donn ui",
            }),
          );
        }
        // A request in flight holds the bridge open; its end restarts the idle clock.
        const release = hold();
        try {
          if (req.method === "POST" && path === "/v1/run")
            return await run(req, res);
          if (req.method === "POST" && path === "/v1/jobs")
            return await startJob(req, res);
          const job = /^\/v1\/jobs\/([^/]+)(\/answer)?$/.exec(path);
          if (job && req.method === (job[2] ? "POST" : "GET")) {
            const id = job[1]!;
            if (job[2]) return await answer(req, res, id);
            const found = jobs.get(id);
            if (found === undefined) return noSuchJob(res, id);
            return send(res, 200, jobs.view(found));
          }
          if (req.method === "GET" && path === "/v1/events")
            return follow(req, res);
          if (req.method === "POST" && path === "/v1/open")
            return await withBody(req, res, files.open);
          if (req.method === "GET" && path === "/v1/projects")
            return send(res, 200, { projects: await files.listProjects() });
          if (req.method === "POST" && path === "/v1/projects")
            return await withBody(req, res, files.addProject);
          return send(
            res,
            404,
            failure("not-found", `no such endpoint: ${req.method} ${path}`),
          );
        } finally {
          release();
        }
      }
      if (req.method === "GET" && path.startsWith("/"))
        return serveStatic(res, path);
      send(res, 404, failure("not-found", `no such endpoint: ${req.method}`));
    })().catch((error: unknown) => {
      void options.log?.(`error ui ${req.method} ${req.url}: ${String(error)}`);
      if (!res.headersSent) {
        send(res, 500, failure("internal", "the bridge failed this request"));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        new CliError(
          "port-unavailable",
          `cannot listen on 127.0.0.1:${options.port ?? 0}: ${error.code ?? error.message}`,
          {
            port: options.port ?? 0,
            fix: "leave out --port to use a free one",
          },
        ),
      ),
    );
    server.listen({ host: "127.0.0.1", port: options.port ?? 0 }, () => {
      server.removeAllListeners("error");
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;

  let closing: Promise<void> | undefined;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  const close = (reason: BridgeCloseReason = "daemon-stopping") =>
    (closing ??= (async () => {
      clearInterval(tick);
      clearInterval(ping);
      unfollow?.();
      // The queued jobs end as cancelled, told to the streams before they end.
      jobs.close();
      codes.clear();
      // Then why: the page ends its session on it instead of retrying a closed port.
      broadcast({ type: "ui.closing", reason });
      // An open stream never ends by itself: end it, rather than cut it after the grace.
      for (const stream of streams) stream.end();
      streams.clear();
      await new Promise<void>((resolve) => {
        const force = setTimeout(
          () => server.closeAllConnections(),
          CLOSE_GRACE_MS,
        );
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      });
      markClosed();
    })());

  const tick = setInterval(() => {
    if (holds > 0 || now() - last < idleMs) return;
    void options.log?.(`ui closed on 127.0.0.1:${port}: idle`);
    void close("idle");
  }, options.tickMs ?? TICK_MS);
  tick.unref();
  const ping = setInterval(() => {
    for (const stream of streams) deliver(stream, ": ping\n\n");
  }, options.pingMs ?? PING_MS);
  ping.unref();
  const unfollow = options.events?.(broadcast);

  return {
    port,
    get closing() {
      return closing !== undefined;
    },
    code() {
      const t = now();
      // A code handed out must outlive its 60 s: the idle clock restarts with it.
      last = t;
      for (const [code, expires] of codes) if (t >= expires) codes.delete(code);
      const code = randomBytes(32).toString("base64url");
      codes.set(code, t + CODE_MS);
      return code;
    },
    hold,
    close,
    closed,
  };
}
