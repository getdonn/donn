import type { AgentCompileOutput } from "@getdonn/adapter-sdk";
import type { ResolveResult } from "@getdonn/spec";
import { printReport } from "../build.js";
import type { CliIo } from "../cli.js";
import type { Context } from "../context.js";
import {
  checkOwned,
  pendingChanges,
  planFiles,
  posixRelative,
  readManifest,
  writeAgentFiles,
  writeManifest,
  type Manifest,
  type PlannedFiles,
} from "./files.js";
import { CliError } from "../errors.js";
import { compile, compileInputs } from "./inputs.js";
import { withFileLock } from "../fs.js";
import { loadCreatedAgent, projectContext, projectRoot } from "./load.js";
import { agentLockPath } from "./registry.js";
import { editSubagents, pendingSubagentEdits } from "./subagents.js";

// `donn agent sync <name>`: recompile and rewrite donn's files in a created agent by the
// manifest's rules (docs/planning/24-adapter-eve.md, section 4). It never touches agent.ts or
// anything else donn does not own, but for a subagent's agent.ts that a gateway needs edited and
// that was not yet (see subagents.ts). Also the shared lookups `list` uses.
// See docs/planning/25-agent-runner.md, section 3.

export interface SyncOptions {
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
  /** The project folder; the current directory's project by default. */
  project?: string;
}

/** A fresh compile against the agent directory, at the version the agent was created with. */
export async function recompile(
  ctx: Context,
  result: ResolveResult,
  name: string,
  dir: string,
  manifest: Manifest,
): Promise<{ output: AgentCompileOutput; planned: PlannedFiles }> {
  const output = compile(
    await compileInputs(ctx, result.ir, name, dir, manifest.frameworkVersion),
  );
  return { output, planned: await planFiles(output, ctx.store) };
}

/** The files a compile plans are exactly those the manifest records. */
export function sameFiles(
  planned: Record<string, string>,
  recorded: Record<string, string>,
): boolean {
  const entries = Object.entries(planned);
  return (
    entries.length === Object.keys(recorded).length &&
    entries.every(([path, hash]) => recorded[path] === hash)
  );
}

/**
 * Whether a recompile plans exactly the manifest's files and no subagent waits for its edit.
 * A compile that stops throws.
 */
export async function upToDate(
  ctx: Context,
  result: ResolveResult,
  name: string,
  dir: string,
  manifest: Manifest,
): Promise<boolean> {
  const { planned } = await recompile(ctx, result, name, dir, manifest);
  return (
    sameFiles(planned.files, manifest.files) &&
    (await pendingSubagentEdits(dir, result.ir)).length === 0
  );
}

/**
 * Whether the agent's donn files are what its persona compiles to now. Under the agent's lock,
 * with the manifest read again there, so a sync in flight finishes first.
 */
export async function isSynced(
  ctx: Context,
  agent: {
    result: ResolveResult;
    root: string;
    dir: string;
    manifest: Manifest;
  },
  name: string,
): Promise<boolean> {
  const { result, root, dir } = agent;
  return withFileLock(agentLockPath(ctx.home, root, name), async () => {
    const manifest = (await readManifest(dir)) ?? agent.manifest;
    return upToDate(ctx, result, name, dir, manifest);
  });
}

/** What `build`, `deploy` and a foreground `run` say of an agent older than its persona. */
export const staleText = (name: string) =>
  `${name}'s donn files are older than its persona; \`donn agent sync ${name}\` brings them up to date`;

/** Refuses an agent whose donn files are older than its persona: they would ship as they are. */
export async function assertSynced(
  ctx: Context,
  agent: Parameters<typeof isSynced>[1],
  name: string,
): Promise<void> {
  if (await isSynced(ctx, agent, name)) return;
  throw new CliError("agent-stale", staleText(name), {
    agent: name,
    fix: `donn agent sync ${name}`,
  });
}

export interface SyncedAgent {
  root: string;
  dir: string;
  output: AgentCompileOutput;
  written: string[];
  removed: string[];
  /** Owned files edited by hand: overwritten with `force`, else the sync stops on them. */
  edited: string[];
}

/**
 * The sync itself, for the command and the daemon: recompile `name` and, unless `dryRun`, write
 * donn's files and the manifest. An owned file edited by hand stops it (`owned-file-edited`)
 * unless `force`. `onCompiled` sees the compile before any stop. It holds the agent's lock from
 * reading the manifest to writing it, so a sync in another process (the daemon's, a terminal's)
 * waits rather than reading this one's files as edited.
 */
export async function syncAgent(
  ctx: Context,
  io: CliIo,
  name: string,
  options: {
    force?: boolean;
    dryRun?: boolean;
    onCompiled?: (output: AgentCompileOutput) => void | Promise<void>;
  } = {},
): Promise<SyncedAgent> {
  return withFileLock(agentLockPath(ctx.home, projectRoot(ctx), name), () =>
    syncLocked(ctx, io, name, options),
  );
}

async function syncLocked(
  ctx: Context,
  io: CliIo,
  name: string,
  options: Parameters<typeof syncAgent>[3] & {},
): Promise<SyncedAgent> {
  const { root, result, dir, manifest } = await loadCreatedAgent(ctx, io, name);
  const { output, planned } = await recompile(ctx, result, name, dir, manifest);
  await options.onCompiled?.(output);
  const { written, removed } = await pendingChanges(dir, planned, manifest);
  // A dry run stops where the real sync would; with --force it reports the overwrites.
  const edited = await checkOwned(dir, manifest, options.force === true);
  // Subagent edits count as written: a running agent restarts on them as on donn's files.
  let subagents = (await pendingSubagentEdits(dir, result.ir)).map(
    (p) => p.path,
  );
  if (options.dryRun !== true) {
    const files = await writeAgentFiles(dir, output, manifest, {
      force: options.force === true,
      store: ctx.store,
    });
    subagents = await editSubagents(dir, result.ir);
    const edits = [...new Set([...manifest.edits, ...subagents])].sort();
    await writeManifest(dir, { ...manifest, files, edits });
  }
  return {
    root,
    dir,
    output,
    written: [...written, ...subagents],
    removed,
    edited,
  };
}

export async function sync(
  io: CliIo,
  name: string,
  options: SyncOptions,
): Promise<number> {
  const ctx = await projectContext(io, options.project);
  const { root, dir, output, written, removed, edited } = await syncAgent(
    ctx,
    io,
    name,
    {
      force: options.force,
      dryRun: options.dryRun,
      ...(!options.json && { onCompiled: (o) => printReport(io, o) }),
    },
  );
  const shown = posixRelative(root, dir);

  if (options.json) {
    io.stdout.write(
      `${JSON.stringify(
        {
          ...(options.dryRun === true && { dryRun: true }),
          written,
          removed,
          ...(options.dryRun === true && { edited }),
          report: output.report,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  const verb = options.dryRun === true ? "would " : "";
  for (const path of written)
    io.stdout.write(`${verb}${verb ? "write" : "wrote"} ${shown}/${path}\n`);
  if (options.dryRun === true)
    for (const path of edited)
      io.stdout.write(`would overwrite ${shown}/${path} (edited by hand)\n`);
  for (const path of removed)
    io.stdout.write(`${verb}${verb ? "remove" : "removed"} ${shown}/${path}\n`);
  if (written.length === 0 && removed.length === 0)
    io.stdout.write(`${shown} is current\n`);
  return 0;
}
