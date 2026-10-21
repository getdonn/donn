import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { seed, zz, type Seeded } from "./test/seed.js";

let s: Seeded;
let home: string;
beforeEach(() => {
  s = seed();
  home = join(s.root, "fresh-home");
});
afterEach(() => s.cleanup());

const config = () => parse(readFileSync(join(home, "config.yaml"), "utf8"));

describe("zzpersona init --personas", () => {
  it("writes config and a starter persona into an empty folder", async () => {
    const dir = join(s.root, "mine");
    const r = await zz(["init", "--personas", dir, "--json"], {
      cwd: s.root,
      home,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      created: [join(home, "config.yaml"), join(dir, "org/base.yaml")],
      updated: [],
    });
    expect(config()).toEqual({ personas: dir });
    const starter = parse(readFileSync(join(dir, "org/base.yaml"), "utf8"));
    expect(starter).toMatchObject({
      kind: "Persona",
      metadata: { name: "base" },
      permissions: { deny: ["Bash(rm -rf:*)"] },
    });
    const resolved = await zz(["resolve", "org/base"], { cwd: s.root, home });
    expect(resolved.code, resolved.stderr).toBe(0);
  });

  it("stores a relative path as absolute", async () => {
    await zz(["init", "--personas", "./p"], { cwd: s.root, home });
    expect(config()).toEqual({ personas: join(s.root, "p") });
  });

  it("refuses to repoint an existing config without --force", async () => {
    await zz(["init", "--personas", join(s.root, "a")], { cwd: s.root, home });
    const r = await zz(["init", "--personas", join(s.root, "b"), "--json"], {
      cwd: s.root,
      home,
    });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatchObject({
      code: "config-exists",
      current: join(s.root, "a"),
    });
    const forced = await zz(
      ["init", "--personas", join(s.root, "b"), "--force", "--json"],
      { cwd: s.root, home },
    );
    expect(JSON.parse(forced.stdout).updated).toEqual([
      join(home, "config.yaml"),
    ]);
    expect(config()).toEqual({ personas: join(s.root, "b") });
  });

  it("writes no starter into a folder that already has personas", async () => {
    const r = await zz(["init", "--personas", s.personas, "--json"], {
      cwd: s.root,
      home,
    });
    expect(JSON.parse(r.stdout).created).toEqual([join(home, "config.yaml")]);
  });
});

describe("zzpersona init --extends", () => {
  it("writes a project persona extending the full ref", async () => {
    const repo = join(s.root, "checkout");
    mkdirSync(repo);
    const r = await zz(["init", "--extends", "payments"], {
      cwd: repo,
      home: s.home,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(
      parse(readFileSync(join(repo, ".zzpersona/persona.yaml"), "utf8")),
    ).toEqual({
      apiVersion: "zzpersona/v0",
      kind: "Persona",
      metadata: { name: "checkout" },
      extends: ["team/payments"],
    });
  });

  it("refuses an existing persona.yaml without --force", async () => {
    const r = await zz(["init", "--extends", "team/payments", "--json"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(JSON.parse(r.stdout).error.code).toBe("persona-exists");
    const forced = await zz(["init", "--extends", "team/payments", "--force"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(forced.code).toBe(0);
  });

  it("writes nothing when the persona does not exist", async () => {
    const repo = join(s.root, "x");
    mkdirSync(repo);
    const r = await zz(["init", "--extends", "team/nope"], {
      cwd: repo,
      home: s.home,
    });
    expect(r.code).toBe(1);
    expect(existsSync(join(repo, ".zzpersona"))).toBe(false);
  });

  it("nests a project inside another, and the nested one wins there", async () => {
    const sub = join(s.repo, "sub");
    mkdirSync(sub);
    await zz(["init", "--extends", "org/base"], { cwd: sub, home: s.home });
    const r = await zz(["resolve", "--json", "--no-overlay"], {
      cwd: sub,
      home: s.home,
    });
    expect(JSON.parse(r.stdout).ir.layers).toEqual([
      "org/base",
      "project/persona",
    ]);
  });
});

describe("zzpersona init", () => {
  it("does both in one call", async () => {
    const dir = join(s.root, "both");
    const repo = join(s.root, "repo2");
    mkdirSync(repo);
    const r = await zz(["init", "--personas", dir, "--extends", "org/base"], {
      cwd: repo,
      home,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(repo, ".zzpersona/persona.yaml"))).toBe(true);
  });

  it("explains itself with no flags", async () => {
    const r = await zz(["init", "--json"], { cwd: s.root, home });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("init-needs-flags");
  });
});
