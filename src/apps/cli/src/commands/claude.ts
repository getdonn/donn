import { dirname } from "node:path";
import { renderBuild, type Detection } from "@zzpersona/adapter-sdk";
import { runPlan, writeBuild } from "@zzpersona/executor";
import { resolveSecrets } from "@zzpersona/secrets";
import { backendLoader } from "../plugins.js";
import { prepareBuild, printReport } from "../build.js";
import type { CliIo } from "../cli.js";
import { secretContext } from "../secret-context.js";
import { createContext } from "../context.js";
import { CliError } from "../errors.js";
import { createSession, removeSession, sessionPlugins } from "../session.js";
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
  // Tell the session which persona it runs, for the mod (spec 09 §1). Refs and paths only.
  const launchEnv: Record<string, string> = {
    ZZPERSONA_PERSONA: selection.ref,
    ZZPERSONA_SOURCE: selection.source,
    ...(ctx.projectDir !== undefined && {
      ZZPERSONA_PROJECT: dirname(ctx.projectDir),
    }),
  };
  build.plan = {
    ...build.plan,
    steps: build.plan.steps.map((step) =>
      step.kind === "launch"
        ? { ...step, env: { ...step.env, ...launchEnv } }
        : step,
    ),
  };

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
    secretContext(io),
    { loadBackend: backendLoader(ctx, io.env) },
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

  // Relaunch mode passes the persona plugin with --plugin-dir: launch with a session folder of
  // plugins instead, so `zzpersona live` can swap it mid-session (spec 10 §1).
  const launch = build.plan.steps.find((step) => step.kind === "launch");
  const pluginArg = launch ? launch.args.indexOf("--plugin-dir") : -1;
  let session: string | undefined;
  if (launch && pluginArg !== -1) {
    session = await createSession(
      ctx.home,
      launch.args[pluginArg + 1]!,
      { persona: selection.ref, source: selection.source },
      process.pid,
    );
    const args = [...launch.args];
    args[pluginArg + 1] = sessionPlugins(session);
    build.plan = {
      ...build.plan,
      steps: build.plan.steps.map((step) =>
        step === launch
          ? {
              ...launch,
              args,
              env: { ...launch.env, ZZPERSONA_SESSION: session! },
            }
          : step,
      ),
    };
  }

  const now = io.now ?? Date.now;
  const started = now();
  let code: number;
  try {
    code = await (io.runPlan ?? runPlan)(build.plan, {
      secretEnv,
      env: io.env,
    });
  } finally {
    if (session !== undefined) await removeSession(session);
  }
  // A signal exit (> 128) was the user or the system, not managed settings.
  if (code !== 0 && code <= 128 && now() - started < QUICK_FAILURE_MS) {
    io.stderr.write(`${MANAGED_HINT}\n`);
  }
  return code;
}
