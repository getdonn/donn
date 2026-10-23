import { resolve } from "node:path";
import type { ManagedOs } from "@zzpersona/adapter-sdk";
import type { CliIo } from "../cli.js";
import { createContext } from "../context.js";
import { CliError } from "../errors.js";
import { writeBundle } from "../managed/bundle-io.js";
import { buildBundle, defaultOs, MANAGED_OSES } from "../managed/build.js";

export interface ManagedBuildOptions {
  layer?: string;
  os?: string;
  out?: string;
  fromRegistry?: boolean;
  json?: boolean;
}

export async function managedBuildCommand(
  io: CliIo,
  options: ManagedBuildOptions,
): Promise<number> {
  const os = (options.os ?? defaultOs()) as ManagedOs;
  if (!MANAGED_OSES.includes(os)) {
    throw new CliError(
      "managed-bad-os",
      `--os must be one of ${MANAGED_OSES.join(", ")}`,
      { os: options.os },
    );
  }
  const ctx = await createContext(io);
  const result = await buildBundle(ctx, {
    ...(options.layer !== undefined && { layer: options.layer }),
    os,
    fromRegistry: options.fromRegistry === true,
  });
  const { report, bundle } = result;
  const refused = report.entries.filter((e) => e.outcome === "refused");
  if (bundle === undefined) {
    if (options.json) {
      io.stdout.write(`${JSON.stringify({ report, out: null }, null, 2)}\n`);
    } else {
      for (const e of refused) {
        io.stderr.write(
          `refused: ${e.path} (${e.layer}) ${e.code ?? ""}: ${e.reason}\n`,
        );
      }
      io.stderr.write(`error: ${refused.length} refused; no bundle written\n`);
    }
    return 1;
  }
  const out = resolve(io.cwd, options.out ?? "zzpersona-managed");
  await writeBundle(out, bundle.files);
  if (options.json) {
    io.stdout.write(`${JSON.stringify({ out, report }, null, 2)}\n`);
    return 0;
  }
  for (const e of report.entries) {
    io.stdout.write(`${e.outcome}: ${e.path} (${e.layer}) ${e.reason}\n`);
  }
  for (const w of report.warnings) {
    io.stderr.write(`warning: ${w.code}: ${w.message}\n`);
  }
  io.stdout.write(`bundle: ${out}\n`);
  return 0;
}
