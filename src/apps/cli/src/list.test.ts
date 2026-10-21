import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seed, zz, type Seeded } from "./test/seed.js";

let s: Seeded;
beforeEach(() => {
  s = seed();
});
afterEach(() => s.cleanup());

describe("zzpersona list", () => {
  it("lists every persona with its layer", async () => {
    const r = await zz(["list", "--json"], { cwd: s.repo, home: s.home });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      personas: [
        { ref: "area/fintech", layer: "area" },
        { ref: "org/base", layer: "org" },
        { ref: "project/persona", layer: "project" },
        { ref: "team/payments", layer: "team" },
      ],
    });
  });

  it("groups personas by layer in text", async () => {
    const r = await zz(["list"], { cwd: s.repo, home: s.home });
    expect(r.stdout).toBe(
      [
        "org:",
        "  org/base",
        "area:",
        "  area/fintech",
        "team:",
        "  team/payments",
        "project:",
        "  project/persona",
        "",
      ].join("\n"),
    );
  });
});
