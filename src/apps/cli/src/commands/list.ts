import { existsSync } from "node:fs";
import { LAYERS } from "@getdonn/spec";
import type { CliIo } from "../cli.js";
import { createContext } from "../context.js";

// donn list: every available persona with its layer. See docs/planning/09-mod-claude-code.md §3.

export interface ListOptions {
  json?: boolean;
}

export async function listCommand(
  io: CliIo,
  options: ListOptions,
): Promise<number> {
  const ctx = await createContext(io);
  // Where each persona's file is (a registry layer's is its cache file), for "open in editor".
  const personas = (await ctx.store.list()).sort().flatMap((ref) => {
    const path = ctx.store.locate(`${ref}.yaml`)?.path;
    return path === undefined ? [] : [{ ref, layer: ref.split("/")[0]!, path }];
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
