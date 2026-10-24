import { renderBuild } from "@getdonn/adapter-sdk";
import { writeBuild } from "@getdonn/executor";
import { prepareBuild, printReport } from "../build.js";
import type { CliIo } from "../cli.js";
import { createContext } from "../context.js";
import { selectPersona } from "../select.js";

export interface CompileOptions {
  harness: string;
  dryRun?: boolean;
  json?: boolean;
  overlay: boolean;
  local?: boolean;
}

export async function compileCommand(
  io: CliIo,
  persona: string | undefined,
  options: CompileOptions,
): Promise<number> {
  const ctx = await createContext(io, { local: options.local === true });
  const selection = await selectPersona(persona, ctx);
  const build = await prepareBuild(ctx, io, {
    selection,
    harness: options.harness,
    overlay: options.overlay,
    passthrough: [],
  });
  printReport(io, build.output);
  if (!options.dryRun)
    await writeBuild(build.output, {
      buildDir: build.buildDir,
      store: ctx.store,
    });
  if (options.json) {
    const { buildDir, output, secretRefs, plan } = build;
    io.stdout.write(
      `${JSON.stringify({ buildDir, report: output.report, secretRefs, plan }, null, 2)}\n`,
    );
  } else if (options.dryRun) {
    io.stdout.write(renderBuild(build.output, build.plan));
  } else {
    io.stdout.write(`build: ${build.buildDir}\n`);
  }
  return 0;
}
