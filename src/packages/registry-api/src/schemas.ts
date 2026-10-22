import { z } from "zod";

// The registry's wire format. Every request and response has a schema here; the client, the mock
// and the real server all validate against these. See docs/planning/18-registry-contract.md §1.

/** A publishable layer ref: org/<name>, area/<name> or team/<name>. */
export const LayerRef = z
  .string()
  .regex(
    /^(org|area|team)\/[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/,
    "must be org/<name>, area/<name> or team/<name>",
  );
export type LayerRef = z.infer<typeof LayerRef>;

type ObjectOf = typeof z.object | typeof z.strictObject;

const bundleFileOf = (object: ObjectOf) =>
  object({
    path: z.string().min(1),
    content: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, "must be base64"),
  });

/** A file in a bundle: `path` relative to the layer's folder (posix, no `..`), base64 `content`. */
export const BundleFile = bundleFileOf(z.strictObject);
export type BundleFile = z.infer<typeof BundleFile>;

/** What a principal may do on a layer path. */
export const Role = z.enum(["publish", "lock"]);
export type Role = z.infer<typeof Role>;

const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

// Response schemas are tolerant (`z.object`: unknown keys are stripped) so a client keeps working
// when a server adds fields; `ConformanceSchemas` holds strict copies the kit checks servers with.
// Request schemas stay strict. See docs/planning/20-registry-identity.md §2.

const whoamiShape = (
  object: ObjectOf,
  kind: z.ZodType<string> = z.enum(["session", "service"]),
  role: z.ZodType<string> = Role,
  datetime: z.ZodType<string> = z.iso.datetime(),
) => ({
  subject: z.string().min(1),
  org: z.string().min(1),
  kind: kind.optional(),
  roles: z.array(object({ role, path: z.string().min(1) })).optional(),
  expiresAt: datetime.optional(),
});
export const Whoami = z.object(
  whoamiShape(
    z.object,
    z.string(),
    z.string(),
    z.iso.datetime({ offset: true }),
  ),
);
export type Whoami = z.infer<typeof Whoami>;

const layerSummaryShape = {
  ref: LayerRef,
  version: z.int().min(1),
  digest: Digest,
};
export const LayerSummary = z.object(layerSummaryShape);
export type LayerSummary = z.infer<typeof LayerSummary>;

const layerVersionShape = (object: ObjectOf) => ({
  ...layerSummaryShape,
  source: z.string(),
  files: z.array(bundleFileOf(object)),
  publishedAt: z.iso.datetime(),
  publishedBy: z.string().min(1),
});
export const LayerVersion = z.object(layerVersionShape(z.object));
export type LayerVersion = z.infer<typeof LayerVersion>;

export const PublishRequest = z.strictObject({
  source: z.string(),
  files: z.array(BundleFile),
  baseVersion: z.int().min(0),
  dryRun: z.boolean().optional(),
  force: z.boolean().optional(),
});
export type PublishRequest = z.infer<typeof PublishRequest>;

/** One change in a dry-run diff; mirrors the resolver's `Change`. */
const changeOf = (object: ObjectOf) =>
  object({
    path: z.string(),
    change: z.enum(["added", "removed", "changed"]),
    from: z.unknown().optional(),
    to: z.unknown().optional(),
    fromLayer: z.string().optional(),
    toLayer: z.string().optional(),
  });
export const Change = changeOf(z.object);
export type Change = z.infer<typeof Change>;

// Marker variants come first: a union takes the first match and a tolerant object strips unknown
// keys, so a dry run (or unchanged) answer with extra fields must not match the published shape.
const publishResultVariants = (object: ObjectOf) =>
  [
    object({
      dryRun: z.literal(true),
      diff: z.array(changeOf(object)),
      broken: z.array(LayerRef),
    }),
    object({
      unchanged: z.literal(true),
      version: z.int().min(1),
      digest: Digest,
    }),
    object({
      version: z.int().min(1),
      digest: Digest,
      broken: z.array(LayerRef),
    }),
  ] as const;
export const PublishResult = z.union(publishResultVariants(z.object));
export type PublishResult = z.infer<typeof PublishResult>;

export const PROBLEM_CODES = [
  "unauthorized",
  "not-found",
  "stale-base",
  "invalid",
  "not-publishable",
  "missing-file",
  "path-escapes-layer",
  "bundle-too-large",
  "unpublished-ancestor",
  "lock-violation",
  "breaks-descendants",
  "forbidden",
  "authorization-pending",
  "slow-down",
  "login-expired",
] as const;
export const ProblemCode = z.enum(PROBLEM_CODES);
export type ProblemCode = z.infer<typeof ProblemCode>;

const problemShape = (code: z.ZodType<string>, object: ObjectOf) => ({
  type: z.string(),
  title: z.string(),
  status: z.int(),
  detail: z.string(),
  problems: z
    .array(
      object({
        code,
        ref: z.string().optional(),
        path: z.string().optional(),
        message: z.string(),
      }),
    )
    .optional(),
});

/** An `application/problem+json` body; any `code` string is kept (servers may add codes). */
export const Problem = z.object(problemShape(z.string(), z.object));
export type Problem = z.infer<typeof Problem>;

// Sign-in: docs/planning/20-registry-identity.md §1.

const loginStartShape = {
  loginId: z.string().min(1),
  verifyUrl: z.string().min(1),
  code: z.string().regex(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/),
  pollSecret: z.string().min(1),
  interval: z.int().min(0),
  expiresIn: z.int().min(1),
};
export const LoginStart = z.object(loginStartShape);
export type LoginStart = z.infer<typeof LoginStart>;

export const LoginPoll = z.strictObject({ pollSecret: z.string().min(1) });
export type LoginPoll = z.infer<typeof LoginPoll>;

const loginTokenShape = (datetime: z.ZodType<string> = z.iso.datetime()) => ({
  token: z.string().min(1),
  subject: z.string().min(1),
  expiresAt: datetime,
});
// Tolerant: a failed parse would lose a single-use token, so offsets are accepted.
export const LoginToken = z.object(
  loginTokenShape(z.iso.datetime({ offset: true })),
);
export type LoginToken = z.infer<typeof LoginToken>;

/** Strict copies of the response schemas: the conformance kit checks servers with these. */
export const ConformanceSchemas = {
  Whoami: z.strictObject(whoamiShape(z.strictObject)),
  LayerSummary: z.strictObject(layerSummaryShape),
  LayerVersion: z.strictObject(layerVersionShape(z.strictObject)),
  PublishResult: z.union(publishResultVariants(z.strictObject)),
  Change: changeOf(z.strictObject),
  Problem: z.strictObject(problemShape(ProblemCode, z.strictObject)),
  LoginStart: z.strictObject(loginStartShape),
  LoginToken: z.strictObject(loginTokenShape()),
} as const;

/**
 * Whether a grant on `path` covers `ref`: `*` covers everything; otherwise the ref is the path or
 * lies under it, by whole segment (`team/pay` does not cover `team/payments`).
 */
export function grantCovers(path: string, ref: string): boolean {
  return path === "*" || ref === path || ref.startsWith(path + "/");
}
