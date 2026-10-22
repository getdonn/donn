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

/** A file in a bundle: `path` relative to the layer's folder (posix, no `..`), base64 `content`. */
export const BundleFile = z.strictObject({
  path: z.string().min(1),
  content: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, "must be base64"),
});
export type BundleFile = z.infer<typeof BundleFile>;

export const Whoami = z.strictObject({
  subject: z.string().min(1),
  org: z.string().min(1),
});
export type Whoami = z.infer<typeof Whoami>;

const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const LayerSummary = z.strictObject({
  ref: LayerRef,
  version: z.int().min(1),
  digest: Digest,
});
export type LayerSummary = z.infer<typeof LayerSummary>;

export const LayerVersion = z.strictObject({
  ...LayerSummary.shape,
  source: z.string(),
  files: z.array(BundleFile),
  publishedAt: z.iso.datetime(),
  publishedBy: z.string().min(1),
});
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
export const Change = z.strictObject({
  path: z.string(),
  change: z.enum(["added", "removed", "changed"]),
  from: z.unknown().optional(),
  to: z.unknown().optional(),
  fromLayer: z.string().optional(),
  toLayer: z.string().optional(),
});
export type Change = z.infer<typeof Change>;

export const PublishResult = z.union([
  z.strictObject({
    version: z.int().min(1),
    digest: Digest,
    broken: z.array(LayerRef),
  }),
  z.strictObject({
    unchanged: z.literal(true),
    version: z.int().min(1),
    digest: Digest,
  }),
  z.strictObject({
    dryRun: z.literal(true),
    diff: z.array(Change),
    broken: z.array(LayerRef),
  }),
]);
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
] as const;
export const ProblemCode = z.enum(PROBLEM_CODES);
export type ProblemCode = z.infer<typeof ProblemCode>;

/** An `application/problem+json` body. */
export const Problem = z.strictObject({
  type: z.string(),
  title: z.string(),
  status: z.int(),
  detail: z.string(),
  problems: z
    .array(
      z.strictObject({
        code: ProblemCode,
        ref: z.string().optional(),
        path: z.string().optional(),
        message: z.string(),
      }),
    )
    .optional(),
});
export type Problem = z.infer<typeof Problem>;
