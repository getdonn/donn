import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seed, zz, type Seeded } from "./test/seed.js";

let s: Seeded;
beforeEach(() => {
  s = seed();
});
afterEach(() => s.cleanup());

describe("donn list", () => {
  it("lists every persona with its layer", async () => {
    const r = await zz(["list", "--json"], { cwd: s.repo, home: s.home });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      personas: [
        {
          ref: "area/fintech",
          layer: "area",
          path: join(s.personas, "area/fintech.yaml"),
        },
        {
          ref: "org/base",
          layer: "org",
          path: join(s.personas, "org/base.yaml"),
        },
        {
          ref: "project/persona",
          layer: "project",
          path: join(s.repo, ".donn/persona.yaml"),
        },
        {
          ref: "team/payments",
          layer: "team",
          path: join(s.personas, "team/payments.yaml"),
        },
      ],
      // The user overlay is not a persona to pick, but it is a layer with a file.
      overlay: { ref: "user/overrides", path: join(s.home, "overrides.yaml") },
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
