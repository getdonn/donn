import { dirname } from "node:path";
import { renderBuild, type Detection } from "@zzpersona/adapter-sdk";
import { runPlan, writeBuild } from "@zzpersona/executor";
import { resolveSecrets } from "@zzpersona/secrets";
import { backendLoader } from "./plugins.js";
import { prepareBuild, printReport, type PreparedBuild } from "./build.js";
import type { CliIo } from "./cli.js";
import { secretContext } from "./secret-context.js";
import { createContext, homeOf, type Context } from "./context.js";
import { ensureDaemon } from "./daemon/autostart.js";
import { CliError } from "./errors.js";
import { findOnPath } from "./path.js";
import { freshen } from "./registry.js";
import { selectPersona, type Selection } from "./select.js";
import { missingHint } from "./shell.js";

// The launch path the harness commands share: select → compile → write → resolve secrets → run.
// See docs/planning/06-cli-core-loop.md, section 4, and 12-codex.md, section 2.

export interface LaunchOptions {
  harness: string;
  persona?: string;
  dryRun?: boolean;
  json?: boolean;
  overlay: boolean;
  facts?: Detection["facts"];
  passthrough: string[];
  /** The error code when the harness is missing, e.g. `claude-not-installed`. */
  notInstalled: string;
  /** The harness binary, for the not-installed message. */
  binary: string;
}

export interface LaunchHooks {
  /** Runs after the build is written; may rewrite `build.plan`; returns a cleanup. */
  beforeRun?(
    build: PreparedBuild,
    ctx: Context,
    selection: Selection,
  ): Promise<(() => Promise<void>) | undefined>;
  /** Runs after the harness exits, with how long it ran. */
  afterRun?(code: number, elapsedMs: number): void;
}

export async function launch(
  io: CliIo,
  options: LaunchOptions,
  hooks: LaunchHooks = {},
): Promise<number> {
  // A dry run or --json (the mod's daemon calls) never waits on the network.
  if (!options.dryRun && !options.json) await freshen(io, { budgetMs: 1000 });
  const ctx = await createContext(io);
  const selection = await selectPersona(options.persona, ctx);
  const build = await prepareBuild(ctx, io, {
    selection,
    harness: options.harness,
    overlay: options.overlay,
    passthrough: options.passthrough,
    ...(options.facts && { facts: options.facts }),
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
    const hint = await missingHint(
      options.binary,
      findOnPath(options.binary, io.env),
      io,
    );
    throw new CliError(
      options.notInstalled,
      `${options.binary} is not installed (or not on PATH)${hint ? `; ${hint}` : ""}`,
      hint ? { hint } : {},
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

  const cleanup = await hooks.beforeRun?.(build, ctx, selection);
  // After beforeRun: a daemon up later finds the session from `launched.json`.
  await ensureDaemon(io, homeOf(io), ctx.config);
  const now = io.now ?? Date.now;
  const started = now();
  let code: number;
  try {
    code = await (io.runPlan ?? runPlan)(build.plan, {
      secretEnv,
      env: io.env,
    });
  } finally {
    await cleanup?.();
  }
  hooks.afterRun?.(code, now() - started);
  return code;
}
