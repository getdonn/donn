import type { CliIo } from "../cli.js";

// donn agent: build, run and deploy agents on a persona. See docs/planning/25-agent-runner.md.

export interface AgentOptions {
  json?: boolean;
  /** The agent project's folder; resolved with the project in a later step. */
  project?: string;
}

/** `donn agent list`: the agent projects donn knows of (not yet implemented: none). */
export async function agentListCommand(
  io: CliIo,
  options: AgentOptions,
): Promise<number> {
  if (options.json) {
    io.stdout.write(`${JSON.stringify({ agents: [] }, null, 2)}\n`);
  }
  return 0;
}
