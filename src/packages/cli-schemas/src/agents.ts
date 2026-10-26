import { z } from "zod";
import {
  AgentState,
  AgentTarget,
  CompileReport,
  RecreateField,
} from "./common.js";

// donn agent: list, create, sync, env, run, stop, build, deploy, logs, add and templates.
// (`agent exec` runs another program and prints that program's output; it has no schema.)

/** `donn agent list --json`: one row per agent the project persona declares. */
export const AgentListOutput = z.strictObject({
  agents: z.array(
    z.strictObject({
      name: z.string(),
      template: z.string(),
      target: AgentTarget,
      path: z.string(),
      state: AgentState,
      /** The files donn owns match a fresh compile of the persona. */
      current: z.boolean(),
      recreate: RecreateField.optional(),
      /** Where a running agent listens. */
      url: z.string().optional(),
    }),
  ),
});
export type AgentListOutput = z.infer<typeof AgentListOutput>;

/** Where an agent's target would need something else (`PortabilityEntry`). */
const Portability = z.strictObject({
  target: AgentTarget,
  service: z.enum([
    "connect",
    "sandbox",
    "drive",
    "daemons",
    "ai-gateway",
    "github-checkout",
    "route-auth",
  ]),
  instead: z.string(),
  env: z.array(z.string()).optional(),
  blocking: z.boolean(),
});

/**
 * `donn agent create --json`, two shapes: `--dry-run` (`dryRun: true`; the files donn would
 * own, without the template's; `declared` when the agent had to be declared in the persona) and
 * the created agent. `files` maps an agent-folder path to its `sha256:` digest.
 */
export const AgentCreateOutput = z.union([
  z.strictObject({
    agent: z.string(),
    dir: z.string(),
    dryRun: z.literal(true),
    frameworkVersion: z.string(),
    files: z.record(z.string(), z.string()),
    report: CompileReport,
    portability: z.array(Portability),
    declared: z
      .strictObject({ file: z.string(), after: z.string() })
      .optional(),
  }),
  z.strictObject({
    agent: z.string(),
    dir: z.string(),
    frameworkVersion: z.string(),
    files: z.record(z.string(), z.string()),
    report: CompileReport,
    portability: z.array(Portability),
  }),
]);
export type AgentCreateOutput = z.infer<typeof AgentCreateOutput>;

/**
 * `donn agent sync --json`, two shapes: a sync (`written`, `removed` agent-folder paths) and
 * `--dry-run` (`dryRun: true`, the same, plus the files edited by hand that a sync would stop
 * at, or overwrite with `--force`).
 */
export const AgentSyncOutput = z.union([
  z.strictObject({
    dryRun: z.literal(true),
    written: z.array(z.string()),
    removed: z.array(z.string()),
    edited: z.array(z.string()),
    report: CompileReport,
  }),
  z.strictObject({
    written: z.array(z.string()),
    removed: z.array(z.string()),
    report: CompileReport,
  }),
]);
export type AgentSyncOutput = z.infer<typeof AgentSyncOutput>;

/**
 * `donn agent env --json`: the agent's variables. `value` is set for a plain variable, and for a
 * secret only with `--resolve`; a `runtime` variable is set when the agent starts.
 */
export const AgentEnvOutput = z.strictObject({
  env: z.array(
    z.strictObject({
      name: z.string(),
      source: z.enum(["secret", "plain", "runtime"]),
      /** The `secret://` ref of a secret variable. */
      ref: z.string().optional(),
      value: z.string().optional(),
      why: z.enum([
        "persona-secret",
        "gateway-key",
        "template-variable",
        "world-database",
        "route-auth",
      ]),
    }),
  ),
});
export type AgentEnvOutput = z.infer<typeof AgentEnvOutput>;

/**
 * `donn agent run --json`: the running agent, with the token its routes take. `already` is set
 * when the daemon had it running.
 */
export const AgentRunOutput = z.strictObject({
  agent: z.strictObject({
    name: z.string(),
    /** The project's root folder. */
    project: z.string(),
    url: z.string(),
    pid: z.number().int().optional(),
    startedAt: z.string(),
    token: z.string(),
  }),
  already: z.boolean().optional(),
});
export type AgentRunOutput = z.infer<typeof AgentRunOutput>;

/** `donn agent stop --json`; the sandbox counts are set when containers were left behind. */
export const AgentStopOutput = z.strictObject({
  agent: z.string(),
  stopped: z.boolean(),
  /** `eve-sbx-` containers still running. */
  leftovers: z.number().int().optional(),
  /** `eve-sbx-` containers stopped but kept. */
  exited: z.number().int().optional(),
});
export type AgentStopOutput = z.infer<typeof AgentStopOutput>;

