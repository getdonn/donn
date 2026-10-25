import { resolve as resolvePath } from "node:path";
import { create, type CreateOptions } from "../agent/create.js";
import { agentStates, formatRows } from "../agent/list.js";
import { sync, type SyncOptions } from "../agent/sync.js";
import type { CliIo } from "../cli.js";
import { createContext } from "../context.js";

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
  const ctx = await createContext(
    options.project === undefined
      ? io
      : { ...io, cwd: resolvePath(io.cwd, options.project) },
  );
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
