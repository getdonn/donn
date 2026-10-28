import { existsSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../errors.js";
import type { CliIo } from "../cli.js";
import type { Context } from "../context.js";
import type { AgentStatus, AgentSyncFailure } from "../daemon/client.js";
import {
  locateAgent,
  projectContext,
  recreateField,
  resolveProject,
  type RecreateField,
} from "./load.js";
import { listCreated } from "./registry.js";
import { runningAgents } from "./run.js";
import { recompile, upToDate } from "./sync.js";

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
  /** Where a running agent listens. */
  url?: string;
}

/**
 * One row per agent the project persona declares. `running` comes from the daemon (`running`,
 * or asked here): without a daemon no agent is running.
 */
export async function agentStates(
  ctx: Context,
  io: CliIo,
  running?: AgentStatus[],
): Promise<AgentRow[]> {
  const project = await resolveProject(ctx);
  if (project === undefined) return [];
  const { root, result } = project;
  const live: AgentStatus[] = running ?? (await runningAgents(io, ctx.home));
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
            "deploy/donn/Dockerfile" in (manifest.deploy ?? {})
          ? "built"
          : "created";
      const on = live.find((a) => a.project === root && a.name === name);
      if (on !== undefined) {
        row.state = "running";
        row.url = on.url;
      }
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
    return await upToDate(ctx, result, name, dir, manifest);
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

export interface CreatedRow {
  name: string;
  project: string;
  target: string;
  state: AgentRow["state"] | "unknown";
  current: boolean;
  url?: string;
  /** Set when the persona changed what a sync cannot rewrite. */
  recreate?: RecreateField;
  /** The code the daemon's last sync of it stopped with. */
  syncFailed?: string;
}

/**
 * Every agent created on this machine, by project, for `donn status`; `syncFailed` is what the
 * daemon reports of its syncs.
 */
export async function createdAgentRows(
  io: CliIo,
  home: string,
  running: AgentStatus[],
  syncFailed: AgentSyncFailure[] = [],
): Promise<CreatedRow[]> {
  const created = await listCreated(home).catch(() => []);
  const projects = [...new Set(created.map((c) => c.project))].sort();
  const rows: CreatedRow[] = [];
  for (const project of projects) {
    const names = created
      .filter((c) => c.project === project)
      .map((c) => c.name);
    let states: AgentRow[] | undefined;
    try {
      states = await agentStates(
        await projectContext(io, project),
        io,
        running,
      );
    } catch {
      // A project moved or broken since: shown, not resolved.
    }
    for (const name of names.sort()) {
      const row = states?.find((r) => r.name === name);
      const failed = syncFailed.find(
        (f) => f.project === project && f.name === name,
      );
      rows.push({
        ...(row === undefined || row.state === "available"
          ? { name, project, target: "-", state: "unknown", current: false }
          : {
              name,
              project,
              target: row.target,
              state: row.state,
              current: row.current,
              ...(row.url !== undefined && { url: row.url }),
              ...(row.recreate !== undefined && { recreate: row.recreate }),
            }),
        ...(failed !== undefined && { syncFailed: failed.code }),
      });
    }
  }
  return rows;
}

/** `agent  <name>  <target>  <state>  current|stale[  recreate needed (<field>)|sync-failed: <code>]` */
export const createdLine = (row: CreatedRow): string =>
  [
    "agent",
    row.name,
    row.target,
    row.state,
    row.current ? "current" : "stale",
    ...(row.recreate !== undefined
      ? [`recreate needed (${row.recreate})`]
      : row.syncFailed !== undefined
        ? [`sync-failed: ${row.syncFailed}`]
        : []),
  ].join("  ");
