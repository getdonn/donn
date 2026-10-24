import { posix } from "node:path";
import { parse } from "yaml";
import {
  ResolveError,
  diff,
  resolve,
  type PersonaSource,
} from "@getdonn/resolver";
import { PersonaDocument, type Persona } from "@getdonn/spec";
import {
  MAX_BUNDLE_BYTES,
  bundleDigest,
  normalizeBundlePath,
  referencedPaths,
} from "./bundle.js";
import {
  LayerRef,
  PublishRequest,
  type LayerSummary,
  type LayerVersion,
  type Problem,
  type ProblemCode,
  type PublishResult,
} from "./schemas.js";

// The publish rules of docs/planning/18-registry-contract.md §2 (as amended), over any storage.
// See docs/planning/19-publish-engine.md. The engine never serialises: the caller must hold an
// org-wide lock for the whole publish (in a SQL store, a transaction holding an org-wide
// advisory lock, or serializable isolation). A per-ref lock is not enough: publishing org/base (adding a
// lock) and team/web (setting the locked path) at once touch different rows, and both would pass.

/** Where published layers live: memory in the mock, a database in a real registry. */
export interface LayerStore {
  /**
   * The latest version of `ref`, or undefined when it was never published. A publish reads each
   * ref at most once (the engine memoises), so every read in one publish sees the same version.
   */
  latest(ref: string): Promise<LayerVersion | undefined>;
  /** Every published ref of the publishing org; read once per publish. */
  refs(): Promise<string[]>;
  /**
   * Store a new version. Called at most once per publish, last, only after every check passed,
   * with `version` = the latest version read in this publish + 1; no read follows it, so
   * read-your-writes is not needed. Must reject when `(ref, version)` already exists (a unique
   * constraint in a SQL store), so a missing lock can never store two versions with one number.
   */
  insert(version: LayerVersion): Promise<void>;
}

/** Each ref read at most once, and refs() once, for the length of one publish. */
function memoised(store: LayerStore): LayerStore {
  const latest = new Map<string, Promise<LayerVersion | undefined>>();
  let refs: Promise<string[]> | undefined;
  return {
    latest: (ref) => {
      let read = latest.get(ref);
      if (read === undefined) {
        read = store.latest(ref);
        latest.set(ref, read);
      }
      return read;
    },
    refs: () => (refs ??= store.refs()),
    insert: (version) => store.insert(version),
  };
}

export type PublishOutcome =
  | {
      status: 201;
      result: PublishResult;
      inserted: LayerVersion;
      broken: string[];
    }
  | { status: 200; result: PublishResult }
  | { status: 401 | 404 | 409 | 413 | 422; problem: Problem };

type ProblemItem = NonNullable<Problem["problems"]>[number];

const TITLES: Record<number, string> = {
  400: "Invalid request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
  410: "Gone",
  413: "Payload too large",
  422: "Unprocessable bundle",
  428: "Precondition required",
  429: "Too many requests",
  501: "Not implemented",
};

/** An `application/problem+json` body for these problems. */
export function problemOf(status: number, problems: ProblemItem[]): Problem {
  return {
    type: `urn:donn:problem:${problems[0]!.code}`,
    title: TITLES[status] ?? "Error",
    status,
    detail: problems.map((p) => p.message).join("; "),
    problems,
  };
}

class Refusal {
  constructor(
    readonly status: 409 | 422,
    readonly problems: ProblemItem[],
  ) {}
}

const refuse = (
  status: 409 | 422,
  code: ProblemCode,
  message: string,
  rest: { ref?: string; path?: string } = {},
) => new Refusal(status, [{ code, message, ...rest }]);

/** Publish `request` as the next version of `ref`, or say why not. */
export async function publishLayer(
  store: LayerStore,
  ref: string,
  request: unknown,
  context: { subject: string; now: Date },
): Promise<PublishOutcome> {
  try {
    return await run(store, ref, request, context);
  } catch (error) {
    if (error instanceof Refusal) {
      return {
        status: error.status,
        problem: problemOf(error.status, error.problems),
      };
    }
    throw error;
  }
}

