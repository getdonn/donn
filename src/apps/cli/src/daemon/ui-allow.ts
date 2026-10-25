import { allowedRun } from "./run.js";

// The commands the loopback bridge runs for the UI (`POST /v1/run`), each with `--json`. A
// separate list from `POST /run`'s (run.ts), which stays the mod's: the UI may write files the
// mod may not. Every flag is named here from its command in cli.ts; nothing free-form.
// See docs/planning/26-gui.md §2.

export type UiVerdict =
  { ok: true; project?: string } | { ok: false; rule: string };

interface Form {
  /** Flags that take no value. */
  switches?: readonly string[];
  /** Flags that take one value, the next argument. */
  values?: readonly string[];
  /** How many positional arguments: at least, at most. */
  args?: readonly [number, number];
  /** Flags the command has that the UI never sends, with why. */
  refused?: Readonly<Record<string, string>>;
}

const OVERLAY = ["--no-overlay", "--local"];

const COMMANDS: Readonly<Record<string, Form>> = {
  list: {},
  resolve: { switches: ["--explain", ...OVERLAY], args: [0, 1] },
  compile: {
    switches: ["--dry-run", ...OVERLAY],
    values: ["--harness"],
    args: [0, 1],
  },
  capabilities: {
    switches: ["--detect", "--markdown"],
    values: ["--harness"],
  },
  diff: { switches: OVERLAY, args: [1, 2] },
  status: {},
  doctor: { switches: ["--fix"], args: [0, 1] },
  whoami: {},
  login: {
    switches: ["--no-browser"],
    args: [1, 1],
    refused: {
      "--token": "login --token reads a terminal the bridge does not have",
      "--token-stdin":
        "login --token-stdin reads a stdin the bridge does not have",
    },
  },
  logout: {},
  pull: {},
  publish: { switches: ["--dry-run", "--force"], args: [1, 1] },
  write: { switches: ["--check", "--remove"], values: ["--harness"] },
};

const MANAGED: Readonly<Record<string, Form>> = {
  build: {
    switches: ["--from-registry"],
    values: ["--layer", "--os", "--out"],
  },
  check: {},
};

const PROJECT = ["--project"];
const NAMED = [1, 1] as const;

const AGENT: Readonly<Record<string, Form>> = {
  list: { values: PROJECT },
  create: {
    switches: ["--dry-run", "--force", "--accept-portability"],
    values: ["--template", "--target", "--path", "--eve", ...PROJECT],
    args: NAMED,
  },
  sync: { switches: ["--dry-run", "--force"], values: PROJECT, args: NAMED },
  build: { switches: ["--force"], values: PROJECT, args: NAMED },
  deploy: { switches: ["--yes"], values: PROJECT, args: NAMED },
  env: {
    values: ["--format", ...PROJECT],
    args: NAMED,
    refused: {
      "--resolve":
        "agent env --resolve prints secret values; the UI never shows them",
    },
  },
  run: {
    values: PROJECT,
    args: NAMED,
    refused: {
      "--dev": "agent run --dev is interactive: run it in a terminal",
    },
  },
  stop: { values: PROJECT, args: NAMED },
  logs: {
    values: PROJECT,
    args: NAMED,
    refused: {
      "--follow":
        "agent logs --follow never ends: the UI reads the agent's events",
    },
  },
};

/** Commands the UI never runs, with why. */
const NEVER: Readonly<Record<string, string>> = {
  daemon: "the UI never runs donn daemon: it is served by it",
  mod: "the UI never runs donn mod: it changes Claude Code's install",
  migrate: "the UI never runs donn migrate",
  init: "the UI never runs donn init",
  live: "the UI never runs donn live: it belongs to a harness session",
  claude: "the UI never launches claude",
  codex: "the UI never launches codex",
};

const NEVER_MANAGED: Readonly<Record<string, string>> = {
  install: "the UI never runs donn managed install: it needs sudo",
  uninstall: "the UI never runs donn managed uninstall: it needs sudo",
};

const no = (rule: string): UiVerdict => ({ ok: false, rule });

/** Whether `argv` is one of the UI's forms; when refused, the rule it breaks. */
export function uiAllowed(argv: readonly string[]): UiVerdict {
  const [command, sub] = argv;
  if (command === undefined || command.startsWith("-"))
    return no("argv must start with a command");
  if (Object.hasOwn(NEVER, command)) return no(NEVER[command]!);
  if (command === "switch") {
    // The forms POST /run allows the mod, and no others.
    return allowedRun(argv)
      ? { ok: true }
      : no("switch takes only the forms POST /run allows, with --json");
  }
  if (command === "managed") {
    if (sub !== undefined && Object.hasOwn(NEVER_MANAGED, sub))
      return no(NEVER_MANAGED[sub]!);
    if (sub === undefined || !Object.hasOwn(MANAGED, sub))
      return no("managed takes build or check");
    return check(`managed ${sub}`, MANAGED[sub]!, argv.slice(2));
  }
  if (command === "agent") {
    if (sub === "exec")
      return no("agent exec is never run from the UI: it runs any command");
    if (sub === undefined || !Object.hasOwn(AGENT, sub))
      return no(
        "agent takes list, create, sync, build, deploy, env, run, stop or logs",
      );
    return check(`agent ${sub}`, AGENT[sub]!, argv.slice(2));
  }
  if (!Object.hasOwn(COMMANDS, command))
    return no(`${command} is not a command the UI runs`);
  return check(command, COMMANDS[command]!, argv.slice(1));
}

/** The arguments after the command: known flags once each, values, positionals, `--json`. */
function check(name: string, form: Form, rest: readonly string[]): UiVerdict {
  const seen = new Set<string>();
  let args = 0;
  let project: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === "") return no(`${name}: an argument is empty`);
    if (!token.startsWith("-")) {
      args++;
      continue;
    }
    if (token === "--") return no(`${name}: nothing passes through after --`);
    if (form.refused && Object.hasOwn(form.refused, token))
      return no(form.refused[token]!);
    if (seen.has(token)) return no(`${name}: ${token} given twice`);
    seen.add(token);
    if (token === "--json" || form.switches?.includes(token)) continue;
    if (!form.values?.includes(token))
      return no(`${name}: ${token} is not a flag the UI sends`);
    const value = rest[++i];
    if (value === undefined || value === "" || value.startsWith("-"))
      return no(`${name}: ${token} needs a value`);
    if (token === "--project") project = value;
  }
  if (!seen.has("--json")) return no(`${name}: --json is required`);
  const [least, most] = form.args ?? [0, 0];
  if (args < least || args > most) {
    const count = least === most ? `${least}` : `${least} to ${most}`;
    return no(`${name} takes ${count} positional argument(s)`);
  }
  return project === undefined ? { ok: true } : { ok: true, project };
}
