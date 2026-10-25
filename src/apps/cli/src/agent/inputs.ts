import adapter, { EveCompileError } from "@getdonn/adapter-eve";
import type {
  AgentCompileInput,
  AgentCompileOutput,
} from "@getdonn/adapter-sdk";
import type { ResolvedPersona } from "@getdonn/spec";
import type { Context } from "../context.js";
import { CliError } from "../errors.js";
import { listFiles, readManifest } from "./files.js";

// What an agent compile needs besides the IR: the text of every file the IR references, and the
// facts of the agent directory (the template's own paths, its sandbox and route auth). Shared by
// `create` (against the staged template) and `sync` (against the agent directory).
// See docs/planning/24-adapter-eve.md, section 1.

const PROJECT_PERSONA = "project/persona";
/** Top-level folders that are build output, installs or donn's own, never template files. */
const NOT_TEMPLATE = new Set([".output", ".eve", ".donn", ".vercel"]);
const MODULE = "(?:ts|mts|js|mjs|cjs)";
const SANDBOX = new RegExp(`^agent/(?:sandbox\\.${MODULE}$|sandbox/)`);
const ROUTE_AUTH = new RegExp(`^agent/channels/(?:eve\\.${MODULE}$|eve/)`);

/** Paths under `dir` a compile must not collide with: everything not donn's, not built, not installed. */
async function existingPaths(dir: string): Promise<string[]> {
  const owned = new Set(Object.keys((await readManifest(dir))?.files ?? {}));
  const files = await listFiles(dir, (path) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return (
      name === "node_modules" ||
      name === ".git" ||
      (!path.includes("/") && NOT_TEMPLATE.has(path))
    );
  });
  return files.filter((path) => !owned.has(path));
}

export async function compileInputs(
  ctx: Context,
  ir: ResolvedPersona,
  agent: string,
  dir: string,
  frameworkVersion: string,
): Promise<AgentCompileInput> {
  return inputsFor(ctx, ir, agent, frameworkVersion, await existingPaths(dir));
}

/** The compile input for an agent directory holding `existing` (none, for a dry run). */
export async function inputsFor(
  ctx: Context,
  ir: ResolvedPersona,
  agent: string,
  frameworkVersion: string,
  existing: string[],
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
