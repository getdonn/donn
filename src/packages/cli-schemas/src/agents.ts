import { z } from "zod";
import {
  AgentState,
  AgentTarget,
  CompileReport,
  RecreateField,
} from "./common.js";

// donn agent: list, create, sync, env, run, stop, build, deploy and logs. (`agent exec` runs
// another program and prints that program's output; it has no schema.)

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
