import { add, type AddOptions } from "../agent/add.js";
import { build, type BuildOptions } from "../agent/build.js";
import { deploy, type DeployOptions } from "../agent/deploy.js";
import { create, type CreateOptions } from "../agent/create.js";
import { agentEnv, exec, formatDotenv } from "../agent/env.js";
import { projectContext } from "../agent/load.js";
import { agentStates, formatRows } from "../agent/list.js";
import { logs, run, stop, type RunOptions } from "../agent/run.js";
import { sync, type SyncOptions } from "../agent/sync.js";
import { templateRows } from "../agent/template.js";
import type { CliIo } from "../cli.js";

// donn agent: build, run and deploy agents on a persona. See docs/planning/25-agent-runner.md.

export interface AgentOptions {
  json?: boolean;
  /** The agent project's folder; resolved with the project in a later step. */
  project?: string;
}

/** `donn agent list`: the project persona's agents and where each stands. */
export async function agentListCommand(
  io: CliIo,
  options: AgentOptions,
): Promise<number> {
  const ctx = await projectContext(io, options.project);
  const agents = await agentStates(ctx, io);
  io.stdout.write(
    options.json
      ? `${JSON.stringify({ agents }, null, 2)}\n`
      : formatRows(agents),
  );
  return 0;
}

/** `donn agent sync <name>`: see agent/sync.ts. */
export async function agentSyncCommand(
  io: CliIo,
  name: string,
  options: SyncOptions,
): Promise<number> {
  return sync(io, name, options);
}

/** `donn agent create <name>`: see agent/create.ts. */
export async function agentCreateCommand(
  io: CliIo,
  name: string,
  options: CreateOptions,
): Promise<number> {
  return create(io, name, options);
}

export interface EnvOptions extends AgentOptions {
  resolve?: boolean;
  format?: "dotenv" | "json";
}

/** `donn agent env <name>`: see agent/env.ts. */
export async function agentEnvCommand(
  io: CliIo,
  name: string,
  options: EnvOptions,
): Promise<number> {
  const ctx = await projectContext(io, options.project);
  const env = await agentEnv(ctx, io, name, {
    resolve: options.resolve === true,
  });
  io.stdout.write(
    options.json || options.format === "json"
      ? `${JSON.stringify({ env }, null, 2)}\n`
      : formatDotenv(env),
  );
  return 0;
}

/** `donn agent exec <name> -- <command>…`: see agent/env.ts. */
export async function agentExecCommand(
  io: CliIo,
  name: string,
  command: string[],
  options: AgentOptions,
): Promise<number> {
  return exec(await projectContext(io, options.project), io, name, command);
}

/** `donn agent run <name> [--dev]`: see agent/run.ts. */
export async function agentRunCommand(
  io: CliIo,
  name: string,
  options: RunOptions,
): Promise<number> {
  return run(io, name, options);
}

/** `donn agent stop <name>`: see agent/run.ts. */
export async function agentStopCommand(
  io: CliIo,
  name: string,
  options: AgentOptions,
): Promise<number> {
  return stop(io, name, options);
}

/** `donn agent logs <name> [--follow]`: see agent/run.ts. */
export async function agentLogsCommand(
  io: CliIo,
  name: string,
  options: AgentOptions & { follow?: boolean },
): Promise<number> {
  return logs(io, name, options);
}

/** `donn agent build <name>`: see agent/build.ts. */
export async function agentBuildCommand(
  io: CliIo,
  name: string,
  options: BuildOptions,
): Promise<number> {
  return build(io, name, options);
}

/** `donn agent deploy <name>`: see agent/deploy.ts. */
export async function agentDeployCommand(
  io: CliIo,
  name: string,
  options: DeployOptions,
): Promise<number> {
  return deploy(io, name, options);
}

/** `donn agent add <name> <item>`: see agent/add.ts. */
export async function agentAddCommand(
  io: CliIo,
  name: string,
  item: string,
  options: AddOptions,
): Promise<number> {
  return add(io, name, item, options);
}

/** `donn agent templates`: the templates `create --template eve:<slug>` takes. */
export async function agentTemplatesCommand(
  io: CliIo,
  options: { json?: boolean },
): Promise<number> {
  const templates = templateRows();
  if (options.json) {
    io.stdout.write(`${JSON.stringify({ templates }, null, 2)}\n`);
    return 0;
  }
  for (const t of templates) {
    const tags = [
      t.vercelOnly ? "Vercel-only services" : undefined,
      t.services.length > 0 ? t.services.join(", ") : undefined,
    ].filter(Boolean);
    io.stdout.write(
      `eve:${t.slug}  ${t.title}${tags.length > 0 ? `  (${tags.join("; ")})` : ""}\n`,
    );
  }
  return 0;
}
