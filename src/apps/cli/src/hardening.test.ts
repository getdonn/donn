import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivationPlan } from "@zzpersona/adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seed, zz, type Seeded } from "./test/seed.js";

let s: Seeded;
beforeEach(() => {
  s = seed();
});
afterEach(() => s.cleanup());

describe("runtime hardening (spec 07)", () => {
  it("shows no managed-settings hint when claude ended by a signal", async () => {
    const base = join(s.personas, "org/base.yaml");
    writeFileSync(
      base,
      readFileSync(base, "utf8").replace(
        "vault: { type: hashicorp-vault, address: https://vault.corp }",
        "vault: { type: env }",
      ),
    );
    let launched = false;
    const times = [0, 1000];
    const r = await zz(["claude", "--no-overlay"], {
      cwd: s.repo,
      home: s.home,
      env: { "payments/schema-token": "v" },
      runPlan: async (_plan: ActivationPlan) => {
        launched = true;
        return 130;
      },
      now: () => times.shift() ?? 0,
    });
    expect(launched, r.stderr).toBe(true);
    expect(r.stderr).not.toContain("managed settings");
  });

  it("reports commander usage errors as a --json envelope", async () => {
    const r = await zz(["claude", "--mode", "bogus", "--json"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("usage");
    expect(r.stderr).toBe("");
  });

  it("rejects passthrough on commands other than claude", async () => {
    for (const argv of [
      ["resolve", "--json", "--", "team/payments"],
      ["compile", "--json", "--", "x"],
    ]) {
      const r = await zz(argv, { cwd: s.repo, home: s.home });
      expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout).error.code).toBe("unexpected-passthrough");
    }
  });

  it("treats an empty ZZPERSONA_HOME as unset", async () => {
    symlinkSync(s.home, join(s.root, ".zzpersona"));
    const r = await zz(["resolve"], {
      cwd: s.repo,
      env: { ZZPERSONA_HOME: "", HOME: s.root },
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("checkout-api (project/persona)");
  });
});
