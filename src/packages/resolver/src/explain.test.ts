import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ref, ResolveResult } from "@zzpersona/spec";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { explain, resolve } from "./index.js";

// Targeted behaviors a reviewer relies on. The full rendering of every fixture is pinned by the
// explain.txt golden files checked in fixtures.test.ts.

const root = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "002-full-stack",
  "personas",
);
const load = async (ref: Ref) => {
  const path = join(root, `${ref}.yaml`);
  return existsSync(path) ? parse(readFileSync(path, "utf8")) : undefined;
};

let result: ResolveResult;
let lines: string[];
const line = (...parts: string[]) =>
  lines.find((l) => parts.every((part) => l.includes(part)));

beforeAll(async () => {
  result = await resolve("project/checkout-api", {
    source: { load },
    overlay: "user/overrides",
  });
  lines = explain(result).split("\n");
});

describe("explain", () => {
  it("opens with the target's name, version and description", () => {
    expect(lines[0]).toBe("checkout-api v1 — Checkout API service repo");
  });

  it("lists layers in merge order, marking the target and the overlay", () => {
    expect(line("1", "org/base")).toBeDefined();
    expect(line("4", "project/checkout-api", "target")).toBeDefined();
    expect(line("5", "user/overrides", "overlay")).toBeDefined();
  });

  it("puts the setting layer on every value's line", () => {
    expect(line("checkout-overview", "project/checkout-api")).toBeDefined();
    expect(line("coding-standards", "team/payments")).toBeDefined();
    expect(line("model", "opus", "user/overrides")).toBeDefined();
  });

  it("marks values covered by a lock with the lock and its layer", () => {
    expect(
      line(
        "Bash(curl:*)",
        "area/fintech",
        "locked: permissions.deny by org/base",
      ),
    ).toBeDefined();
    expect(
      line("gateway", "bifrost://corp", "locked: mcp.gateway by org/base"),
    ).toBeDefined();
    expect(line("Bash(git push:*)", "locked")).toBeUndefined();
  });

  it("shows which env vars a server uses without implying values", () => {
    expect(line("payments-schema", "env: SCHEMA_TOKEN")).toBeDefined();
  });

  it("ends with warnings naming the layer they came from", () => {
    const at = lines.indexOf("warnings (1)");
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toMatch(
      /allow-shadowed-by-ask\s+permissions\.allow\[Bash\(pnpm test:\*\)\]\s+from team\/payments/,
    );
  });

  it("omits empty sections", () => {
    expect(lines).not.toContain("knowledge");
    expect(lines).toContain("knowledge (3)");
    const solo = explain({
      ...result,
      ir: { ...result.ir, knowledge: [] },
    });
    expect(solo).not.toMatch(/^knowledge/m);
  });

  it("truncates long values so the layer column stays aligned", () => {
    const long = line("checkout-context")!;
    expect(long).toContain("…");
    expect(long.indexOf("project/checkout-api")).toBe(
      line("checkout-overview")!.indexOf("project/checkout-api"),
    );
  });

  it("notes which layer a value overrode", () => {
    expect(
      line("pr-review", "team/payments", "overrides org/base"),
    ).toBeDefined();
    expect(
      line("model", "opus", "user/overrides", "overrides team/payments"),
    ).toBeDefined();
    expect(line("jira", "overrides")).toBeUndefined();
  });

  it("lists removed values with who removed them and who had set them", () => {
    const at = lines.indexOf("removed (3)");
    expect(at).toBeGreaterThan(0);
    const removed = lines.slice(at + 1, at + 4).join("\n");
    expect(removed).toMatch(
      /skills\[frontend-storybook\]\s+removed by team\/payments\s+set by org\/base/,
    );
    expect(removed).toMatch(
      /mcp\.servers\.figma\s+removed by team\/payments\s+set by org\/base/,
    );
    expect(removed).toMatch(
      /instructions\[payments-overview\]\s+removed by project\/checkout-api\s+set by team\/payments; replaced by instructions\[checkout-overview\]/,
    );
  });

  it("notes which fragment a replace(<id>) under a new id swapped out", () => {
    expect(
      line(
        "checkout-overview",
        "project/checkout-api",
        "replaces instructions[payments-overview] from team/payments",
      ),
    ).toBeDefined();
  });
});
