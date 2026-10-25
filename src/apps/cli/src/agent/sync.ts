import { dirname, resolve as resolvePath } from "node:path";
import type { AgentCompileOutput } from "@getdonn/adapter-sdk";
import type { ResolvedAgent, ResolveResult } from "@getdonn/spec";
import { printReport } from "../build.js";
import type { CliIo } from "../cli.js";
import {
  createContext,
  printWarnings,
  resolvePersona,
  type Context,
} from "../context.js";
import { CliError } from "../errors.js";
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
import { compile, compileInputs } from "./inputs.js";
import { listCreated } from "./registry.js";

// `donn agent sync <name>`: recompile and rewrite donn's files in a created agent by the
// manifest's rules (docs/planning/24-adapter-eve.md, section 4). It never touches agent.ts or
// anything donn does not own. Also the shared lookups `list` uses.
// See docs/planning/25-agent-runner.md, section 3.

export const PROJECT_PERSONA = "project/persona";

export type RecreateField = "template" | "target" | "path" | "world";

export interface SyncOptions {
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
  /** The project folder; the current directory's project by default. */
  project?: string;
}

/** The project's root folder and its resolved persona; undefined outside a project. */
export async function resolveProject(
  ctx: Context,
): Promise<{ root: string; result: ResolveResult } | undefined> {
  if (ctx.projectDir === undefined) return undefined;
  const result = await resolvePersona(
    ctx,
    { ref: PROJECT_PERSONA, source: "project" },
    false,
  );
  return { root: dirname(ctx.projectDir), result };
}

/** The agent's folder and manifest: at the persona's path, else where it was created. */
export async function locateAgent(
  ctx: Context,
  root: string,
  name: string,
  agent: ResolvedAgent,
): Promise<{ dir: string; manifest?: Manifest }> {
  const dir = resolvePath(root, agent.path);
  const own = (m: Manifest | undefined) => (m?.agent === name ? m : undefined);
  const here = own(await readManifest(dir));
  if (here !== undefined) return { dir, manifest: here };
  const created = (await listCreated(ctx.home)).find(
    (c) => c.project === root && c.name === name && c.path !== undefined,
  );
  if (created?.path !== undefined && created.path !== agent.path) {
    const moved = resolvePath(root, created.path);
    const manifest = own(await readManifest(moved));
    if (manifest !== undefined) return { dir: moved, manifest };
  }
  return { dir };
}

/** The first of template, target, path and world the persona changed since the create. */
export function recreateField(
  agent: ResolvedAgent,
  manifest: Manifest,
): RecreateField | undefined {
  if (agent.template !== manifest.template) return "template";
  if (agent.target !== manifest.target) return "target";
  if (agent.path !== manifest.path) return "path";
  if (agent.world !== manifest.world) return "world";
  return undefined;
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

const fixCreate = (name: string) => `donn agent create ${name}`;

export async function sync(
  io: CliIo,
  name: string,
  options: SyncOptions,
): Promise<number> {
  const ctx = await createContext(
    options.project === undefined
      ? io
      : { ...io, cwd: resolvePath(io.cwd, options.project) },
  );
  const project = await resolveProject(ctx);
  if (project === undefined) {
    throw new CliError(
      "no-project-persona",
      "no project persona here; an agent is declared in the repo's project persona",
      { fix: "donn init --extends <persona>" },
    );
  }
  const { root, result } = project;
  printWarnings(io, result);
  const agent = result.ir.agents[name];
  if (agent === undefined) {
    throw new CliError(
      "agent-not-declared",
      `the persona declares no agent ${name}`,
      { agent: name, fix: `${fixCreate(name)} --template <…> --target <…>` },
    );
  }
  const { dir, manifest } = await locateAgent(ctx, root, name, agent);
  const shown = posixRelative(root, dir);
  if (manifest === undefined) {
    throw new CliError(
      "agent-not-created",
      `agent ${name} is not created (nothing at ${shown})`,
      { agent: name, fix: fixCreate(name) },
    );
  }
  if (manifest.state !== "complete") {
    throw new CliError(
      "agent-incomplete",
      `${shown} holds an incomplete create of ${name}`,
      { dir, fix: `${fixCreate(name)} --force` },
    );
  }
  const field = recreateField(agent, manifest);
  if (field !== undefined) {
    throw new CliError(
      "recreate-needed",
      `the persona changed ${name}'s ${field} since it was created; that decides files donn does not own, so sync does not rewrite them`,
      {
        agent: name,
        field,
        fix: `remove ${shown}, then ${fixCreate(name)}`,
      },
    );
  }

  const { output, planned } = await recompile(ctx, result, name, dir, manifest);
  if (!options.json) printReport(io, output);
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
