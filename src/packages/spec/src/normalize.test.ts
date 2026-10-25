import { builtinModules } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeRelative } from "./common.js";

describe("normalizeRelative", () => {
  it.each([
    ["agents/./pr", "agents/pr"],
    ["a/../..", ".."],
    ["./x", "x"],
    ["/abs", "/abs"],
    ["/../abs", "/abs"],
    ["agents/pr/", "agents/pr"],
    ["../../x", "../../x"],
    ["a/..", "."],
  ])("%s -> %s", (input, output) => {
    expect(normalizeRelative(input)).toBe(output);
  });
});

describe("@getdonn/spec", () => {
  it("imports no Node built-ins (it is bundled for browsers)", () => {
    const dir = new URL(".", import.meta.url);
    const sources = readdirSync(dir).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const name of sources) {
      const text = readFileSync(new URL(name, dir), "utf8");
      expect(text, name).not.toMatch(/from\s+["']node:/);
      for (const mod of builtinModules) {
        expect(text, `${name} imports ${mod}`).not.toMatch(
          new RegExp(`from\\s+["']${mod}["']`),
        );
      }
    }
  });
});
