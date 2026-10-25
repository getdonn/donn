import { isAbsolute, resolve } from "node:path";
import { rootOf } from "../agent/run.js";
import { createCli, type CliIo } from "../cli.js";

// POST /run: the Claude Code mod's commands and the agent commands the GUI sends, run in-process
// with captured output. Only those forms are allowed: the socket must not launch harnesses,
// print secret values or stop the daemon. See docs/planning/15-mod-transport.md §1 and
// docs/planning/25-agent-runner.md §7.

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
  if (argv[0] === "agent") return parseAgent(argv) !== undefined;
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

/**
 * `donn agent` subcommands allowed on the socket, each with `--json`: their switches, the flags
 * that take a value, and whether they name an agent. Not `exec`, `logs` or `deploy`, not `env
 * --resolve` (values), not `run --dev` (a terminal UI).
 */
const AGENT: Record<
  string,
  { switches: readonly string[]; values: readonly string[]; named: boolean }
> = {
  list: { switches: [], values: ["--project"], named: false },
  sync: {
    switches: ["--dry-run", "--force"],
    values: ["--project"],
    named: true,
  },
  run: { switches: [], values: ["--project"], named: true },
  stop: { switches: [], values: ["--project"], named: true },
  build: { switches: ["--force"], values: ["--project"], named: true },
  env: { switches: [], values: ["--project", "--format"], named: true },
  create: {
    switches: ["--dry-run", "--force", "--accept-portability"],
    values: ["--project", "--template", "--target", "--path", "--eve"],
    named: true,
  },
};

interface AgentArgv {
  subcommand: string;
  name?: string;
  flags: Map<string, string | true>;
}

/** An allowed `agent …` argv, parsed; undefined for any other. */
function parseAgent(argv: readonly string[]): AgentArgv | undefined {
  const [, subcommand, ...rest] = argv;
  if (subcommand === undefined || !Object.hasOwn(AGENT, subcommand))
    return undefined;
  const allowed = AGENT[subcommand]!;
  const flags = new Map<string, string | true>();
  const names: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === "") return undefined;
    if (!token.startsWith("-")) {
      names.push(token);
      continue;
    }
    if (flags.has(token)) return undefined;
    if (token === "--json" || allowed.switches.includes(token)) {
      flags.set(token, true);
    } else if (allowed.values.includes(token)) {
      const value = rest[++i];
      if (value === undefined || value === "" || value.startsWith("-"))
        return undefined;
      flags.set(token, value);
    } else {
      return undefined;
    }
  }
  if (!flags.has("--json")) return undefined;
  if (names.length !== (allowed.named ? 1 : 0)) return undefined;
  return {
    subcommand,
    ...(names[0] !== undefined && { name: names[0] }),
    flags,
  };
}

/** For a `POST /run` of `agent create` that exited 0 (not a dry run): the agent and project. */
export function agentCreated(
  argv: readonly string[],
  cwd: string,
): { name: string; project: string } | undefined {
  if (argv[0] !== "agent") return undefined;
  const parsed = parseAgent(argv);
  if (parsed?.subcommand !== "create" || parsed.flags.has("--dry-run"))
    return undefined;
  const project = parsed.flags.get("--project");
  return {
    name: parsed.name!,
    project: rootOf(typeof project === "string" ? resolve(cwd, project) : cwd),
  };
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
