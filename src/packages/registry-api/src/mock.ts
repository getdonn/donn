import { randomBytes, randomInt } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { ManagedCompiler, ManagedLayer } from "@getdonn/adapter-sdk";
import { resolve } from "@getdonn/resolver";
import { parse } from "yaml";
import { memoryStore, problemOf, publishLayer } from "./engine.js";
import { compileFromSource, publishedSource } from "./managed.js";
import {
  LayerRef,
  LoginPoll,
  MANAGED_FORMATS,
  MANAGED_INCLUDES,
  MANAGED_OSES,
  PublishRequest,
  grantCovers,
  type LayerSummary,
  type Problem,
  type ProblemCode,
  type Role,
  type Whoami,
} from "./schemas.js";

// An in-memory registry that implements docs/planning/18-registry-contract.md §1-§2 on the
// publish engine (docs/planning/19-publish-engine.md). It is the
// reference for the conformance kit, and the server the client's tests run against.

/** A request body over this is refused before parsing, as bundle-too-large. */
const MAX_BODY_BYTES = 15 * 1024 * 1024;

type ProblemItem = NonNullable<Problem["problems"]>[number];

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const SESSION_DAYS = 30;

/** Someone to sign in as: an email, and the identity-provider groups they belong to. */
export interface MockIdentity {
  email: string;
  groups?: string[];
}

interface Caller {
  kind: "session" | "service";
  subject: string;
  /** Principals whose grants apply: `user:<email>`, `group:<g>` or `service:<name>`. */
  principals: string[];
  expiresAt?: Date;
}

interface Login {
  code: string;
  pollSecret: string;
  verifyUrl: string;
  interval: number;
  expiresAt: number;
  lastPoll?: number;
  state: "pending" | "done" | "refused" | "redeemed";
  identity?: MockIdentity;
  reason?: string;
}

/** The sorted, de-duplicated `locks` of a layer's YAML; undefined when it does not parse. */
function locksOf(source: string): string[] | undefined {
  let doc: unknown;
  try {
    doc = parse(source);
  } catch {
    return undefined;
  }
  if (typeof doc !== "object" || doc === null) return undefined;
  const locks = (doc as { locks?: unknown }).locks;
  const list = Array.isArray(locks)
    ? locks.filter((l): l is string => typeof l === "string")
    : [];
  return [...new Set(list)].sort();
}

class Failure extends Error {
  constructor(
    readonly status: number,
    readonly problems: ProblemItem[],
  ) {
    super(problems.map((p) => p.message).join("; "));
  }
}

const refuse = (
  status: number,
  code: ProblemCode,
  message: string,
  rest = {},
) => new Failure(status, [{ code, message, ...rest }]);

interface Reply {
  status: number;
  body: unknown;
}

export interface MockRegistryOptions {
  token?: string;
  subject?: string;
  org?: string;
  /** Minimum seconds between login polls; 0 (the default) never answers slow-down. */
  loginInterval?: number;
  /** Seconds a login lasts (default 600). */
  loginExpiresIn?: number;
  /** false: the registry has no identity provider and answers 404 on the sign-in routes. */
  signIn?: boolean;
  /**
   * Builds the `bundle` format of `GET /v1/managed/bundle` (pass the Claude Code adapter's
   * `managed`; this package depends on no adapter). Without it the route answers 501.
   */
  managed?: ManagedCompiler;
}

export interface MockRegistry {
  url: string;
  token: string;
  stop(): Promise<void>;
  /** The latest version of every published layer. */
  layers(): LayerSummary[];
  /** Finish the login shown at `verifyUrl` as `identity`; its next poll yields a session token. */
  completeLogin(verifyUrl: string, identity: MockIdentity): void;
  /** Refuse the login at `verifyUrl`; its next poll answers 403 forbidden with `reason`. */
  refuseLogin(verifyUrl: string, reason: string): void;
  /** Grant `role` on `path` to `user:<email>`, `group:<g>` or `service:<name>`. */
  grant(principal: string, role: Role, path: string): void;
  /** A new service token that holds no grants. */
  limitedToken(): string;
}

