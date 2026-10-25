import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { listCreated } from "../agent/registry.js";
import { CliError } from "../errors.js";
import { listSessions } from "../session.js";
import { failure, readBody, runRequest, sameToken } from "./http.js";
import type { runInProcess } from "./run.js";
import { uiAllowed } from "./ui-allow.js";

// The loopback bridge: the daemon serves the local web UI over HTTP on 127.0.0.1 while a UI
// session is open. A browser cannot reach the unix socket; this listener lets the app run the
// same in-process CLI as `POST /run`, under its own allowlist (ui-allow.ts). Every request must
// name the loopback host (DNS rebinding) and, under /v1, carry the UI token (a header, never a
// cookie, so another site cannot send one). See docs/planning/26-gui.md §1–§2.

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
}

export interface Bridge {
  port: number;
  /** A new one-time code, good for 60 s, that `POST /v1/session` exchanges for the UI token. */
  code(): string;
  /** Keeps the bridge open (an event stream) until the returned release is called. */
  hold(): () => void;
  /** Stop listening and cut every connection. Safe to call twice. */
  close(): Promise<void>;
  /** Settles once the bridge has closed: by `close()` or idleness. */
  closed: Promise<void>;
}

const IDLE_MS = 10 * 60_000;
const TICK_MS = 15_000;
const CODE_MS = 60_000;
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

/** `~/.donn/ui.json`: the projects the user picked in the app. */
const UiFile = z.object({ projects: z.array(z.string()) });

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

/** A path with symlinks resolved; as given (made absolute) when it does not exist. */
const real = (path: string) => realpath(path).catch(() => resolve(path));

const under = (path: string, dir: string) =>
  path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);

/** Projects the daemon knows (running sessions', created agents') and the UI picked. */
async function knownProjects(home: string): Promise<Set<string>> {
  const sessions = (await listSessions(home))
    .filter((s) => s.running)
    .flatMap((s) =>
      s.launched.project === undefined ? [] : [s.launched.project],
    );
  const created = (await listCreated(home).catch(() => [])).map(
    (c) => c.project,
  );
  const picked = await readFile(join(home, "ui.json"), "utf8")
    .then((text) => UiFile.parse(JSON.parse(text)).projects)
    .catch(() => [] as string[]);
  const all = [...sessions, ...created, ...picked].filter((p) => isAbsolute(p));
  return new Set(await Promise.all(all.map(real)));
}

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
    const text = await readBody(req);
    let code: unknown;
    try {
      code = (JSON.parse(text ?? "") as { code?: unknown } | null)?.code;
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

  const run = async (req: IncomingMessage, res: ServerResponse) => {
    const text = await readBody(req);
    if (text === undefined) {
      return send(res, 413, failure("too-large", "the body is over 1 MiB"));
    }
    const request = await runRequest(text);
    if (typeof request === "string") {
      return send(res, 400, failure("bad-request", request));
    }
    const verdict = uiAllowed(request.argv);
    if (!verdict.ok) {
      return send(res, 403, {
        error: {
          code: "not-allowed",
          message: `not a command the UI runs: ${request.argv.join(" ")}`,
          rule: verdict.rule,
        },
      });
    }
    const known = await knownProjects(options.home);
    for (const dir of [
      request.cwd,
      ...(verdict.project === undefined
        ? []
        : [resolve(request.cwd, verdict.project)]),
    ]) {
      if (!known.has(await real(dir))) {
        return send(
          res,
          403,
          failure("unknown-project", `not a project donn knows: ${dir}`, {
            project: dir,
            fix: "pick the project in the app",
          }),
        );
      }
    }
    return send(
      res,
      200,
      await options.runInProcess(options.io, request.argv, request.cwd),
    );
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
  const close = () =>
    (closing ??= (async () => {
      clearInterval(tick);
      codes.clear();
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
    void close();
  }, options.tickMs ?? TICK_MS);
  tick.unref();

  return {
    port,
    code() {
      const t = now();
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