/** `donn agent build --json`: the files written and the sandbox images to ship. */
export const AgentBuildOutput = z.strictObject({
  agent: z.string(),
  dir: z.string(),
  dockerfile: z.string(),
  envFile: z.string(),
  sandboxImages: z.array(z.string()),
  report: CompileReport,
});
export type AgentBuildOutput = z.infer<typeof AgentBuildOutput>;

/**
 * `donn agent deploy --json`: the variable names pushed to Vercel (never values), the ones
 * already set there (`existing`, left alone), and the deployment URL when eve printed one.
 */
export const AgentDeployOutput = z.strictObject({
  agent: z.string(),
  dir: z.string(),
  pushed: z.array(z.string()),
  existing: z.array(z.string()).optional(),
  url: z.string().optional(),
});
export type AgentDeployOutput = z.infer<typeof AgentDeployOutput>;

/**
 * `donn agent logs --json`: the log so far. (`--follow --json` prints one `{ "line": ... }` per
 * line, forever; that stream has no schema here.)
 */
export const AgentLogsOutput = z.strictObject({
  agent: z.string(),
  log: z.string(),
  lines: z.array(z.string()),
});
export type AgentLogsOutput = z.infer<typeof AgentLogsOutput>;

/** The Vercel-only services a template's code uses (`VercelService`). */
const VercelService = z.enum([
  "connect",
  "sandbox",
  "drive",
  "daemons",
  "ai-gateway",
  "github-checkout",
]);

/**
 * `donn agent templates --json`: the adapter's templates, then `blank`. `vercelOnly` when the
 * adapter reports a blocking portability entry at `local` or `self-host`; `inRepo` when the
 * template is kept in eve's repository at the adapter's tag.
 */
export const AgentTemplatesOutput = z.strictObject({
  templates: z.array(
    z.strictObject({
      slug: z.string(),
      title: z.string(),
      services: z.array(VercelService),
      vercelOnly: z.boolean(),
      inRepo: z.boolean(),
    }),
  ),
});
export type AgentTemplatesOutput = z.infer<typeof AgentTemplatesOutput>;

/**
 * One of eve's setup questions, in eve's wire shape (`setup-question-wire.ts`, eve 0.83.2). A
 * secret is `kind: "environment"` with the `variable` eve reads it from: it is never answered on
 * a command line, so the UI shows the variable instead of a field.
 */
export const AgentQuestion = z.strictObject({
  key: z.string(),
  message: z.string(),
  kind: z.enum([
    "confirm",
    "text",
    "environment",
    "select",
    "multi-select",
    "editable-select",
  ]),
  required: z.boolean(),
  options: z
    .array(
      z.strictObject({
        id: z.string(),
        label: z.string(),
        hint: z.string().optional(),
        disabled: z.boolean().optional(),
        disabledReason: z.string().optional(),
        locked: z.boolean().optional(),
        lockedReason: z.string().optional(),
      }),
    )
    .optional(),
  /** confirm: a boolean; select: an option id; multi-select: option ids. */
  recommended: z
    .union([z.boolean(), z.string(), z.array(z.string())])
    .optional(),
  placeholder: z.string().optional(),
  variable: z.string().optional(),
  /** editable-select: the option that takes a typed value, answered under `editable.key`. */
  editable: z
    .strictObject({
      key: z.string(),
      optionId: z.string(),
      label: z.string(),
      recommended: z.string(),
    })
    .optional(),
  /** Why eve refused the last answer. */
  issue: z.strictObject({ code: z.string(), message: z.string() }).optional(),
});
export type AgentQuestion = z.infer<typeof AgentQuestion>;

/**
 * `donn agent add --json`, three shapes. `completed` (exit 0). `needs-answer` (exit 2): eve's
 * question and the argv (after `donn`) that continues once `--answer=<key>=<JSON>` is added; a
 * secret question has a `fix` naming its variable. `needs-prerequisite` (exit 2): a step for the
 * user, such as `eve link` for an agent not on Vercel, and the argv to run after it.
 */
export const AgentAddOutput = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("completed"),
    item: z.string(),
    completedItems: z.array(z.string()).optional(),
    deploymentRequired: z.literal(true).optional(),
  }),
  z.strictObject({
    status: z.literal("needs-answer"),
    item: z.string(),
    question: AgentQuestion,
    continue: z.array(z.string()),
    fix: z.string().optional(),
  }),
  z.strictObject({
    status: z.literal("needs-prerequisite"),
    item: z.string(),
    prerequisite: z.strictObject({
      kind: z.string(),
      code: z.string(),
      message: z.string(),
      command: z.string().optional(),
    }),
    continue: z.array(z.string()),
    fix: z.string(),
  }),
]);
export type AgentAddOutput = z.infer<typeof AgentAddOutput>;
