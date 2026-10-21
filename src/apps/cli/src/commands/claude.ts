import { renderBuild, type Detection } from "@zzpersona/adapter-sdk";
import { runPlan, writeBuild } from "@zzpersona/executor";
import { resolveSecrets } from "@zzpersona/secrets";
import { prepareBuild, printReport } from "../build.js";
import type { CliIo } from "../cli.js";
import { createContext } from "../context.js";
import { CliError } from "../errors.js";
import { selectPersona } from "../select.js";

// The core loop: resolve → detect → compile → write → resolve secrets → launch claude.
// See docs/planning/06-cli-core-loop.md, section 4.

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
  const ctx = await createContext(io);
  const selection = await selectPersona(persona, ctx);
  const build = await prepareBuild(ctx, io, {
    selection,
    harness: "claude-code",
    overlay: options.overlay,
    passthrough,
    ...(options.mode && { facts: MODE_FACTS[options.mode] }),
  });
  printReport(io, build.output);

  if (options.json) {
    const { buildDir, output, secretRefs, plan } = build;
    io.stdout.write(
      `${JSON.stringify({ buildDir, report: output.report, secretRefs, plan }, null, 2)}\n`,
    );
    return 0;
  }
  if (options.dryRun) {
    io.stdout.write(renderBuild(build.output, build.plan));
    return 0;
  }
  if (!build.detection.installed) {
    throw new CliError(
      "claude-not-installed",
      "claude is not installed (or not on PATH)",
    );
  }

  const values = await resolveSecrets(
    build.secretRefs,
    build.result.ir.secrets.providers,
    { env: io.env },
  );
  const secretEnv = Object.fromEntries(
    Object.entries(build.output.secretEnv).map(([name, ref]) => [
      name,
      values[ref]!,
    ]),
  );
  await writeBuild(build.output, {
    buildDir: build.buildDir,
    store: ctx.store,
  });

  const now = io.now ?? Date.now;
  const started = now();
  const code = await (io.runPlan ?? runPlan)(build.plan, {
    secretEnv,
    env: io.env,
  });
  // A signal exit (> 128) was the user or the system, not managed settings.
  if (code !== 0 && code <= 128 && now() - started < QUICK_FAILURE_MS) {
    io.stderr.write(`${MANAGED_HINT}\n`);
  }
  return code;
}
