import { dirname, resolve as resolvePath } from "node:path";
import type { ResolvedAgent, ResolveResult } from "@getdonn/spec";
import type { CliIo } from "../cli.js";
import {
  createContext,
  printWarnings,
  resolvePersona,
  type Context,
} from "../context.js";
import { CliError } from "../errors.js";
import { posixRelative, readManifest, type Manifest } from "./files.js";
import { listCreated } from "./registry.js";

// Finding a created agent: the project, the declared agent, its folder and manifest, and the
// refusals every command on a created agent shares (`sync`, `env`, `exec`, later `run`).
// See docs/planning/25-agent-runner.md, section 3.

export const PROJECT_PERSONA = "project/persona";

export type RecreateField = "template" | "target" | "path" | "world";

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

export const noProjectPersona = () =>
  new CliError(
    "no-project-persona",
    "no project persona here; an agent is declared in the repo's project persona",
    { fix: "donn init --extends <persona>" },
  );

/** The project's root folder (the one holding `.donn/`), without resolving its persona. */
export function projectRoot(ctx: Context): string {
  if (ctx.projectDir === undefined) throw noProjectPersona();
  return dirname(ctx.projectDir);
}

export const fixCreate = (name: string) => `donn agent create ${name}`;

/** A context for the project folder `--project` names, or for the current directory. */
export async function projectContext(
  io: CliIo,
  project: string | undefined,
): Promise<Context> {
  return createContext(
    project === undefined ? io : { ...io, cwd: resolvePath(io.cwd, project) },
  );
}

export interface CreatedAgent {
  root: string;
  result: ResolveResult;
  agent: ResolvedAgent;
  dir: string;
  manifest: Manifest;
}

/**
 * The project's agent `name`, created and not out of date with its persona's template, target,
 * path or world; otherwise the refusal that says what to do.
 */
export async function loadCreatedAgent(
  ctx: Context,
  io: CliIo,
  name: string,
): Promise<CreatedAgent> {
  const project = await resolveProject(ctx);
  if (project === undefined) throw noProjectPersona();
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
  return { root, result, agent, dir, manifest };
}
