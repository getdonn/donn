import type {
  ActivationPlan,
  CompileOutput,
  Detection,
} from "@getdonn/adapter-sdk";
import { buildDirFor } from "@getdonn/executor";
import type { ResolveResult } from "@getdonn/spec";
import type { CliIo } from "./cli.js";
import { printWarnings, resolvePersona, type Context } from "./context.js";
import { findAdapter } from "./plugins.js";
import type { Selection } from "./select.js";

export interface PreparedBuild {
  result: ResolveResult;
  detection: Detection;
  output: CompileOutput;
  plan: ActivationPlan;
  buildDir: string;
  /** Distinct secret refs the build needs, never their values. */
  secretRefs: string[];
}

/** Resolve → detect → compile → plan. Shared by compile and claude; writes nothing. */
export async function prepareBuild(
  ctx: Context,
  io: CliIo,
  options: {
    selection: Selection;
    harness: string;
    facts?: Detection["facts"];
    overlay: boolean;
    passthrough: string[];
    /** Resolve warnings are the caller's to print (a report that builds several harnesses). */
    quiet?: boolean;
    /** Detection the caller already ran. */
    detection?: Detection;
  },
): Promise<PreparedBuild> {
  const adapter = await findAdapter(ctx, io.env, options.harness);
  const result = await resolvePersona(ctx, options.selection, options.overlay);
  if (!options.quiet) printWarnings(io, result);
  const detected = options.detection ?? (await adapter.detect(io.probe));
  const detection: Detection = {
    ...detected,
    facts: { ...detected.facts, ...options.facts },
  };
  const texts: Record<string, string> = {};
  for (const fragment of result.ir.instructions) {
    if ("file" in fragment)
      texts[fragment.file] = await ctx.store.readText(fragment.file);
  }
  const output = adapter.compile({
    personaId: options.selection.ref,
    ir: result.ir,
    detection,
    texts,
  });
  const buildDir = buildDirFor(
    options.selection.ref,
    ctx.projectDir,
    adapter.id,
    ctx.home,
  );
  const plan = adapter.activate({
    ir: result.ir,
    output,
    buildDir,
    detection,
    cwd: io.cwd,
    passthrough: options.passthrough,
  });
  const secretRefs = [...new Set(Object.values(output.secretEnv))];
  return { result, detection, output, plan, buildDir, secretRefs };
}

export function printReport(io: CliIo, output: CompileOutput): void {
  for (const e of output.report.entries) {
    const lock = e.lock ? ` [locked: ${e.lock.path} by ${e.lock.layer}]` : "";
    io.stderr.write(`${e.outcome}: ${e.path} — ${e.reason}${lock}\n`);
  }
}
