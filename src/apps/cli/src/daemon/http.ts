import { timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { isAbsolute } from "node:path";

// What the daemon's socket and its loopback bridge (spec 26 §2) share: bodies, the `/run`
// request, error envelopes and the bearer token check.

/** Whether `header` is `Bearer <token>`, compared in constant time. */
export const sameToken = (header: string | undefined, token: string) => {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
};

/** The largest request body read, `POST /run`'s; larger is `413 too-large`. */
export const BODY_LIMIT = 1024 * 1024;

/**
 * The request's body as text, or undefined once it passes `BODY_LIMIT`. The socket drains the
 * rest; with `stopAtLimit` (the bridge, which other local users can reach) reading stops there,
 * and the caller answers and destroys the request.
 */
export function readBody(
  req: IncomingMessage,
  { stopAtLimit = false } = {},
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BODY_LIMIT) return void chunks.push(chunk);
      if (!stopAtLimit) return;
      req.off("data", onData);
      req.pause();
      resolve(undefined);
    };
    req.on("data", onData);
    req.on("end", () =>
      resolve(
        size > BODY_LIMIT ? undefined : Buffer.concat(chunks).toString("utf8"),
      ),
    );
    req.on("error", reject);
  });
}

/** `{ argv, cwd }` from `POST /run`'s body, or the reason it is not one. */
export async function runRequest(
  text: string,
): Promise<{ argv: string[]; cwd: string } | string> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return "the body is not JSON";
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return "the body must be { argv, cwd }";
  const { argv, cwd } = body as { argv?: unknown; cwd?: unknown };
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === "string"))
    return "argv must be an array of strings";
  if (typeof cwd !== "string" || !isAbsolute(cwd))
    return "cwd must be an absolute path";
  const dir = await stat(cwd).catch(() => undefined);
  if (!dir?.isDirectory()) return "cwd must be an existing directory";
  return { argv: argv as string[], cwd };
}

export const failure = (
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => ({
  error: {
    code,
    message,
    ...(details !== undefined &&
      Object.keys(details).length > 0 && { details }),
  },
});
