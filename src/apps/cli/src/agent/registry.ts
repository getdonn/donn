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
}

const Index = z.object({
  agents: z.array(
    z.object({
      project: z.string(),
      name: z.string(),
      path: z.string().optional(),
    }),
  ),
});

const indexFile = (home: string) => join(home, "agents", "index.json");
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
