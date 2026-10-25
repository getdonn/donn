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
  writeAgentFiles,
  writeManifest,
  type Manifest,
  type PlannedFiles,
} from "./files.js";
import { compile, compileInputs } from "./inputs.js";
import { loadCreatedAgent, projectContext } from "./load.js";

// `donn agent sync <name>`: recompile and rewrite donn's files in a created agent by the
// manifest's rules (docs/planning/24-adapter-eve.md, section 4). It never touches agent.ts or
// anything donn does not own. Also the shared lookups `list` uses.
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
 * unless `force`. `onCompiled` sees the compile before any stop.
 */
export async function syncAgent(
  ctx: Context,
  io: CliIo,
  name: string,
  options: {
    force?: boolean;
    dryRun?: boolean;
    onCompiled?: (output: AgentCompileOutput) => void;
  } = {},
): Promise<SyncedAgent> {
  const { root, result, dir, manifest } = await loadCreatedAgent(ctx, io, name);
  const { output, planned } = await recompile(ctx, result, name, dir, manifest);
  options.onCompiled?.(output);
  const { written, removed } = await pendingChanges(dir, planned, manifest);
  // A dry run stops where the real sync would; with --force it reports the overwrites.
  const edited = await checkOwned(dir, manifest, options.force === true);
  if (options.dryRun !== true) {
    const files = await writeAgentFiles(dir, output, manifest, {
      force: options.force === true,
      store: ctx.store,
    });
    await writeManifest(dir, { ...manifest, files });
  }
  return { root, dir, output, written, removed, edited };
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
