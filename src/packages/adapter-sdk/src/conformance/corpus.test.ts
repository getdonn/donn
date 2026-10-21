import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_EVENTS, ResolvedPersona } from "@zzpersona/spec";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { corpus } from "./index.js";

const fixture002 = join(
  import.meta.dirname,
  "../../../resolver/fixtures/002-full-stack/case.yaml",
);

describe("conformance corpus", () => {
  it("has the three entries", () => {
    expect(corpus.map((entry) => entry.name)).toEqual([
      "minimal",
      "full",
      "kitchen-sink",
    ]);
  });

  it.each(corpus)("$name is a valid resolved persona", ({ ir }) => {
    expect(ResolvedPersona.safeParse(ir).error).toBeUndefined();
  });

  it.each(corpus)(
    "$name supplies text for every instruction file",
    ({ ir, texts }) => {
      for (const fragment of ir.instructions) {
        if ("file" in fragment) expect(texts).toHaveProperty([fragment.file]);
      }
    },
  );

  it("full matches resolver fixture 002 (run `pnpm corpus:update` after a fixture change)", () => {
    const expected = parse(readFileSync(fixture002, "utf8")).expect.resolved;
    expect(corpus.find((entry) => entry.name === "full")!.ir).toEqual(expected);
  });

  it("kitchen-sink has a hook for every event and every MCP server form", () => {
    const { ir } = corpus.find((entry) => entry.name === "kitchen-sink")!;
    expect(Object.keys(ir.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    const servers = Object.values(ir.mcp.servers);
    expect(servers.some((s) => "ref" in s)).toBe(true);
    expect(servers.some((s) => "command" in s)).toBe(true);
    expect(servers.some((s) => "url" in s)).toBe(true);
  });
});
