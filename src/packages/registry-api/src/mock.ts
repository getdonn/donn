import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { posix } from "node:path";
import { parse } from "yaml";
import {
  ResolveError,
  diff,
  resolve,
  type PersonaSource,
} from "@zzpersona/resolver";
import { Persona, PersonaDocument } from "@zzpersona/spec";
import { MAX_BUNDLE_BYTES, bundleDigest, referencedPaths } from "./bundle.js";
import {
  LayerRef,
  PublishRequest,
  type LayerSummary,
  type LayerVersion,
  type ProblemCode,
} from "./schemas.js";

// An in-memory registry that implements docs/planning/18-registry-contract.md §1-§2. It is the
// reference for the conformance kit, and the server the client's tests run against.

/** A request body over this is refused before parsing, as bundle-too-large. */
const MAX_BODY_BYTES = 15 * 1024 * 1024;

const TITLES: Record<number, string> = {
  401: "Unauthorized",
  404: "Not found",
  409: "Conflict",
  422: "Unprocessable bundle",
};

interface ProblemItem {
  code: ProblemCode;
  ref?: string;
  path?: string;
  message: string;
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
}

export interface MockRegistry {
  url: string;
  token: string;
  stop(): Promise<void>;
  /** The latest version of every published layer. */
  layers(): LayerSummary[];
}

