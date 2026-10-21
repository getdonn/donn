import { LAYERS } from "@zzpersona/spec";
import type { CliIo } from "../cli.js";
import { createContext } from "../context.js";

// zzpersona list: every available persona with its layer. See docs/planning/09-mod-claude-code.md §3.

export interface ListOptions {
  json?: boolean;
}

export async function listCommand(
  io: CliIo,
  options: ListOptions,
): Promise<number> {
  const ctx = await createContext(io);
  const personas = (await ctx.store.list())
    .sort()
    .map((ref) => ({ ref, layer: ref.split("/")[0]! }));
  if (options.json) {
    io.stdout.write(`${JSON.stringify({ personas }, null, 2)}\n`);
    return 0;
  }
  const lines = LAYERS.flatMap((layer) => {
    const refs = personas.filter((p) => p.layer === layer);
    return refs.length === 0
      ? []
      : [`${layer}:`, ...refs.map((p) => `  ${p.ref}`)];
  });
  io.stdout.write(
    lines.length === 0 ? "no personas found\n" : `${lines.join("\n")}\n`,
  );
  return 0;
}
