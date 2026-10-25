import { create, type CreateOptions } from "../agent/create.js";
import { agentEnv, exec, formatDotenv } from "../agent/env.js";
import { projectContext } from "../agent/load.js";
import { agentStates, formatRows } from "../agent/list.js";
import { logs, run, stop, type RunOptions } from "../agent/run.js";
import { sync, type SyncOptions } from "../agent/sync.js";
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
