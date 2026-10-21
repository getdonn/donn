import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explain } from "@zzpersona/resolver";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seed, zz, type Seeded } from "./test/seed.js";

let s: Seeded;
beforeEach(() => {
  s = seed();
});
afterEach(() => s.cleanup());

describe("zzpersona resolve", () => {
  it("resolves the project persona in a repo", async () => {
    const r = await zz(["resolve"], { cwd: s.repo, home: s.home });
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n").slice(0, 3)).toEqual([
      "checkout-api (project/persona)",
      "layers: org/base → area/fintech → team/payments → project/persona → user/overrides",
      "warnings: 1",
    ]);
    expect(r.stderr).toContain(
      "warning: allow-shadowed-by-ask permissions.allow[Bash(pnpm test:*)] (from team/payments)",
    );
  });

  it("skips the overlay with --no-overlay", async () => {
    const r = await zz(["resolve", "--no-overlay"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(r.stdout).toContain(
      "layers: org/base → area/fintech → team/payments → project/persona\n",
    );
  });

  it("resolves a full ref as JSON", async () => {
    const r = await zz(["resolve", "team/payments", "--json"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).ir.metadata.name).toBe("payments-platform");
  });

  it("resolves a unique bare name and rejects an ambiguous one", async () => {
    const byName = await zz(["resolve", "payments", "--json"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(JSON.parse(byName.stdout).ir.metadata.name).toBe(
      "payments-platform",
    );

    mkdirSync(join(s.personas, "team/x"), { recursive: true });
    writeFileSync(
      join(s.personas, "team/x/base.yaml"),
      "apiVersion: zzpersona/v0\nkind: Persona\nmetadata:\n  name: x-base\n",
    );
    const r = await zz(["resolve", "base", "--json"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatchObject({
      code: "ambiguous-persona",
      candidates: ["org/base", "team/x/base"],
    });
  });

  it("asks for a persona outside a project, listing what exists", async () => {
    const r = await zz(["resolve"], { cwd: s.root, home: s.home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("error:");
    for (const ref of ["org/base", "area/fintech", "team/payments"]) {
      expect(r.stderr).toContain(ref);
    }
    const json = await zz(["resolve", "--json"], { cwd: s.root, home: s.home });
    expect(JSON.parse(json.stdout).error.code).toBe("no-persona");
  });

  it("prints explain() with --explain", async () => {
    const r = await zz(["resolve", "--explain"], { cwd: s.repo, home: s.home });
    const json = await zz(["resolve", "--json"], { cwd: s.repo, home: s.home });
    expect(r.stdout).toBe(explain(JSON.parse(json.stdout)));
  });

  it("warns about project/ or user/ folders inside the personas folder", async () => {
    mkdirSync(join(s.personas, "user"));
    const r = await zz(["resolve"], { cwd: s.repo, home: s.home });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(
      `warning: ${join(s.personas, "user")} is ignored: project/ and user/ layers are mounted elsewhere`,
    );
  });

  it("expands ~ in the configured personas path", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "zzp-homedir-"));
    try {
      writeFileSync(join(s.home, "config.yaml"), "personas: ~/p\n");
      const r = await zz(["resolve", "team/x"], {
        cwd: s.root,
        home: s.home,
        env: { HOME: fakeHome },
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(join(fakeHome, "p"));
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("reports resolver errors as a JSON envelope", async () => {
    const r = await zz(["resolve", "team/nope", "--json"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatchObject({
      code: "missing-ref",
      ref: "team/nope",
    });
  });
});
