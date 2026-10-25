import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import type { Probe } from "@getdonn/adapter-sdk";
import { userHomeDir } from "./userhome.js";

// What the user's own shell runs for a command, to explain a harness that PATH does not find:
// an alias (which a spawn without a shell ignores) or a PATH change this process predates.
// Asked only when there is something to explain: an interactive shell costs a start-up.

export type ShellLookup =
  | { kind: "alias"; target: string }
  | { kind: "path"; path: string }
  | { kind: "missing" }
  | { kind: "unknown" };

/** `type <binary>` in an interactive `$SHELL`, read as zsh and bash print it. */
export async function shellLookup(
  binary: string,
  io: { env: Record<string, string | undefined>; probe: Probe },
): Promise<ShellLookup> {
  // The name goes into a shell command line.
  if (!/^[\w.-]+$/.test(binary))
    throw new Error(`not a command name: ${binary}`);
  const shell = io.env.SHELL;
  if (!shell || io.probe.platform === "win32") return { kind: "unknown" };
  const result = await io.probe.run(shell, ["-ic", `type ${binary}`]);
  // An rc file may print its own lines; only the answer about the binary counts.
  const line = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((l) => l.trim())
    .find(
      (l) => l.startsWith(`${binary} `) || l.endsWith(`: ${binary}: not found`),
    );
  if (line === undefined) return { kind: "unknown" };
  const alias =
    /^\S+ is an alias for (.+)$/.exec(line) ??
    /^\S+ is aliased to [`'](.+)'$/.exec(line);
  if (alias) return { kind: "alias", target: alias[1]!.trim() };
  const path =
    /^\S+ is hashed \((\/.+)\)$/.exec(line) ?? /^\S+ is (\/\S+)$/.exec(line);
  if (path) return { kind: "path", path: path[1]! };
  if (/not found$/.test(line)) return { kind: "missing" };
  return { kind: "unknown" };
}

/** Words an alias may put before the command it runs. */
const WRAPPERS = new Set([
  "command",
  "builtin",
  "exec",
  "noglob",
  "nocorrect",
  "env",
]);

/** The command an alias runs, with ~ and $HOME expanded: quotes, wrappers and arguments dropped. */
function aliasCommand(target: string, home: string): string | undefined {
  const words = target
    .split(/\s+/)
    .map((w) => w.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  const command = words.find((w) => !WRAPPERS.has(w) && !/^\w+=/.test(w));
  if (command === undefined || !home) return command;
  return command.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Why the shell runs a different `binary` than PATH gives donn, and how to fix it, or
 * undefined when there is nothing to explain. `onPath` is what PATH finds, if anything.
 */
export function shellHint(
  binary: string,
  lookup: ShellLookup,
  onPath: string | undefined,
  shell = "",
  home = "",
): string | undefined {
  if (lookup.kind === "alias") {
    const command = aliasCommand(lookup.target, home);
    // An alias for the binary itself (with flags, say), or for a command it cannot place.
    if (command === undefined || !isAbsolute(command)) return undefined;
    if (onPath !== undefined) {
      return real(command) === real(onPath)
        ? undefined
        : `your shell's ${binary} alias runs ${command}, but donn runs ${onPath} (PATH)`;
    }
    const fix =
      basename(command) === binary
        ? `export PATH="${dirname(command)}:$PATH" in your shell's startup file`
        : `put a ${binary} on PATH that runs ${command}`;
    return `your shell has ${binary} as an alias for ${lookup.target}; donn runs the ${binary} on PATH, which aliases don't change: ${fix}`;
  }
  if (lookup.kind === "path" && onPath === undefined) {
    const name = basename(shell) || "your shell";
    return `a new shell finds ${binary} at ${lookup.path}, but this one predates a PATH change: run exec ${name} or open a new terminal`;
  }
  return undefined;
}

/**
 * Why a harness detection found no `binary`: one on PATH that did not answer, or what the shell
 * knows (asked only then), or undefined.
 */
export async function missingHint(
  binary: string,
  onPath: string | undefined,
  io: {
    env: Record<string, string | undefined>;
    probe: Probe;
    passwdHome?: () => string | undefined;
  },
): Promise<string | undefined> {
  if (onPath !== undefined)
    return `${onPath} is on PATH but \`${binary} --version\` failed: run it to see why`;
  return shellHint(
    binary,
    await shellLookup(binary, io),
    undefined,
    io.env.SHELL,
    userHomeDir(io.env, io.passwdHome),
  );
}
