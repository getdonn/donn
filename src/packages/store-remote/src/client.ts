import {
  Problem,
  ROUTES,
  type LayerSummary,
  type LayerVersion,
  type PublishRequest,
  type PublishResult,
  type Whoami,
} from "@zzpersona/registry-api";
import { RegistryError } from "./error.js";
import { normaliseUrl, routeUrl } from "./url.js";

export { RegistryError, type RegistryErrorCode } from "./error.js";

export interface RegistryClient {
  whoami(): Promise<Whoami>;
  listLayers(): Promise<LayerSummary[]>;
  getVersion(ref: string, version: number | "latest"): Promise<LayerVersion>;
  publish(ref: string, body: PublishRequest): Promise<PublishResult>;
}

export interface ClientOptions {
  url: string;
  token: string;
  signal?: AbortSignal;
  /** Per request; default 10 000. */
  timeoutMs?: number;
}

type RouteName = keyof typeof ROUTES;

export function createClient(options: ClientOptions): RegistryClient {
  const base = normaliseUrl(options.url);
  const { token, timeoutMs = 10_000 } = options;

  /** A server could echo the request back in an error body; the token is never repeated. */
  const scrub = (text: string) =>
    token === "" ? text : text.split(token).join("***");

  async function call<N extends RouteName>(
    name: N,
    params: Record<string, string>,
    body?: unknown,
  ): Promise<unknown> {
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
      const response = await fetch(routeUrl(base, route.path, params), {
        method: route.method,
        headers: {
          authorization: `Bearer ${token}`,
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
        const code =
          problems?.[0]?.code ??
          (status === 401
            ? "unauthorized"
            : status === 404
              ? "not-found"
              : "registry-protocol");
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
    return parsed.data;
  }

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
  };
}