export async function startMockRegistry(
  options: MockRegistryOptions = {},
): Promise<MockRegistry> {
  const token = options.token ?? "mock-token";
  const subject = options.subject ?? "mock-user";
  const org = options.org ?? "acme";
  const store = new Map<string, LayerVersion[]>();

  const latest = (ref: string): LayerVersion | undefined =>
    store.get(ref)?.at(-1);
  const summaries = (): LayerSummary[] =>
    [...store.keys()].sort().map((ref) => {
      const { version, digest } = latest(ref)!;
      return { ref, version, digest };
    });

  /** The published layers as the resolver's source, with `candidate` in place of its ref. */
  const sourceWith = (candidate?: {
    ref: string;
    raw: unknown;
  }): PersonaSource => ({
    load: (ref) => {
      if (candidate?.ref === ref) return Promise.resolve(candidate.raw);
      const version = latest(ref);
      return Promise.resolve(
        version === undefined ? undefined : (parse(version.source) as unknown),
      );
    },
  });

  const resolves = async (ref: string, source: PersonaSource) => {
    try {
      return await resolve(ref, { source });
    } catch (error) {
      if (error instanceof ResolveError) return undefined;
      throw error;
    }
  };

  function checkBundle(ref: string, request: PublishRequest): Persona {
    let raw: unknown;
    try {
      raw = parse(request.source);
    } catch (error) {
      throw refuse(
        422,
        "invalid",
        `${ref}: YAML does not parse: ${(error as Error).message}`,
        { ref },
      );
    }
    const parsed = PersonaDocument.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw refuse(422, "invalid", `${ref}: ${issues}`, { ref });
    }
    if (parsed.data.kind !== "Persona") {
      throw refuse(422, "invalid", `${ref}: expected kind: Persona`, { ref });
    }
    const doc = parsed.data;

    const seen = new Set<string>();
    for (const { path } of request.files) {
      const clean = posix.normalize(path);
      if (posix.isAbsolute(path) || clean === ".." || clean.startsWith("../")) {
        throw refuse(
          422,
          "path-escapes-layer",
          `${path} is outside the layer's folder`,
          { ref, path },
        );
      }
      if (seen.has(clean)) {
        throw refuse(422, "invalid", `${path} appears twice in the bundle`, {
          ref,
          path,
        });
      }
      seen.add(clean);
    }

    const bytes =
      Buffer.byteLength(request.source) +
      request.files.reduce(
        (sum, f) => sum + Buffer.from(f.content, "base64").length,
        0,
      );
    if (bytes > MAX_BUNDLE_BYTES) {
      throw refuse(
        422,
        "bundle-too-large",
        `bundle is ${bytes} bytes; the limit is ${MAX_BUNDLE_BYTES}`,
        { ref },
      );
    }

    const { files, dirs } = referencedPaths(doc);
    const problems: ProblemItem[] = [];
    for (const path of [...files, ...dirs]) {
      const clean = posix.normalize(path);
      if (
        clean === ".." ||
        clean.startsWith("../") ||
        posix.isAbsolute(clean)
      ) {
        problems.push({
          code: "path-escapes-layer",
          ref,
          path,
          message: `${path} is outside the layer's folder`,
        });
      }
    }
    if (problems.length > 0) throw new Failure(422, problems);
    for (const path of files) {
      if (!seen.has(path))
        problems.push({
          code: "missing-file",
          ref,
          path,
          message: `${path} is referenced but not in the bundle`,
        });
    }
    for (const path of dirs) {
      if (![...seen].some((p) => p.startsWith(`${path}/`)))
        problems.push({
          code: "missing-file",
          ref,
          path,
          message: `${path}/ is referenced but has no files in the bundle`,
        });
    }
    if (problems.length > 0) throw new Failure(422, problems);
    return doc;
  }

  async function publish(ref: string, body: unknown): Promise<Reply> {
    if (!LayerRef.safeParse(ref).success) {
      if (/^(project|user)\//.test(ref)) {
        throw refuse(
          422,
          "not-publishable",
          `${ref} cannot be published: only org, area and team layers can`,
          { ref },
        );
      }
      throw refuse(422, "invalid", `${ref} is not a layer ref`, { ref });
    }
    const parsed = PublishRequest.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw refuse(422, "invalid", `request body: ${issues}`);
    }
    const request = parsed.data;
    const doc = checkBundle(ref, request);

    for (const parent of doc.extends ?? []) {
      if (parent !== ref && latest(parent) === undefined) {
        throw refuse(
          422,
          "unpublished-ancestor",
          `${ref} extends ${parent}, which is not published`,
          { ref: parent },
        );
      }
    }

    const candidate = { ref, raw: parse(request.source) as unknown };
    const before = sourceWith();
    const after = sourceWith(candidate);
    let resolved;
    try {
      resolved = await resolve(ref, { source: after });
    } catch (error) {
      if (error instanceof ResolveError && error.code === "lock-violation") {
        const d = error.details as {
          path: string;
          lock: string;
          lockedBy: string;
          layer: string;
        };
        throw refuse(
          422,
          "lock-violation",
          `${d.layer} changes ${d.path}, which ${d.lockedBy} locks (${d.lock})`,
          { ref: d.layer, path: d.path },
        );
      }
      if (error instanceof ResolveError && error.code === "missing-ref") {
        const d = error.details as { ref: string };
        throw refuse(422, "unpublished-ancestor", `${d.ref} is not published`, {
          ref: d.ref,
        });
      }
      if (error instanceof ResolveError) {
        throw refuse(
          422,
          "invalid",
          `${ref} does not resolve: ${error.message}`,
          { ref },
        );
      }
      throw error;
    }

    // A published layer is broken when it resolved before this change and throws after it.
    const broken: string[] = [];
    for (const other of [...store.keys()].sort()) {
      if (other === ref) continue;
      const was = await resolves(other, before);
      if (was === undefined || !was.ir.layers.includes(ref)) continue;
      if ((await resolves(other, after)) === undefined) broken.push(other);
    }

    const current = latest(ref);
    if (request.dryRun) {
      const previous = current && (await resolves(ref, before));
      return {
        status: 200,
        body: {
          dryRun: true,
          diff: previous ? diff(previous, resolved) : [],
          broken,
        },
      };
    }
    if (broken.length > 0 && !request.force) {
      throw new Failure(
        422,
        broken.map((other) => ({
          code: "breaks-descendants" as const,
          ref: other,
          message: `${other} no longer resolves with this change to ${ref}`,
        })),
      );
    }
    if (request.baseVersion !== (current?.version ?? 0)) {
      throw refuse(
        409,
        "stale-base",
        `${ref} is at version ${current?.version ?? 0}, not ${request.baseVersion}`,
        { ref },
      );
    }
    const digest = bundleDigest(request.source, request.files);
    if (current?.digest === digest) {
      return {
        status: 200,
        body: { unchanged: true, version: current.version, digest },
      };
    }
    const version = (current?.version ?? 0) + 1;
    store.set(ref, [
      ...(store.get(ref) ?? []),
      {
        ref,
        version,
        digest,
        source: request.source,
        files: request.files,
        publishedAt: new Date().toISOString(),
        publishedBy: subject,
      },
    ]);
    return { status: 201, body: { version, digest, broken } };
  }

  async function route(
    request: IncomingMessage,
    method: string,
    path: string,
  ): Promise<Reply> {
    if (request.headers.authorization !== `Bearer ${token}`) {
      throw refuse(401, "unauthorized", "missing or refused token");
    }
    if (method === "GET" && path === "/v1/whoami") {
      return { status: 200, body: { subject, org } };
    }
    if (method === "GET" && path === "/v1/layers") {
      return { status: 200, body: summaries() };
    }
    const match = /^\/v1\/layers\/([^/]+)\/versions(?:\/([^/]+))?$/.exec(path);
    if (match) {
      const ref = decodeURIComponent(match[1]!);
      if (method === "GET" && match[2] !== undefined) {
        const versions = store.get(ref);
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
        return publish(ref, await readJson(request));
      }
    }
    throw refuse(404, "not-found", `no route for ${method} ${path}`);
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    route(request, request.method ?? "GET", url.pathname)
      .catch((error: unknown) => {
        if (error instanceof Failure) return error;
        throw error;
      })
      .then((result) => {
        const reply: Reply =
          result instanceof Failure
            ? {
                status: result.status,
                body: {
                  type: `urn:zzpersona:problem:${result.problems[0]!.code}`,
                  title: TITLES[result.status] ?? "Error",
                  status: result.status,
                  detail: result.message,
                  problems: result.problems,
                },
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
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    layers: summaries,
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
