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
 * The environment for an eve child: production, with the dev and test switches removed
 * (EVE_DEV, EVE_MOCK_AUTHORED_MODELS, VITEST), then `extra` on top.
 */
export function eveEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of ["EVE_DEV", "EVE_MOCK_AUTHORED_MODELS", "VITEST"]) {
    delete env[name];
  }
  env.NODE_ENV = "production";
  return { ...env, ...extra };
}

/** Runs `<pm> exec eve <args>` in `dir`; a non-zero exit is returned, not thrown. */
export async function runEve(
  io: CliIo,
  dir: string,
  args: string[],
  options: { env: Record<string, string>; onProgress?: (line: string) => void },
): Promise<{ exitCode: number; tail: string[] }> {
  const spawn = io.spawn ?? nodeSpawn;
  const pm = await packageManager(dir);
  const tail: string[] = [];
  const child = spawn(pm, ["exec", "eve", ...args], {
    cwd: dir,
    env: eveEnv(io.env, options.env),
    onLine: (line) => {
      tail.push(line);
      if (tail.length > TAIL_LINES) tail.shift();
      options.onProgress?.(line);
    },
  });
  const exitCode = await child.exited;
  return { exitCode, tail };
}
