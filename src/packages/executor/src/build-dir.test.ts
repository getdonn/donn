import { describe, expect, it } from "vitest";
import { buildDirFor } from "./index.js";

describe("buildDirFor", () => {
  it("separates two projects that share the project/persona ref", () => {
    const a = buildDirFor(
      "project/persona",
      "/a/.zzpersona",
      "claude-code",
      "/h",
    );
    const b = buildDirFor(
      "project/persona",
      "/b/.zzpersona",
      "claude-code",
      "/h",
    );
    expect(a).not.toBe(b);
    for (const dir of [a, b]) {
      expect(dir).toMatch(
        /^\/h\/build\/project-persona-[0-9a-f]{8}\/claude-code$/,
      );
    }
  });

  it("is deterministic", () => {
    expect(buildDirFor("team/payments", undefined, "claude-code", "/h")).toBe(
      buildDirFor("team/payments", undefined, "claude-code", "/h"),
    );
  });
});
