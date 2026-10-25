import { EveCompileError } from "./errors.js";

// Names and paths donn writes that a template or the user may already hold. eve refuses every
// one of these at build, so donn refuses first and names both sides. See
// docs/planning/24-adapter-eve.md, section 3, and spikes/eve-slots/FINDINGS.md (Q2).

const MODULE_EXTENSIONS = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

export interface DonnSlots {
  /** `donn-<skill>` directory names. */
  skills: string[];
  /** `donn-<server>` connection names. */
  connections: string[];
  /** Whether `instructions/donn.md` is written. */
  instructions: boolean;
}

/** An `existing` path below the agent directory: `agent/skills/x.md` and `skills/x.md` alike. */
const inAgentDir = (path: string) => path.replace(/^\.?\/?(?:agent\/)?/, "");

/** The first segment below `dir/` of `path`, or undefined when `path` is not below it. */
function entryUnder(path: string, dir: string): string | undefined {
  return path.startsWith(`${dir}/`)
    ? path.slice(dir.length + 1).split("/")[0]
    : undefined;
}

/**
 * Throws `slot-collision`, naming every pair, when a path in `existing` (agent-directory paths
 * that are not in donn's manifest) sits on a slot donn is about to write.
 */
export function assertNoSlotCollisions(
  existing: readonly string[],
  slots: DonnSlots,
): void {
  const problems: string[] = [];
  for (const original of existing) {
    const path = inAgentDir(original);
    const clash = (what: string) =>
      problems.push(`${what}, but the project already has ${original}`);

    if (slots.instructions && /^instructions\/donn(?:\.[A-Za-z]+)?$/.test(path))
      clash("agent/instructions/donn.md is donn's");
    if (path.startsWith("lib/donn/")) clash("agent/lib/donn/ is donn's");

    for (const skill of slots.skills) {
      const entry = entryUnder(path, "skills");
      if (entry === skill || entry === `${skill}.md`)
        clash(`skill ${skill} would be written to agent/skills/${skill}/`);
    }
    for (const connection of slots.connections) {
      const entry = entryUnder(path, "connections");
      if (
        entry === connection ||
        entry?.replace(MODULE_EXTENSIONS, "") === connection
      )
        clash(
          `connection ${connection} would be written to agent/connections/${connection}.ts`,
        );
      // A connection owns the tool and subagent names that start with `<name>__`.
      for (const dir of ["tools", "subagents"]) {
        if (entryUnder(path, dir)?.startsWith(`${connection}__`))
          clash(
            `${dir === "tools" ? "tool" : "subagent"} names starting ${connection}__ belong to connection ${connection}`,
          );
      }
    }
  }
  if (problems.length > 0)
    throw new EveCompileError("slot-collision", problems.join("; "));
}
