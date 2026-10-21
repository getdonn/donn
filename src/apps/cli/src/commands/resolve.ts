import { explain } from "@zzpersona/resolver";
import type { CliIo } from "../cli.js";
import { createContext, printWarnings, resolvePersona } from "../context.js";
import { selectPersona } from "../select.js";

export interface ResolveOptions {
  explain?: boolean;
  json?: boolean;
  overlay: boolean;
}

export async function resolveCommand(
  io: CliIo,
  persona: string | undefined,
  options: ResolveOptions,
): Promise<number> {
  const ctx = await createContext(io);
  const selection = await selectPersona(persona, ctx);
  const result = await resolvePersona(ctx, selection, options.overlay);
  printWarnings(io, result);
  if (options.json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (options.explain) {
    io.stdout.write(explain(result));
  } else {
    io.stdout.write(
      [
        `${result.ir.metadata.name} (${selection.ref})`,
        `layers: ${result.ir.layers.join(" → ")}`,
        `warnings: ${result.warnings.length}`,
        "",
      ].join("\n"),
    );
  }
  return 0;
}
