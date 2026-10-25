import { z } from "zod";
import { Ref } from "./common.js";

const ManagedReport = z.strictObject({
  entries: z.array(
    z.strictObject({
      path: z.string(),
      layer: Ref,
      outcome: z.enum(["enforced", "advisory", "refused"]),
      /** Set on refusals. */
      code: z
        .enum([
          "managed-secret",
          "managed-mcp-needs-exclusive",
          "managed-unknown-key",
          "managed-passthrough-conflict",
        ])
        .optional(),
      reason: z.string(),
    }),
  ),
  warnings: z.array(
    z.strictObject({
      code: z.enum([
        "partial-mode",
        "plugin-hooks-dropped",
        "console-hooks-approval",
      ]),
      message: z.string(),
    }),
  ),
});

/**
 * `donn managed build --json`, two shapes: a bundle written (`out` is its folder; `notice` says
 * when it enforces nothing), or refused (`out` is null and exit code is 1; nothing is written).
 */
export const ManagedBuildOutput = z.union([
  z.strictObject({
    out: z.string(),
    report: ManagedReport,
    notice: z.string().optional(),
  }),
  z.strictObject({ report: ManagedReport, out: z.null() }),
]);
export type ManagedBuildOutput = z.infer<typeof ManagedBuildOutput>;

const CHECK_STATES = [
  "ignored",
  "edited",
  "overridden",
  "stale",
  "missing",
  "current",
] as const;

/** The result of `donn managed check`, which `donn status` carries as `managed`. */
export const ManagedCheck = z.strictObject({
  state: z.enum(CHECK_STATES),
  findings: z.array(
    z.strictObject({
      state: z.enum(CHECK_STATES),
      detail: z.string(),
      fix: z.string().optional(),
    }),
  ),
});
export type ManagedCheck = z.infer<typeof ManagedCheck>;

/** `donn managed check --json`; the exit code is 1 unless the state is `current`. */
export const ManagedCheckOutput = ManagedCheck;
export type ManagedCheckOutput = ManagedCheck;