async function run(
  backing: LayerStore,
  ref: string,
  body: unknown,
  context: { subject: string; now: Date },
): Promise<PublishOutcome> {
  const store = memoised(backing);
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
    // An issue inside files[n] names that file, so the publisher knows which one.
    const at = parsed.error.issues.find(
      (i) => i.path[0] === "files" && typeof i.path[1] === "number",
    )?.path[1] as number | undefined;
    const path = (body as { files?: { path?: unknown }[] } | null)?.files?.[
      at ?? -1
    ]?.path;
    throw refuse(
      422,
      "invalid",
      `request body: ${issues}`,
      typeof path === "string" ? { path } : {},
    );
  }
  const request = parsed.data;
  const doc = checkBundle(ref, request);

  const current = await store.latest(ref);
  const digest = bundleDigest(request.source, request.files);
  if (!request.dryRun) {
    if (request.baseVersion !== (current?.version ?? 0)) {
      throw refuse(
        409,
        "stale-base",
        `${ref} is at version ${current?.version ?? 0}, not ${request.baseVersion}`,
        { ref },
      );
    }
    if (current?.digest === digest) {
      return {
        status: 200,
        result: { unchanged: true, version: current.version, digest },
      };
    }
  }

  for (const parent of doc.extends ?? []) {
    if (parent !== ref && (await store.latest(parent)) === undefined) {
      throw refuse(
        422,
        "unpublished-ancestor",
        `${ref} extends ${parent}, which is not published`,
        { ref: parent },
      );
    }
  }

  const candidate = { ref, raw: parse(request.source) as unknown };
  const before = sourceOf(store);
  const after = sourceOf(store, candidate);
  const resolved = await resolveCandidate(ref, after);

  // A published layer is broken when it resolved before this change and throws after it.
  const broken: string[] = [];
  for (const other of [...(await store.refs())].sort()) {
    if (other === ref) continue;
    const was = await resolves(other, before);
    if (was === undefined || !was.ir.layers.includes(ref)) continue;
    if ((await resolves(other, after)) === undefined) broken.push(other);
  }

  if (request.dryRun) {
    const previous = current && (await resolves(ref, before));
    return {
      status: 200,
      result: {
        dryRun: true,
        diff: previous ? diff(previous, resolved) : [],
        broken,
      },
    };
  }
  if (broken.length > 0 && !request.force) {
    throw new Refusal(
      422,
      broken.map((other) => ({
        code: "breaks-descendants" as const,
        ref: other,
        message: `${other} no longer resolves with this change to ${ref}`,
      })),
    );
  }
  const inserted: LayerVersion = {
    ref,
    version: (current?.version ?? 0) + 1,
    digest,
    source: request.source,
    files: request.files,
    publishedAt: context.now.toISOString(),
    publishedBy: context.subject,
  };
  await store.insert(inserted);
  return {
    status: 201,
    result: { version: inserted.version, digest, broken },
    inserted,
    broken,
  };
}

/** The published layers as the resolver's source, with `candidate` in place of its ref. */
function sourceOf(
  store: LayerStore,
  candidate?: { ref: string; raw: unknown },
): PersonaSource {
  return {
    load: async (ref) => {
      if (candidate?.ref === ref) return candidate.raw;
      const version = await store.latest(ref);
      return version === undefined
        ? undefined
        : (parse(version.source) as unknown);
    },
  };
}

async function resolves(ref: string, source: PersonaSource) {
  try {
    return await resolve(ref, { source });
  } catch (error) {
    if (error instanceof ResolveError) return undefined;
    throw error;
  }
}

/** Resolve the candidate against the latest published ancestors; a failure is a problem. */
async function resolveCandidate(ref: string, source: PersonaSource) {
  try {
    return await resolve(ref, { source });
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
        {
          ref,
        },
      );
    }
    throw error;
  }
}

/** The bundle's own checks: YAML, schema, paths, size and referenced files. */
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
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(path)) {
      throw refuse(
        422,
        "invalid",
        `file path contains a control character: ${JSON.stringify(path)}`,
        { ref },
      );
    }
    const clean = normalizeBundlePath(path);
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
  for (const { path, content } of request.files) {
    // Canonical base64 only, so every server decodes the same bytes (and the same digest).
    if (Buffer.from(content, "base64").toString("base64") !== content) {
      throw refuse(422, "invalid", `${path} is not canonical base64`, {
        ref,
        path,
      });
    }
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
    const clean = normalizeBundlePath(path);
    if (clean === ".." || clean.startsWith("../") || posix.isAbsolute(clean)) {
      problems.push({
        code: "path-escapes-layer",
        ref,
        path,
        message: `${path} is outside the layer's folder`,
      });
    }
  }
  if (problems.length > 0) throw new Refusal(422, problems);
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
  if (problems.length > 0) throw new Refusal(422, problems);
  return doc;
}

/** Layers in memory: the mock's store, and a reference for tests. */
export function memoryStore(): LayerStore & {
  versions(ref: string): LayerVersion[];
  /** The latest version of every ref, sorted by ref. */
  summaries(): LayerSummary[];
} {
  const layers = new Map<string, LayerVersion[]>();
  return {
    latest: (ref) => Promise.resolve(layers.get(ref)?.at(-1)),
    refs: () => Promise.resolve([...layers.keys()]),
    insert: (version) => {
      const existing = layers.get(version.ref) ?? [];
      if (version.version !== existing.length + 1) {
        return Promise.reject(
          new Error(
            `${version.ref} version ${version.version} cannot follow version ${existing.length}`,
          ),
        );
      }
      layers.set(version.ref, [...existing, version]);
      return Promise.resolve();
    },
    versions: (ref) => layers.get(ref) ?? [],
    summaries: () =>
      [...layers.keys()].sort().map((ref) => {
        const { version, digest } = layers.get(ref)!.at(-1)!;
        return { ref, version, digest };
      }),
  };
}
