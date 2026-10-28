import adapter, { EveCompileError } from "@getdonn/adapter-eve";
import type {
  AgentCompileInput,
  AgentCompileOutput,
} from "@getdonn/adapter-sdk";
import type { ResolvedPersona } from "@getdonn/spec";
import type { Context } from "../context.js";
import { CliError } from "../errors.js";
import {
  listFiles,
  notTemplate,
  readManifest,
  type Manifest,
} from "./files.js";
import { subagentTexts } from "./subagents.js";

// What an agent compile needs besides the IR: the text of every file the IR references, and the
// facts of the agent directory (the template's own paths, its sandbox and route auth, its
// subagents' agent.ts). Shared by
// `create` (against the staged template) and `sync` (against the agent directory).
// See docs/planning/24-adapter-eve.md, section 1.

const PROJECT_PERSONA = "project/persona";
const MODULE = "(?:ts|mts|js|mjs|cjs)";
const SANDBOX = new RegExp(`^agent/(?:sandbox\\.${MODULE}$|sandbox/)`);
const ROUTE_AUTH = new RegExp(`^agent/channels/(?:eve\\.${MODULE}$|eve/)`);

/** Paths under `dir` a compile must not collide with: everything not donn's, not built, not installed. */
async function existingPaths(
  dir: string,
  manifest: Manifest | undefined,
): Promise<string[]> {
  const owned = new Set(Object.keys(manifest?.files ?? {}));
  const files = await listFiles(dir, notTemplate);
  return files.filter((path) => !owned.has(path) && !notTemplate(path));
}

export async function compileInputs(
  ctx: Context,
  ir: ResolvedPersona,
  agent: string,
  dir: string,
  frameworkVersion: string,
): Promise<AgentCompileInput> {
  const manifest = await readManifest(dir);
  return inputsFor(
    ctx,
    ir,
    agent,
    frameworkVersion,
    await existingPaths(dir, manifest),
    { texts: await subagentTexts(dir), edited: manifest?.edits ?? [] },
  );
}

/**
 * The compile input for an agent directory holding `existing`, the template-owned `texts` the
 * compile reads and the files donn `edited` once (none, for a dry run).
 */
export async function inputsFor(
  ctx: Context,
  ir: ResolvedPersona,
  agent: string,
  frameworkVersion: string,
  existing: string[],
  project: { texts: Record<string, string>; edited: string[] } = {
    texts: {},
    edited: [],
  },
): Promise<AgentCompileInput> {
  const texts: Record<string, string> = {};
  for (const fragment of ir.instructions) {
    if ("file" in fragment)
      texts[fragment.file] = await ctx.store.readText(fragment.file);
  }
  for (const skill of ir.skills) {
    if (skill.source.includes("://")) continue;
    const source = skill.source.replace(/\/+$/, "");
    const location = ctx.store.locate(source);
    if (!location) continue; // The compile names the missing SKILL.md.
    for (const file of await listFiles(location.path)) {
      const key = `${source}/${file}`;
      texts[key] = await ctx.store.readText(key);
    }
  }
  return {
    personaId: PROJECT_PERSONA,
    ir,
    agent,
    frameworkVersion,
    texts,
    project: {
      hasSandbox: existing.some((path) => SANDBOX.test(path)),
      hasRouteAuth: existing.some((path) => ROUTE_AUTH.test(path)),
      existing,
      texts: project.texts,
      edited: project.edited,
    },
  };
}

/** The eve adapter's compile; its errors become CLI errors. */
export function compile(input: AgentCompileInput): AgentCompileOutput {
  try {
    return adapter.compile(input);
  } catch (error) {
    if (error instanceof EveCompileError)
      throw new CliError(error.code, error.message);
    throw error;
  }
}
