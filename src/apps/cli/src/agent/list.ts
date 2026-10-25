import { existsSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../errors.js";
import type { CliIo } from "../cli.js";
import type { Context } from "../context.js";
import {
  locateAgent,
  recompile,
  recreateField,
  resolveProject,
  type RecreateField,
} from "./sync.js";

// `donn agent list`: the agents of the project persona and where each stands.
// See docs/planning/25-agent-runner.md, sections 1 and 3.

export interface AgentRow {
  name: string;
  template: string;
  target: string;
  path: string;
  state: "available" | "created" | "running" | "built" | "deployed";
  /** The files donn owns match a fresh compile of the persona. */
  current: boolean;
  /** Set when the persona changed what a sync cannot rewrite. */
  recreate?: RecreateField;
}

/**
 * One row per agent the project persona declares. `running` comes from the daemon, which a
 * later step wires in; until then a running agent shows as `created`.
 */
export async function agentStates(
  ctx: Context,
  _io: CliIo,
): Promise<AgentRow[]> {
  const project = await resolveProject(ctx);
  if (project === undefined) return [];
  const { root, result } = project;
  const rows: AgentRow[] = [];
  for (const name of Object.keys(result.ir.agents).sort()) {
    const agent = result.ir.agents[name]!;
    const row: AgentRow = {
      name,
      template: agent.template,
      target: agent.target,
      path: agent.path,
      state: "available",
      current: false,
    };
    const { dir, manifest } = await locateAgent(ctx, root, name, agent);
    if (manifest?.state === "complete") {
      row.state = existsSync(join(dir, ".vercel/project.json"))
        ? "deployed"
        : existsSync(join(dir, ".output")) &&
            "deploy/donn/Dockerfile" in manifest.files
          ? "built"
          : "created";
      const field = recreateField(agent, manifest);
      if (field !== undefined) row.recreate = field;
      else row.current = await isCurrent(ctx, result, name, dir, manifest);
    }
    rows.push(row);
  }
  return rows;
}

async function isCurrent(
  ctx: Context,
  result: Parameters<typeof recompile>[1],
  name: string,
  dir: string,
  manifest: Parameters<typeof recompile>[4],
): Promise<boolean> {
  try {
    const { planned } = await recompile(ctx, result, name, dir, manifest);
    const a = Object.entries(planned.files);
    return (
      a.length === Object.keys(manifest.files).length &&
      a.every(([path, hash]) => manifest.files[path] === hash)
    );
  } catch (error) {
    if (error instanceof CliError) return false; // The compile stops: stale until fixed.
    throw error;
  }
}

export function formatRows(rows: AgentRow[]): string {
  if (rows.length === 0) return "no agents declared in the project persona\n";
  const wide = (pick: (r: AgentRow) => string) =>
    Math.max(...rows.map((r) => pick(r).length));
  const [n, t, g, s] = [
    wide((r) => r.name),
    wide((r) => r.template),
    wide((r) => r.target),
    wide((r) => r.state),
  ];
  return rows
    .map((r) => {
      const status =
        r.state === "available" ? "" : r.current ? "current" : "stale";
      const line = [
        r.name.padEnd(n),
        r.template.padEnd(t),
        r.target.padEnd(g),
        r.state.padEnd(s),
        status,
        r.recreate ? `recreate needed (${r.recreate})` : "",
      ]
        .filter((c, i) => c !== "" || i < 4)
        .join("  ")
        .trimEnd();
      return `${line}\n`;
    })
    .join("");
}
