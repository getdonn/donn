import { existsSync } from "node:fs";
import { LAYERS } from "@getdonn/spec";
import type { CliIo } from "../cli.js";
import { createContext } from "../context.js";
import { builtFrom } from "../registry.js";

// donn list: every available persona with its layer. See docs/planning/09-mod-claude-code.md §3.

export interface ListOptions {
  json?: boolean;
}

export async function listCommand(
  io: CliIo,
  options: ListOptions,
): Promise<number> {
  const ctx = await createContext(io);
  const refs = (await ctx.store.list()).sort();
  const cached = builtFrom(ctx.store, refs);
  // A layer that resolves from the registry cache has no file to edit: its source is published.
  // A local one's file is where the store mounts it, for "open in editor".
  const personas = refs.map((ref) => {
    const layer = ref.split("/")[0]!;
    if (cached[ref] !== undefined) {
      return { ref, layer, source: "registry" as const };
    }
    const path = ctx.store.locate(`${ref}.yaml`)?.path;
    return { ref, layer, source: "local" as const, ...(path && { path }) };
  });
  // The user overlay is no persona to pick, but it is a layer of every resolve that uses it.
  const overlayPath = ctx.store.locate("user/overrides.yaml")?.path;
  const overlay =
    overlayPath !== undefined && existsSync(overlayPath)
      ? { ref: "user/overrides", path: overlayPath }
      : undefined;
  if (options.json) {
    io.stdout.write(
      `${JSON.stringify({ personas, ...(overlay && { overlay }) }, null, 2)}\n`,
    );
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
