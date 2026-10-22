import { basename, dirname, isAbsolute } from "node:path";
import type { Probe } from "@zzpersona/adapter-sdk";

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

/** The alias's command, without arguments or quotes. */
const aliasCommand = (target: string) =>
  target.split(/\s+/)[0]!.replace(/^["']|["']$/g, "");

/**
 * Why the shell runs a different `binary` than PATH gives zzpersona, and how to fix it, or
 * undefined when there is nothing to explain. `onPath` is what PATH finds, if anything.
 */
export function shellHint(
  binary: string,
  lookup: ShellLookup,
  onPath: string | undefined,
  shell = "",
): string | undefined {
  if (lookup.kind === "alias") {
    const command = aliasCommand(lookup.target);
    if (onPath !== undefined) {
      return command === onPath
        ? undefined
        : `your shell's ${binary} alias runs ${command}, but zzpersona runs ${onPath} (PATH)`;
    }
    const fix = isAbsolute(command)
      ? `export PATH="${dirname(command)}:$PATH" in your shell's startup file`
      : "add the folder that holds it to PATH";
    return `your shell has ${binary} as an alias for ${lookup.target}; zzpersona runs the ${binary} on PATH, which aliases don't change: ${fix}`;
  }
  if (lookup.kind === "path" && onPath === undefined) {
    const name = basename(shell) || "your shell";
    return `a new shell finds ${binary} at ${lookup.path}, but this one predates a PATH change: run exec ${name} or open a new terminal`;
  }
  return undefined;
}
