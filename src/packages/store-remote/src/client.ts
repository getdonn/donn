import {
  PROBLEM_CODES,
  Problem,
  ROUTES,
  type LayerSummary,
  type LayerVersion,
  type ManagedBundleResponse,
  type LoginStart,
  type LoginToken,
  type ProblemCode,
  type PublishRequest,
  type PublishResult,
  type Whoami,
} from "@zzpersona/registry-api";
import { RegistryError, type RegistryErrorCode } from "./error.js";
import { normaliseUrl, routeUrl } from "./url.js";

export { RegistryError, type RegistryErrorCode } from "./error.js";

const STATUS_CODES: Record<number, RegistryErrorCode> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not-found",
  409: "stale-base",
};

export interface RegistryClient {
  whoami(): Promise<Whoami>;
  listLayers(): Promise<LayerSummary[]>;
  getVersion(ref: string, version: number | "latest"): Promise<LayerVersion>;
  publish(ref: string, body: PublishRequest): Promise<PublishResult>;
  /**
   * The managed policy bundle of an org, area or team layer (format `bundle`): the manifest and
   * every file's bytes. File paths are the registry's word; the caller checks them before writing.
   */
  managedBundle(query: {
    layer: string;
    os: "macos" | "linux" | "windows";
  }): Promise<{
    manifest: ManagedBundleResponse["manifest"];
    /** The manifest as the registry sent it, with any fields this client does not know. */
    rawManifest: unknown;
    files: Record<string, Uint8Array>;
  }>;
}

export interface ClientOptions {
  url: string;
  token: string;
  signal?: AbortSignal;
  /** Per request; default 10 000. */
  timeoutMs?: number;
}

type RouteName = keyof typeof ROUTES;

type Call = (
  name: RouteName,
  params: Record<string, string>,
  body?: unknown,
  query?: Record<string, string>,
) => Promise<unknown>;

/** Like Call, with the response body as sent (before the tolerant schema drops anything). */
type Exchange = (
  ...args: Parameters<Call>
) => Promise<{ data: unknown; json: unknown }>;

function makeCall(options: ClientOptions): Call {
  const exchange = makeExchange(options);
  return async (...args) => (await exchange(...args)).data;
}

function makeExchange(options: ClientOptions): Exchange {
  const base = normaliseUrl(options.url);
  const { token, timeoutMs = 10_000 } = options;

  /** A server could echo the request back in an error body; the token is never repeated. */
  const scrub = (text: string) =>
    token === "" ? text : text.split(token).join("***");

  return async function exchange(name, params, body, query) {
    const route = ROUTES[name];
    const label = `${route.method} ${route.path}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal =
      options.signal === undefined
        ? timeout
        : AbortSignal.any([options.signal, timeout]);
    let status: number;
    let text: string;
    try {
      const url = routeUrl(base, route.path, params);
      for (const [key, value] of Object.entries(query ?? {})) {
        url.searchParams.set(key, value);
      }
      const response = await fetch(url, {
        method: route.method,
        headers: {
          ...(!("auth" in route) && { authorization: `Bearer ${token}` }),
          accept: "application/json, application/problem+json",
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal,
        redirect: "error",
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      if (timeout.aborted) {
        throw new RegistryError(
          "timeout",
          `${label}: the registry did not answer within ${timeoutMs} ms`,
        );
      }
      if (options.signal?.aborted) throw error;
      const cause = (error as { cause?: { code?: unknown } }).cause?.code;
      throw new RegistryError(
        "unreachable",
        `${label}: the registry is unreachable${typeof cause === "string" ? ` (${cause})` : ""}`,
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }

    if (!(route.statuses as readonly number[]).includes(status)) {
      const problem = Problem.safeParse(json);
      if (problem.success) {
        const detail = scrub(problem.data.detail);
        const problems = problem.data.problems?.map((p) => ({
          ...p,
          message: scrub(p.message),
          ...(p.ref !== undefined && { ref: scrub(p.ref) }),
          ...(p.path !== undefined && { path: scrub(p.path) }),
        }));
        const message = [detail, ...(problems ?? []).map((p) => p.message)];
        const first = problems?.[0]?.code;
        // A code this client does not know stays in `problems`; the error code follows the status.
        const code: RegistryErrorCode =
          first !== undefined &&
          (PROBLEM_CODES as readonly string[]).includes(first)
            ? (first as ProblemCode)
            : (STATUS_CODES[status] ?? "registry-protocol");
        throw new RegistryError(
          code,
          [...new Set(message)].join("; "),
          problems,
        );
      }
      throw new RegistryError(
        "registry-protocol",
        `${label}: unexpected status ${status} without a problem body`,
      );
    }

    const parsed = route.response.safeParse(json);
    if (!parsed.success) {
      throw new RegistryError(
        "registry-protocol",
        `${label}: the response does not match the registry contract`,
      );
    }
    return { data: parsed.data, json };
  };
}

/** Start a sign-in; needs no token. `not-found` when the registry has no sign-in. */
export function startLogin(
  url: string,
  options: { signal?: AbortSignal } = {},
): Promise<LoginStart> {
  return makeCall({ url, token: "", ...options })(
    "startLogin",
    {},
  ) as Promise<LoginStart>;
}

/**
 * Ask for the session token of a sign-in. Throws RegistryError `authorization-pending` or
 * `slow-down` while waiting, `login-expired` or `forbidden` when it is over.
 */
export function pollLogin(
  url: string,
  loginId: string,
  pollSecret: string,
  options: { signal?: AbortSignal } = {},
): Promise<LoginToken> {
  // The poll secret is scrubbed from error text like a token.
  return makeCall({ url, token: pollSecret, ...options })(
    "pollLogin",
    { loginId },
    { pollSecret },
  ) as Promise<LoginToken>;
}

export function createClient(options: ClientOptions): RegistryClient {
  const call = makeCall(options);
  const exchange = makeExchange(options);
  return {
    whoami: () => call("whoami", {}) as Promise<Whoami>,
    listLayers: () => call("listLayers", {}) as Promise<LayerSummary[]>,
    getVersion: (ref, version) =>
      call("getVersion", {
        ref,
        version: String(version),
      }) as Promise<LayerVersion>,
    publish: (ref, body) =>
      call("publish", { ref }, body) as Promise<PublishResult>,
    managedBundle: async ({ layer, os }) => {
      const { data, json } = await exchange("managedBundle", {}, undefined, {
        layer,
        os,
        format: "bundle",
      });
      const answer = data as ManagedBundleResponse;
      return {
        manifest: answer.manifest,
        rawManifest: (json as { manifest: unknown }).manifest,
        files: Object.fromEntries(
          Object.entries(answer.files).map(([path, base64]) => [
            path,
            new Uint8Array(Buffer.from(base64, "base64")),
          ]),
        ),
      };
    },
  };
}
