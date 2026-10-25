import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CliIo } from "../cli.js";
import { nodeSpawn } from "./spawn.js";

// Running the agent project's own eve (`<pm> exec eve …`). The CLI never bundles eve: the
// agent project pins its version. See docs/planning/25-agent-runner.md.

const TAIL_LINES = 20;

/** The project's package manager, from package.json's `packageManager`; pnpm when unsaid. */
export async function packageManager(dir: string): Promise<"pnpm" | "npm"> {
  try {
    const raw = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    const field: unknown = raw?.packageManager;
    if (typeof field === "string" && /^npm(@|$)/.test(field)) return "npm";
  } catch {
    // No readable package.json: the default.
  }
  return "pnpm";
}

/**
 * The environment for an eve child: `extra` over `base`, then production with the dev and test
 * switches removed (EVE_DEV, EVE_MOCK_AUTHORED_MODELS, VITEST), so `extra` cannot bring them back.
 */
export function eveEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  for (const name of ["EVE_DEV", "EVE_MOCK_AUTHORED_MODELS", "VITEST"]) {
    delete env[name];
  }
  env.NODE_ENV = "production";
  return env;
}

/** Runs `command args` in `dir`, keeping the last lines; a non-zero exit is returned, not thrown. */
export async function runTool(
  io: CliIo,
  dir: string,
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; onProgress?: (line: string) => void },
): Promise<{ exitCode: number; tail: string[] }> {
  const spawn = io.spawn ?? nodeSpawn;
  const tail: string[] = [];
  const child = spawn(command, args, {
    cwd: dir,
    env: options.env,
    onLine: (line) => {
      tail.push(line);
      if (tail.length > TAIL_LINES) tail.shift();
      options.onProgress?.(line);
    },
  });
  const exitCode = await child.exited;
  return { exitCode, tail };
}

/** Runs `<pm> exec eve <args>` in `dir`; a non-zero exit is returned, not thrown. */
export async function runEve(
  io: CliIo,
  dir: string,
  args: string[],
  options: { env: Record<string, string>; onProgress?: (line: string) => void },
): Promise<{ exitCode: number; tail: string[] }> {
  const pm = await packageManager(dir);
  return runTool(io, dir, pm, ["exec", "eve", ...args], {
    env: eveEnv(io.env, options.env),
    ...(options.onProgress && { onProgress: options.onProgress }),
  });
}
