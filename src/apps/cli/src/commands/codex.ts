import { dirname } from "node:path";
import type { CliIo } from "../cli.js";
import { launch } from "../launch.js";
import { buildHash, createSession, removeSession } from "../session.js";

// `donn codex`: the shared launch path with the Codex adapter. See docs/planning/12-codex.md.
// It registers a plugin-less session so the daemon can list it (spec 14 §2).

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
  return launch(
    io,
    {
      harness: "codex",
      binary: "codex",
      notInstalled: "codex-not-installed",
      ...(persona !== undefined && { persona }),
      ...(options.dryRun !== undefined && { dryRun: options.dryRun }),
      ...(options.json !== undefined && { json: options.json }),
      overlay: options.overlay,
      passthrough,
    },
    {
      async beforeRun(build, ctx, selection) {
        const session = await createSession(
          ctx.home,
          undefined,
          {
            persona: selection.ref,
            source: selection.source,
            overlay: options.overlay,
            harness: "codex",
            ...(ctx.projectDir !== undefined && {
              project: dirname(ctx.projectDir),
            }),
            startedAt: new Date().toISOString(),
            buildHash: buildHash(build.output),
          },
          process.pid,
        );
        return () => removeSession(session);
      },
    },
  );
}
