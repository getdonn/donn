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
  /** Whether `agent/sandbox.ts` is written. */
  sandbox?: boolean;
  /** Whether `agent/channels/eve.ts` is written. */
  channel?: boolean;
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

    // eve 0.83.2 prefers an `agent/sandbox/` folder over a top-level `sandbox.<ext>`, and errors
    // on two top-level ones, so either form shadows or clashes with donn's.
    if (
      slots.sandbox &&
      (/^sandbox\.(?:ts|mts|js|mjs|cjs)$/.test(path) ||
        path.startsWith("sandbox/"))
    )
      clash(
        "agent/sandbox.ts would be written, and a sandbox is already there",
      );

    // eve takes one `channels/eve` module or folder; two (or a folder beside a file) are an error.
    if (
      slots.channel &&
      (/^channels\/eve\.(?:ts|mts|js|mjs|cjs)$/.test(path) ||
        path.startsWith("channels/eve/"))
    )
      clash(
        "agent/channels/eve.ts would be written, and a route-auth channel is already there",
      );

    // macOS folds case, so `skills/Donn-x/` and `skills/donn-x/` are one directory.
    for (const skill of slots.skills) {
      const entry = entryUnder(path, "skills")?.toLowerCase();
      if (
        entry === skill.toLowerCase() ||
        entry === `${skill.toLowerCase()}.md`
      )
        clash(`skill ${skill} would be written to agent/skills/${skill}/`);
    }
    for (const connection of slots.connections) {
      const entry = entryUnder(path, "connections")?.toLowerCase();
      if (
        entry === connection.toLowerCase() ||
        entry?.replace(MODULE_EXTENSIONS, "") === connection.toLowerCase()
      )
        clash(
          `connection ${connection} would be written to agent/connections/${connection}.ts`,
        );
      // A connection owns the tool and subagent names that start with `<name>__`.
      for (const dir of ["tools", "subagents"]) {
        if (
          entryUnder(path, dir)
            ?.toLowerCase()
            .startsWith(`${connection.toLowerCase()}__`)
        )
          clash(
            `${dir === "tools" ? "tool" : "subagent"} names starting ${connection}__ belong to connection ${connection}`,
          );
      }
    }
  }
  if (problems.length > 0)
    throw new EveCompileError("slot-collision", problems.join("; "));
}
