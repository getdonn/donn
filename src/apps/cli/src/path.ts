import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

// Where PATH finds a command, as a spawn without a shell would: the mod runs `zzpersona` this
// way, so shell aliases and functions do not count.

export function findOnPath(
  command: string,
  env: Record<string, string | undefined>,
): string | undefined {
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = join(dir, command);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** The fix for a missing `zzpersona`, as the README's install section gives it. */
export const CLI_ON_PATH_FIX =
  'run `pnpm add --global "link:<repo>/src/apps/cli"` (after `pnpm setup`); see the README';
