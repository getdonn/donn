import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Ref } from "@zzpersona/spec";
import { z } from "zod";
import { CliError } from "./errors.js";
import { fsStep, withFileLock, writeFileAtomic } from "./fs.js";

// <home>/state.json: the per-project switches and the default. See
// docs/planning/07-cli-daily-use.md, section 1.

const StateFile = z.strictObject({
  version: z.literal(1),
  default: z.string().min(1).optional(),
  projects: z.record(z.string(), z.string().min(1)),
});

export interface State {
  version: 1;
  default?: Ref;
  /** Real path of a project's .zzpersona directory → the persona switched to. */
  projects: Record<string, Ref>;
}

const stateFile = (home: string) => join(home, "state.json");

export async function readState(home: string): Promise<State> {
  const file = stateFile(home);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, projects: {} };
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new CliError(
      "invalid-state",
      `invalid ${file}: ${(error as Error).message}`,
      {
        file,
      },
    );
  }
  const parsed = StateFile.safeParse(raw);
  if (!parsed.success) {
    throw new CliError(
      "invalid-state",
      `invalid ${file}: ${parsed.error.message}`,
      {
        file,
      },
    );
  }
  return parsed.data as State;
}

export async function writeState(home: string, state: State): Promise<void> {
  await writeFileAtomic(stateFile(home), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Read state.json, apply `change`, and write it back under a lock, so concurrent commands
 * (switches in two projects) never lose each other's entries.
 */
export async function updateState(
  home: string,
  change: (state: State) => void,
): Promise<State> {
  const file = stateFile(home);
  return fsStep(file, () =>
    withFileLock(join(home, "state.lock"), async () => {
      const state = await readState(home);
      change(state);
      await writeState(home, state);
      return state;
    }),
  );
}

/** State keys are real paths, so a symlinked checkout finds its switch. */
export function projectKey(projectDir: string): Promise<string> {
  return realpath(projectDir);
}
