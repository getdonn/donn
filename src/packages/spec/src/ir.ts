import { z } from "zod";
import {
  AgentName,
  AgentTarget,
  EnvName,
  Hook,
  HookEvent,
  Id,
  withInstructionSource,
  IR_VERSION,
  KnowledgePointer,
  Labels,
  McpServer,
  Models,
  Policy,
  Ref,
  SecretProvider,
  ServerName,
  Targets,
} from "./common.js";

// The resolved persona: the harness-neutral contract between the resolver, every adapter, and
// the control plane. Versioned by IR_VERSION, independently of the persona file apiVersion.

const SortedRules = z.array(z.string().min(1));

export const ResolvedAgent = z.strictObject({
  template: z.string().min(1),
  target: AgentTarget,
  /** Normalized, project-relative; always set (default `agents/<name>`). */
  path: z.string().min(1),
  model: z.string().min(1).optional(),
  env: z.record(EnvName, z.string()),
});
export type ResolvedAgent = z.infer<typeof ResolvedAgent>;

export const ResolvedPersona = z.strictObject({
  irVersion: z.literal(IR_VERSION),
  /** Merge order, root first; the user overlay (if any) last. */
  layers: z.array(Ref).min(1),
  metadata: z.strictObject({
    name: z.string().min(1),
    version: z.int().positive().optional(),
    description: z.string().optional(),
    labels: Labels,
  }),
  /** Contract order. File paths are relative to the personas root. */
  instructions: z.array(withInstructionSource({ id: Id })),
  /** Sorted by name. */
  skills: z.array(z.strictObject({ name: Id, source: z.string().min(1) })),
  mcp: z.strictObject({
    gateway: z.string().optional(),
    servers: z.record(ServerName, McpServer),
  }),
  /** Each list sorted; an exact rule appears only in its strongest list (deny > ask > allow). */
  permissions: z.strictObject({
    allow: SortedRules,
    deny: SortedRules,
    ask: SortedRules,
  }),
  hooks: z.partialRecord(HookEvent, z.array(Hook)),
  knowledge: z.array(KnowledgePointer),
  secrets: z.strictObject({ providers: z.record(ServerName, SecretProvider) }),
  /** Declaration order. */
  locks: z.array(z.strictObject({ path: z.string().min(1), layer: Ref })),
  targets: Targets,
  /** Added after IR 1 as an optional field with a default, so IR_VERSION is unchanged. */
  policy: Policy.default({}),
  /** Likewise (spec 23): optional with a default, IR_VERSION unchanged. */
  models: Models.default({}),
  agents: z.record(AgentName, ResolvedAgent).default({}),
});
export type ResolvedPersona = z.infer<typeof ResolvedPersona>;

/** Which layer set each resolved value, keyed by path (see path.ts). */
export const Provenance = z.record(z.string(), Ref);
export type Provenance = z.infer<typeof Provenance>;

export const WARNING_CODES = [
  "allow-shadowed-by-deny",
  "ask-shadowed-by-deny",
  "allow-shadowed-by-ask",
  "security-removal",
  "remove-unmatched",
  "overlay-lock-ignored",
  "agent-removed",
] as const;
export const WarningCode = z.enum(WARNING_CODES);
export type WarningCode = z.infer<typeof WarningCode>;

export const ResolveWarning = z.strictObject({
  code: WarningCode,
  path: z.string().min(1),
  layer: Ref,
  message: z.string().optional(),
});
export type ResolveWarning = z.infer<typeof ResolveWarning>;

export const ERROR_CODES = [
  "missing-ref",
  "cycle",
  "linearization-conflict",
  "replace-target-missing",
  "lock-violation",
  "invalid-lock-path",
  "user-layer-lock",
  "policy-in-lower-layer",
  "agents-in-overlay",
  "invalid-persona",
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * A value a later layer displaced. `override`: `layer` replaced the value `from` had set.
 * `remove`: `layer` deleted it, or swapped it out (`replacedBy`). Provenance says who set each final value; history says what
 * those values replaced, so a reviewer can see removals that leave nothing behind.
 */
export const HistoryEntry = z.strictObject({
  path: z.string().min(1),
  layer: Ref,
  kind: z.enum(["override", "remove"]),
  from: Ref,
  /** For a `remove` done by `replace(<id>)` under a new id: the path of the new value. */
  replacedBy: z.string().min(1).optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

export const ResolveResult = z.strictObject({
  ir: ResolvedPersona,
  provenance: Provenance,
  warnings: z.array(ResolveWarning),
  /** In merge order. */
  history: z.array(HistoryEntry),
});
export type ResolveResult = z.infer<typeof ResolveResult>;
