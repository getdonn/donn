import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CliError } from "../errors.js";
import { withFileLock, writeFileAtomic } from "../fs.js";

// `~/.donn/agents/index.json`: the agents created on this machine, by project, so `list`,
// `status`, `doctor` and the daemon can find them without walking the disk.
// See docs/planning/25-agent-runner.md, sections 3 and 7.

export interface CreatedAgent {
  /** The project's root folder (the one holding `.donn/`). */
  project: string;
  name: string;
  /** The agent's folder, project-relative, as created (the persona can move it later). */
  path?: string;
  /** The port a `local` agent keeps on this machine (spec 25, sticky port). */
  port?: number;
}

const Index = z.object({
  agents: z.array(
    z.object({
      project: z.string(),
      name: z.string(),
      path: z.string().optional(),
      port: z.number().int().min(1024).max(65535).optional().catch(undefined),
    }),
  ),
});

const indexFile = (home: string) => join(home, "agents", "index.json");

/** `<home>/agents/<first 16 hex of sha256(project)>/<file>`: a project's agents' own files. */
export function agentStatePath(
  home: string,
  project: string,
  file: string,
): string {
  const hash = createHash("sha256").update(project).digest("hex").slice(0, 16);
  return join(home, "agents", hash, file);
}

/** The lock a sync of agent `name` holds while it checks and writes donn's files. */
export const agentLockPath = (home: string, project: string, name: string) =>
  agentStatePath(home, project, `${name}.lock`);
const same = (a: CreatedAgent, b: CreatedAgent) =>
  a.project === b.project && a.name === b.name;

export async function listCreated(home: string): Promise<CreatedAgent[]> {
  const file = indexFile(home);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const index = Index.safeParse(parsed);
  if (!index.success) {
    throw new CliError("invalid-agents-index", `${file} is not valid`, {
      file,
      fix: `remove ${file}; donn agent create records each agent again`,
    });
  }
  return index.data.agents;
}

async function update(
  home: string,
  change: (agents: CreatedAgent[]) => CreatedAgent[],
): Promise<void> {
  const file = indexFile(home);
  await withFileLock(`${file}.lock`, async () => {
    const agents = change(await listCreated(home));
    await writeFileAtomic(file, `${JSON.stringify({ agents }, null, 2)}\n`);
  });
}

export async function recordCreated(
  home: string,
  entry: CreatedAgent,
): Promise<void> {
  await update(home, (agents) =>
    agents.some((a) => same(a, entry)) ? agents : [...agents, entry],
  );
}

export async function forgetCreated(
  home: string,
  entry: CreatedAgent,
): Promise<void> {
  await update(home, (agents) => agents.filter((a) => !same(a, entry)));
}

/** The port stored for an agent, if it has a valid one. */
export async function storedPort(
  home: string,
  project: string,
  name: string,
): Promise<number | undefined> {
  const entry = { project, name };
  return (await listCreated(home)).find((a) => same(a, entry))?.port;
}

/** Store an agent's port, adding the agent to the index when it is missing. */
export async function recordPort(
  home: string,
  project: string,
  name: string,
  port: number,
): Promise<void> {
  const entry = { project, name };
  await update(home, (agents) =>
    agents.some((a) => same(a, entry))
      ? agents.map((a) => (same(a, entry) ? { ...a, port } : a))
      : [...agents, { project, name, port }],
  );
}
