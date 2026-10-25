import { z } from "zod";
import { Change, CompileReport, Ref } from "./common.js";

// The persona commands: list, resolve, compile, diff, switch and write.

const HOOK_EVENTS = [
  "session-start",
  "session-end",
  "user-prompt-submit",
  "pre-tool-use",
  "post-tool-use",
  "stop",
  "subagent-stop",
  "pre-compact",
  "notification",
] as const;

// ---- the resolved persona (@getdonn/spec's ResolvedPersona, without its validation) ----------

const Instruction = z.union([
  z.strictObject({ id: z.string(), file: z.string() }),
  z.strictObject({ id: z.string(), inline: z.string() }),
]);

const McpServer = z.union([
  z.strictObject({ ref: z.string() }),
  z.strictObject({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.strictObject({
    url: z.string(),
    transport: z.enum(["http", "sse"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

const Hook = z.strictObject({
  id: z.string(),
  run: z.string(),
  matcher: z.string().optional(),
});

const ResolvedAgent = z.strictObject({
  template: z.string(),
  target: z.enum(["local", "self-host", "vercel"]),
  path: z.string(),
  model: z.string().optional(),
  world: z.enum(["local", "postgres"]).optional(),
  env: z.record(z.string(), z.string()),
});

export const ResolvedPersona = z.strictObject({
  irVersion: z.number().int(),
  layers: z.array(Ref),
  metadata: z.strictObject({
    name: z.string(),
    version: z.number().int().optional(),
    description: z.string().optional(),
    labels: z.record(z.string(), z.string()),
  }),
  instructions: z.array(Instruction),
  skills: z.array(z.strictObject({ name: z.string(), source: z.string() })),
  mcp: z.strictObject({
    gateway: z.string().optional(),
    servers: z.record(z.string(), McpServer),
  }),
  permissions: z.strictObject({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
    ask: z.array(z.string()),
  }),
  hooks: z.partialRecord(z.enum(HOOK_EVENTS), z.array(Hook)),
  knowledge: z.array(z.strictObject({ id: z.string(), source: z.string() })),
  secrets: z.strictObject({
    providers: z.record(z.string(), z.looseObject({ type: z.string() })),
  }),
  locks: z.array(z.strictObject({ path: z.string(), layer: Ref })),
  targets: z.record(z.string(), z.record(z.string(), z.unknown())),
  policy: z.strictObject({
    permissions: z.literal("exclusive").optional(),
    hooks: z.literal("exclusive").optional(),
    mcp: z.literal("exclusive").optional(),
    bypassPermissions: z.literal("disabled").optional(),
  }),
  models: z.strictObject({
    gateway: z
      .strictObject({
        type: z.enum(["openai-compatible", "anthropic", "vercel-ai-gateway"]),
        baseURL: z.string().optional(),
        apiKey: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
      })
      .optional(),
    default: z.string().optional(),
  }),
  agents: z.record(z.string(), ResolvedAgent),
});
export type ResolvedPersona = z.infer<typeof ResolvedPersona>;

const ResolveWarning = z.strictObject({
  code: z.enum([
    "allow-shadowed-by-deny",
    "ask-shadowed-by-deny",
    "allow-shadowed-by-ask",
    "security-removal",
    "remove-unmatched",
    "overlay-lock-ignored",
    "agent-removed",
  ]),
  path: z.string(),
  layer: Ref,
  message: z.string().optional(),
});

const HistoryEntry = z.strictObject({
  path: z.string(),
  layer: Ref,
  kind: z.enum(["override", "remove"]),
  from: Ref,
  replacedBy: z.string().optional(),
});

// ---- the commands ------------------------------------------------------------------------

/** `donn list --json`: every persona the store holds, with the layer its ref starts with. */
export const ListOutput = z.strictObject({
  personas: z.array(z.strictObject({ ref: Ref, layer: z.string() })),
});
export type ListOutput = z.infer<typeof ListOutput>;

/**
 * `donn resolve --json`: the resolved persona, which layer set each value (`provenance`, keyed
 * by path), what each displaced (`history`), and the registry versions the resolve used
 * (`builtFrom`, only for layers that came from the registry cache).
 */
export const ResolveOutput = z.strictObject({
  ir: ResolvedPersona,
  provenance: z.record(z.string(), Ref),
  warnings: z.array(ResolveWarning),
  history: z.array(HistoryEntry),
  builtFrom: z.record(z.string(), z.number().int()),
});
export type ResolveOutput = z.infer<typeof ResolveOutput>;

/**
 * `donn resolve --explain --json` prints exactly what `resolve --json` does: under `--json` the
 * explanation (plain text) is not printed. An alias, not a separate entry in COMMAND_OUTPUTS.
 */
export const ResolveExplainOutput = ResolveOutput;

const PlanStep = z.union([
  z.strictObject({
    kind: z.literal("launch"),
    command: z.string(),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),
    cwd: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("overlay"),
    path: z.string(),
    content: z.string(),
    block: z.string().optional(),
  }),
]);

/**
 * `donn compile --json` (also with `--dry-run`, which writes nothing but prints the same):
 * the build folder, what the adapter dropped or approximated, the `secret://` refs the build
 * needs (never values), and the activation plan.
 */
export const CompileOutput = z.strictObject({
  buildDir: z.string(),
  report: CompileReport,
  secretRefs: z.array(z.string()),
  plan: z.strictObject({ steps: z.array(PlanStep) }),
});
export type CompileOutput = z.infer<typeof CompileOutput>;

/** `donn diff --json`: what changes from `from` to `to` (each a persona ref). */
export const DiffOutput = z.strictObject({
  from: Ref,
  to: Ref,
  changes: z.array(Change),
});
export type DiffOutput = z.infer<typeof DiffOutput>;

/** What a switch means in one harness (`HarnessResult` in the CLI's switch-report.ts). */
export const HarnessResult = z.strictObject({
  id: z.string(),
  status: z.enum(["ok", "drops", "error", "shared"]),
  /** Fields the harness drops, grouped: `hooks (2)`. */
  dropped: z.array(z.string()),
  /** Fields it carries approximately: `knowledge (3)`. */
  approximated: z.array(z.string()),
  /** Sessions here still on another persona. */
  sessions: z
    .strictObject({
      count: z.number().int(),
      persona: z.string(),
      fix: z.string(),
    })
    .optional(),
  message: z.string().optional(),
  fix: z.string().optional(),
});
export type HarnessResult = z.infer<typeof HarnessResult>;

const Scope = z.enum(["project", "default"]);

/**
 * `donn switch --json`, by what was asked:
 *  - no persona: the persona in use and where it came from (`persona` is null for `--default`
 *    when no default is set);
 *  - a persona: the scope it was saved for, the registry versions it was built from, and the
 *    per-harness report;
 *  - `--clear`: the persona that was cleared (null when there was none to clear), with the
 *    report for whatever applies now (absent when nothing does).
 */
export const SwitchOutput = z.union([
  z.strictObject({
    persona: z.string().nullable(),
    source: z.enum(["argument", "switch", "project", "default"]),
    project: z.string().optional(),
  }),
  z.strictObject({
    scope: Scope,
    persona: z.string(),
    project: z.string().optional(),
    builtFrom: z.record(z.string(), z.number().int()),
    harnesses: z.array(HarnessResult),
  }),
  z.strictObject({
    scope: Scope,
    persona: z.string().nullable(),
    project: z.string().optional(),
    harnesses: z.array(HarnessResult).optional(),
  }),
]);
export type SwitchOutput = z.infer<typeof SwitchOutput>;

/**
 * `donn write --json`: one object per file written (today always one: AGENTS.md), with the
 * compile report. The exit code is 1 when `--check` finds the file `stale`.
 */
export const WriteOutput = z.strictObject({
  path: z.string(),
  status: z.enum(["created", "updated", "unchanged", "removed", "stale"]),
  report: CompileReport,
});
export type WriteOutput = z.infer<typeof WriteOutput>;
