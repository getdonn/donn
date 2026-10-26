import { z } from "zod";
import { Change } from "./common.js";

/**
 * `donn whoami --json`: `{ loggedIn: false }` when there is no registry or no token, else who
 * the registry says the token is. `kind`, `roles` and `expiresAt` appear when the registry
 * sends them (a registry older than spec 20 sends neither).
 */
export const WhoamiOutput = z.union([
  z.strictObject({ loggedIn: z.literal(false) }),
  z.strictObject({
    loggedIn: z.literal(true),
    url: z.string(),
    subject: z.string(),
    org: z.string(),
    kind: z.string().optional(),
    roles: z
      .array(z.strictObject({ role: z.string(), path: z.string() }))
      .optional(),
    expiresAt: z.string().optional(),
  }),
]);
export type WhoamiOutput = z.infer<typeof WhoamiOutput>;

/**
 * `donn login --json`, two shapes: signed in through the browser (a session that expires), or
 * with a token (`--token`, `--token-stdin`), which says where the token was stored.
 */
export const LoginOutput = z.union([
  z.strictObject({
    url: z.string(),
    subject: z.string(),
    expiresAt: z.string(),
  }),
  z.strictObject({
    url: z.string(),
    subject: z.string(),
    org: z.string(),
    tokenStore: z.enum(["keychain", "file"]),
  }),
]);
export type LoginOutput = z.infer<typeof LoginOutput>;

/** `donn logout --json`: false when there was no token to remove. */
export const LogoutOutput = z.strictObject({ loggedOut: z.boolean() });
export type LogoutOutput = z.infer<typeof LogoutOutput>;

/** `donn pull --json`: `to` is absent for a layer that was removed, `from` for a new one. */
export const PullOutput = z.strictObject({
  changes: z.array(
    z.strictObject({
      ref: z.string(),
      from: z.number().int().optional(),
      to: z.number().int().optional(),
    }),
  ),
});
export type PullOutput = z.infer<typeof PullOutput>;

const Digest = z.string();

/**
 * `donn publish --json`, three shapes (all carry `ref`): `--dry-run` (`dryRun`, the diff and the
 * layers that would break; nothing stored), `unchanged` (the registry already has these bytes),
 * and a new version. `cacheUpdated` is false when the registry accepted the publish but the local
 * cache could not be refreshed.
 */
export const PublishOutput = z.union([
  z.strictObject({
    ref: z.string(),
    dryRun: z.literal(true),
    diff: z.array(Change),
    broken: z.array(z.string()),
  }),
  z.strictObject({
    ref: z.string(),
    unchanged: z.literal(true),
    version: z.number().int(),
    digest: Digest,
    cacheUpdated: z.boolean(),
  }),
  z.strictObject({
    ref: z.string(),
    version: z.number().int(),
    digest: Digest,
    broken: z.array(z.string()),
    cacheUpdated: z.boolean(),
  }),
]);
export type PublishOutput = z.infer<typeof PublishOutput>;