export async function startMockRegistry(
  options: MockRegistryOptions = {},
): Promise<MockRegistry> {
  const token = options.token ?? "mock-token";
  const subject = options.subject ?? "mock-user";
  const org = options.org ?? "acme";
  const loginInterval = options.loginInterval ?? 0;
  const loginExpiresIn = options.loginExpiresIn ?? 600;
  const signIn = options.signIn ?? true;
  const store = memoryStore();
  let base = "";
  /** Publishes run one at a time, as the engine requires. */
  let queue: Promise<unknown> = Promise.resolve();

  const callers = new Map<string, Caller>([
    [
      token,
      {
        kind: "service",
        subject,
        principals: [`service:${subject}`],
      },
    ],
  ]);
  const grants: { principal: string; role: Role; path: string }[] = [
    { principal: `service:${subject}`, role: "publish", path: "*" },
    { principal: `service:${subject}`, role: "lock", path: "*" },
  ];
  const logins = new Map<string, Login>();
  let limited = 0;

  const summaries = (): LayerSummary[] => store.summaries();

  const rolesOf = (caller: Caller): NonNullable<Whoami["roles"]> => {
    const seen = new Set<string>();
    const roles: NonNullable<Whoami["roles"]> = [];
    for (const g of grants) {
      const key = `${g.role} ${g.path}`;
      if (caller.principals.includes(g.principal) && !seen.has(key)) {
        seen.add(key);
        roles.push({ role: g.role, path: g.path });
      }
    }
    return roles;
  };

  const may = (caller: Caller, role: Role, ref: string): boolean =>
    rolesOf(caller).some((g) => g.role === role && grantCovers(g.path, ref));

  const forbid = (caller: Caller, ref: string, role: Role) =>
    new Failure(403, [
      {
        code: "forbidden",
        ref,
        message: `${caller.subject} may not publish ${ref}: needs ${role} on ${ref}`,
      },
    ]);

  async function publish(
    caller: Caller,
    ref: string,
    body: unknown,
  ): Promise<Reply> {
    const run = queue.then(async () => {
      const request = PublishRequest.safeParse(body);
      if (request.success && request.data.dryRun !== true) {
        // Dry runs need no grant; a body that does not parse is the engine's to refuse.
        if (!may(caller, "publish", ref)) throw forbid(caller, ref, "publish");
        const wanted = locksOf(request.data.source);
        if (wanted !== undefined) {
          const latest = await store.latest(ref);
          const current = latest ? (locksOf(latest.source) ?? []) : [];
          if (
            wanted.join("\n") !== current.join("\n") &&
            !may(caller, "lock", ref)
          ) {
            throw forbid(caller, ref, "lock");
          }
        }
      }
      return publishLayer(store, ref, body, {
        subject: caller.subject,
        now: new Date(),
      });
    });
    queue = run.catch(() => undefined);
    const outcome = await run;
    if ("problem" in outcome) {
      throw new Failure(outcome.status, outcome.problem.problems ?? []);
    }
    return { status: outcome.status, body: outcome.result };
  }

  function startLogin(): Reply {
    const code = Array.from(
      { length: 8 },
      () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]!,
    ).join("");
    const loginId = randomBytes(12).toString("hex");
    const pollSecret = randomBytes(24).toString("hex");
    const verifyUrl = `${base}/login/${code}`;
    logins.set(loginId, {
      code,
      pollSecret,
      verifyUrl,
      interval: loginInterval,
      expiresAt: Date.now() + loginExpiresIn * 1000,
      state: "pending",
    });
    return {
      status: 201,
      body: {
        loginId,
        verifyUrl,
        code,
        pollSecret,
        interval: loginInterval,
        expiresIn: loginExpiresIn,
      },
    };
  }

  function pollLogin(loginId: string, body: unknown): Reply {
    const poll = LoginPoll.safeParse(body);
    if (!poll.success)
      throw refuse(422, "invalid", "body must be { pollSecret }");
    const login = logins.get(loginId);
    if (!login || login.pollSecret !== poll.data.pollSecret) {
      throw refuse(404, "not-found", "no such login");
    }
    const now = Date.now();
    if (login.state === "redeemed" || now >= login.expiresAt) {
      throw refuse(410, "login-expired", "the login expired or was used");
    }
    const tooSoon =
      login.lastPoll !== undefined &&
      now - login.lastPoll < login.interval * 1000;
    login.lastPoll = now;
    if (tooSoon) {
      throw refuse(429, "slow-down", `poll at most every ${login.interval}s`);
    }
    if (login.state === "pending") {
      throw refuse(428, "authorization-pending", "the sign-in is not finished");
    }
    if (login.state === "refused") {
      login.state = "redeemed";
      throw refuse(403, "forbidden", login.reason ?? "sign-in refused");
    }
    const identity = login.identity!;
    login.state = "redeemed";
    const sessionToken = `donn_${randomBytes(24).toString("hex")}`;
    const expiresAt = new Date(now + SESSION_DAYS * 24 * 60 * 60 * 1000);
    callers.set(sessionToken, {
      kind: "session",
      subject: identity.email,
      principals: [
        `user:${identity.email}`,
        ...(identity.groups ?? []).map((g) => `group:${g}`),
      ],
      expiresAt,
    });
    return {
      status: 200,
      body: {
        token: sessionToken,
        subject: identity.email,
        expiresAt: expiresAt.toISOString(),
      },
    };
  }

  function loginAt(verifyUrl: string): Login {
    for (const login of logins.values()) {
      if (login.verifyUrl === verifyUrl) return login;
    }
    throw new Error(`no login at ${verifyUrl}`);
  }

  const published = publishedSource((ref) => store.latest(ref));

  async function managedBundle(url: URL): Promise<Reply> {
    const query = (name: string) => url.searchParams.get(name);
    const invalid = (message: string) =>
      refuse(400, "invalid-request", message);
    const layer = query("layer");
    if (layer === null || !LayerRef.safeParse(layer).success) {
      throw invalid("layer must be an org/, area/ or team/ ref");
    }
    const os = query("os");
    if (os === null || !(MANAGED_OSES as readonly string[]).includes(os)) {
      throw invalid(`os must be one of ${MANAGED_OSES.join(", ")}`);
    }
    const format = query("format") ?? "bundle";
    if (!(MANAGED_FORMATS as readonly string[]).includes(format)) {
      throw invalid(`format must be one of ${MANAGED_FORMATS.join(", ")}`);
    }
    const include = query("include") ?? "all";
    if (!(MANAGED_INCLUDES as readonly string[]).includes(include)) {
      throw invalid(`include must be one of ${MANAGED_INCLUDES.join(", ")}`);
    }
    if (!/^(org|area|team)\//.test(layer)) {
      throw invalid("a managed bundle takes an org, area or team layer");
    }
    if ((await store.latest(layer)) === undefined) {
      throw refuse(404, "not-found", `${layer} is not published`, {
        ref: layer,
      });
    }
    if (format !== "bundle" || options.managed === undefined) {
      throw refuse(
        501,
        "format-unsupported",
        `this registry does not build the ${format} format`,
      );
    }
    const { ir } = await resolve(layer, { source: published.source });
    const layers: ManagedLayer[] = [];
    for (const ref of ir.layers) {
      const latest = (await store.latest(ref))!;
      layers.push({ ref, version: latest.version, digest: latest.digest });
    }
    const result = await compileFromSource(options.managed, {
      source: published.source,
      ref: layer,
      os: os as (typeof MANAGED_OSES)[number],
      layers,
      donn: "registry-mock",
      readFile: published.readFile,
    });
    if (result.bundle === undefined) {
      throw new Failure(
        422,
        result.report.entries
          .filter((e) => e.outcome === "refused")
          .map((e) => ({
            code: "managed-refused" as const,
            ref: e.layer,
            path: e.path,
            message: `${e.path}: ${e.code ?? "refused"}: ${e.reason}`,
          })),
      );
    }
    return {
      status: 200,
      body: {
        manifest: result.bundle.manifest,
        files: Object.fromEntries(
          Object.entries(result.bundle.files).map(([path, bytes]) => [
            path,
            Buffer.from(bytes).toString("base64"),
          ]),
        ),
      },
    };
  }

  async function route(
    request: IncomingMessage,
    method: string,
    path: string,
    url: URL,
  ): Promise<Reply> {
    if (method === "POST" && path === "/v1/auth/logins") {
      if (!signIn)
        throw refuse(404, "not-found", "this registry has no sign-in");
      return startLogin();
    }
    const polled = /^\/v1\/auth\/logins\/([^/]+)\/token$/.exec(path);
    if (method === "POST" && polled) {
      if (!signIn)
        throw refuse(404, "not-found", "this registry has no sign-in");
      let loginId: string;
      try {
        loginId = decodeURIComponent(polled[1]!);
      } catch {
        throw refuse(404, "not-found", "no such login");
      }
      return pollLogin(loginId, await readJson(request));
    }
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "");
    const caller = bearer ? callers.get(bearer[1]!) : undefined;
    if (
      !caller ||
      (caller.expiresAt && caller.expiresAt.getTime() <= Date.now())
    ) {
      throw refuse(401, "unauthorized", "missing or refused token");
    }
    if (method === "GET" && path === "/v1/whoami") {
      const body: Whoami = {
        subject: caller.subject,
        org,
        kind: caller.kind,
        roles: rolesOf(caller),
        ...(caller.expiresAt
          ? { expiresAt: caller.expiresAt.toISOString() }
          : {}),
      };
      return { status: 200, body };
    }
    if (method === "GET" && path === "/v1/layers") {
      return { status: 200, body: summaries() };
    }
    if (method === "GET" && path === "/v1/managed/bundle") {
      return managedBundle(url);
    }
    const match = /^\/v1\/layers\/([^/]+)\/versions(?:\/([^/]+))?$/.exec(path);
    if (match) {
      let ref: string;
      try {
        ref = decodeURIComponent(match[1]!);
      } catch {
        throw refuse(404, "not-found", `no layer at ${match[1]!}`);
      }
      if (method === "GET" && match[2] !== undefined) {
        const versions = store.versions(ref);
        const wanted = match[2];
        const found =
          wanted === "latest"
            ? versions?.at(-1)
            : /^[1-9][0-9]*$/.test(wanted)
              ? versions?.[Number(wanted) - 1]
              : undefined;
        if (!found)
          throw refuse(404, "not-found", `${ref} @${wanted} is not published`, {
            ref,
          });
        return { status: 200, body: found };
      }
      if (method === "POST" && match[2] === undefined) {
        return publish(caller, ref, await readJson(request));
      }
    }
    throw refuse(404, "not-found", `no route for ${method} ${path}`);
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    route(request, request.method ?? "GET", url.pathname, url)
      .catch((error: unknown) => {
        if (error instanceof Failure) return error;
        throw error;
      })
      .then((result) => {
        const reply: Reply =
          result instanceof Failure
            ? {
                status: result.status,
                body: problemOf(result.status, result.problems),
              }
            : result;
        response.writeHead(reply.status, {
          "content-type":
            reply.status >= 400
              ? "application/problem+json"
              : "application/json",
        });
        response.end(JSON.stringify(reply.body));
      })
      .catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/problem+json" });
        response.end(
          JSON.stringify({
            type: "about:blank",
            title: "Internal error",
            status: 500,
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
      });
  });

  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  return {
    url: base,
    token,
    layers: summaries,
    completeLogin(verifyUrl, identity) {
      const login = loginAt(verifyUrl);
      login.state = "done";
      login.identity = identity;
    },
    refuseLogin(verifyUrl, reason) {
      const login = loginAt(verifyUrl);
      login.state = "refused";
      login.reason = reason;
    },
    grant(principal, role, path) {
      grants.push({ principal, role, path });
    },
    limitedToken() {
      limited += 1;
      const name = `limited-${limited}`;
      const limitedTokenValue = `limited-token-${randomBytes(12).toString("hex")}`;
      callers.set(limitedTokenValue, {
        kind: "service",
        subject: name,
        principals: [`service:${name}`],
      });
      return limitedTokenValue;
    },
    stop: () =>
      new Promise<void>((resolveStop, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolveStop()));
      }),
  };
}

/** The JSON body, or a bundle-too-large failure when it passes MAX_BODY_BYTES. */
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw refuse(
        422,
        "bundle-too-large",
        `request body is over ${MAX_BODY_BYTES} bytes`,
      );
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw refuse(422, "invalid", "request body is not JSON");
  }
}
