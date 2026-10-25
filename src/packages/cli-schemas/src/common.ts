import { z } from "zod";

// Pieces several commands print. Kept free of validation the CLI does not itself guarantee
// (kebab-case ids, ref grammar): these schemas describe output, they do not police it.

/** `<layer>/<name>`: a persona reference. */
export const Ref = z.string().min(1);

export const HARNESS_IDS = ["claude-code", "codex", "agents-md"] as const;

/** A compile report: what an adapter could not carry over as it was (`CompileReport`). */
export const CompileReport = z.strictObject({
  adapter: z.string(),
  irVersion: z.number().int(),
  /** Set when detection changed the strategy. */
  mode: z.string().optional(),
  entries: z.array(
    z.strictObject({
      path: z.string(),
      outcome: z.enum(["approximated", "advisory", "dropped"]),
      reason: z.string(),
      lock: z.strictObject({ path: z.string(), layer: Ref }).optional(),
    }),
  ),
});
export type CompileReport = z.infer<typeof CompileReport>;

/** One change between two resolved personas (the resolver's `Change`, the registry's `Change`). */
export const Change = z.strictObject({
  path: z.string(),
  change: z.enum(["added", "removed", "changed"]),
  from: z.unknown().optional(),
  to: z.unknown().optional(),
  fromLayer: z.string().optional(),
  toLayer: z.string().optional(),
});
export type Change = z.infer<typeof Change>;

export const AgentTarget = z.enum(["local", "self-host", "vercel"]);

/** The states `donn agent list` gives an agent. */
export const AgentState = z.enum([
  "available",
  "created",
  "running",
  "built",
  "deployed",
]);

/** The persona field that changed what a sync cannot rewrite. */
export const RecreateField = z.enum(["template", "target", "path", "world"]);
