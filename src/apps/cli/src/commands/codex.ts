import type { CliIo } from "../cli.js";
import { launch } from "../launch.js";

// `zzpersona codex`: the shared launch path with the Codex adapter. See docs/planning/12-codex.md.

export interface CodexOptions {
  dryRun?: boolean;
  json?: boolean;
  overlay: boolean;
}

export function codexCommand(
  io: CliIo,
  persona: string | undefined,
  options: CodexOptions,
  passthrough: string[],
): Promise<number> {
  return launch(io, {
    harness: "codex",
    binary: "codex",
    notInstalled: "codex-not-installed",
    ...(persona !== undefined && { persona }),
    ...(options.dryRun !== undefined && { dryRun: options.dryRun }),
    ...(options.json !== undefined && { json: options.json }),
    overlay: options.overlay,
    passthrough,
  });
}
