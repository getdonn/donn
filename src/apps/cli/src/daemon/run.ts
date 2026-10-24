import { isAbsolute } from "node:path";
import { createCli, type CliIo } from "../cli.js";

// POST /run: the Claude Code mod's commands, run in-process with captured output. Only the forms
// the mod sends are allowed: the socket must not launch harnesses, write files or stop the
// daemon. See docs/planning/15-mod-transport.md §1.

/** The flags each command may carry besides `--json`; `--session` takes a value. */
const FLAGS: Record<string, readonly string[]> = {
  switch: ["--default", "--clear"],
  list: [],
  live: ["--show", "--session"],
};

/**
 * Whether `argv` is one of the mod's forms, each with `--json`: `switch`, `switch <persona>`,
 * `switch <persona> --default`, `switch --clear`, `switch --clear --default`, `list`,
 * `live <persona> --session <abs dir>`, `live --show --session <abs dir>`; flags in any order.
 */
export function allowedRun(argv: readonly string[]): boolean {
  const [command, ...rest] = argv;
  if (command === undefined || !Object.hasOwn(FLAGS, command)) return false;
  const json = rest.indexOf("--json");
  if (json === -1) return false;
  rest.splice(json, 1);

  const flags = new Set<string>();
  const personas: string[] = [];
  let session: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith("-")) {
      if (!FLAGS[command]!.includes(token) || flags.has(token)) return false;
      flags.add(token);
      if (token === "--session") {
        session = rest[++i];
        if (session === undefined || !isAbsolute(session)) return false;
      }
    } else if (token === "") {
      return false;
    } else {
      personas.push(token);
    }
  }
  if (personas.length > 1) return false;
  const persona = personas.length === 1;

  if (command === "list") return flags.size === 0 && !persona;
  if (command === "switch") {
    if (flags.has("--clear")) return !persona;
    return !flags.has("--default") || persona;
  }
  // live
  if (session === undefined) return false;
  return flags.has("--show") ? !persona : persona;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run `donn <argv>` in `cwd` with the daemon's io, capturing what it prints. */
export async function runInProcess(
  io: Omit<CliIo, "cwd" | "stdout" | "stderr">,
  argv: string[],
  cwd: string,
): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  try {
    const exitCode = await createCli({
      ...io,
      cwd,
      stdout: { write: (text: string) => (stdout += text) },
      stderr: { write: (text: string) => (stderr += text) },
    }).run(argv);
    return { exitCode, stdout, stderr };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}
