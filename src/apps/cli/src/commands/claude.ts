import type { Detection } from "@zzpersona/adapter-sdk";
import type { CliIo } from "../cli.js";
import { launch } from "../launch.js";
import { createSession, removeSession, sessionPlugins } from "../session.js";

// `zzpersona claude`: the shared launch path, plus the session folder that `zzpersona live` swaps
// and the managed-settings hint. See docs/planning/06-cli-core-loop.md, section 4.

export type Mode = "partial" | "relaunch-no-mcp";

const MODE_FACTS: Record<Mode, Detection["facts"]> = {
  partial: { sideloadBlocked: true },
  "relaunch-no-mcp": { managedMcp: true },
};

/** Managed policy from MDM, registry or server is invisible to detect; a fast failure hints. */
const QUICK_FAILURE_MS = 5000;
const MANAGED_HINT =
  "If Claude Code said flags are disabled by managed settings, retry with --mode partial.";

export interface ClaudeOptions {
  mode?: Mode;
  dryRun?: boolean;
  json?: boolean;
  overlay: boolean;
}

export async function claudeCommand(
  io: CliIo,
  persona: string | undefined,
  options: ClaudeOptions,
  passthrough: string[],
): Promise<number> {
  return launch(
    io,
    {
      harness: "claude-code",
      binary: "claude",
      notInstalled: "claude-not-installed",
      ...(persona !== undefined && { persona }),
      ...(options.dryRun !== undefined && { dryRun: options.dryRun }),
      ...(options.json !== undefined && { json: options.json }),
      overlay: options.overlay,
      ...(options.mode && { facts: MODE_FACTS[options.mode] }),
      passthrough,
    },
    {
      // Relaunch mode passes the persona plugin with --plugin-dir: launch with a session folder
      // of plugins instead, so `zzpersona live` can swap it mid-session (spec 10 §1).
      async beforeRun(build, ctx, selection) {
        const step = build.plan.steps.find((s) => s.kind === "launch");
        const pluginArg = step ? step.args.indexOf("--plugin-dir") : -1;
        if (!step || pluginArg === -1) return undefined;
        const session = await createSession(
          ctx.home,
          step.args[pluginArg + 1]!,
          {
            persona: selection.ref,
            source: selection.source,
            overlay: options.overlay,
            snapshot: {
              mcp: build.result.ir.mcp,
              permissions: build.result.ir.permissions,
              settings: build.result.ir.targets["claude-code"] ?? {},
            },
          },
          process.pid,
        );
        const args = [...step.args];
        args[pluginArg + 1] = sessionPlugins(session);
        build.plan = {
          ...build.plan,
          steps: build.plan.steps.map((s) =>
            s === step
              ? {
                  ...step,
                  args,
                  env: { ...step.env, ZZPERSONA_SESSION: session },
                }
              : s,
          ),
        };
        return () => removeSession(session);
      },
      // A signal exit (> 128) was the user or the system, not managed settings.
      afterRun(code, elapsedMs) {
        if (code !== 0 && code <= 128 && elapsedMs < QUICK_FAILURE_MS) {
          io.stderr.write(`${MANAGED_HINT}\n`);
        }
      },
    },
  );
}
