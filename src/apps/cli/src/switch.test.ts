import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectKey, readState } from "./state.js";
import { seed, zz, type Seeded } from "./test/seed.js";

let s: Seeded;
beforeEach(() => {
  s = seed();
});
afterEach(() => s.cleanup());

const json = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>;

describe("donn switch", () => {
  it("switches this project and resolve follows it", async () => {
    const r = await zz(["switch", "team/payments"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(r.code, r.stderr).toBe(0);
    // The first line; the per-harness report follows (switch-report.test.ts).
    expect(r.stdout.split("\n")[0]).toBe(
      `team/payments is now used for ${s.repo}`,
    );
    const key = await projectKey(join(s.repo, ".donn"));
    expect((await readState(s.home)).projects[key]).toBe("team/payments");
    const resolved = await zz(["resolve", "--json"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(json(resolved.stdout).ir).toMatchObject({
      metadata: { name: "payments-platform" },
    });
  });

  it("uses the same project from a subdirectory", async () => {
    const deep = join(s.repo, "src/deep");
    mkdirSync(deep, { recursive: true });
    await zz(["switch", "team/payments"], { cwd: deep, home: s.home });
    const key = await projectKey(join(s.repo, ".donn"));
    const state = await readState(s.home);
    expect(state.projects).toEqual({ [key]: "team/payments" });
    expect(state.default).toBeUndefined();
  });

  it("sets the default outside a project, or with --default", async () => {
    await zz(["switch", "team/payments"], { cwd: s.root, home: s.home });
    expect((await readState(s.home)).default).toBe("team/payments");
    const r = await zz(["switch", "org/base", "--default", "--json"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(json(r.stdout)).toMatchObject({
      scope: "default",
      persona: "org/base",
    });
    expect((await readState(s.home)).default).toBe("org/base");
  });

  it("refuses a persona that does not resolve, leaving state alone", async () => {
    const r = await zz(["switch", "team/nope"], { cwd: s.repo, home: s.home });
    expect(r.code).toBe(1);
    expect(() => readFileSync(join(s.home, "state.json"))).toThrow();
  });

  it("clears a switch, and says so when there is nothing to clear", async () => {
    await zz(["switch", "team/payments"], { cwd: s.repo, home: s.home });
    const cleared = await zz(["switch", "--clear"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(cleared.stdout.split("\n")[0]).toBe(
      `cleared the switch for ${s.repo}`,
    );
    expect((await readState(s.home)).projects).toEqual({});
    const again = await zz(["switch", "--clear"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(again.code).toBe(0);
    expect(again.stdout).toBe("nothing to clear\n");
  });

  it("shows the persona in use and why", async () => {
    const shown = await zz(["switch"], { cwd: s.repo, home: s.home });
    expect(shown.stdout).toBe(
      `project/persona (project persona for ${s.repo})\n`,
    );
    await zz(["switch", "team/payments"], { cwd: s.repo, home: s.home });
    const key = await projectKey(join(s.repo, ".donn"));
    const r = await zz(["switch", "--json"], { cwd: s.repo, home: s.home });
    expect(json(r.stdout)).toEqual({
      persona: "team/payments",
      source: "switch",
      project: key,
    });
  });
});

describe("switch edge cases (spec 08)", () => {
  it("refuses the project persona as the default", async () => {
    const r = await zz(["switch", "--default", "project/persona", "--json"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(r.code).toBe(1);
    expect(json(r.stdout).error).toMatchObject({ code: "invalid-default" });
  });

  it("shows the default with --default, even inside a switched project", async () => {
    const at = { cwd: s.repo, home: s.home };
    await zz(["switch", "--default", "team/payments"], at);
    await zz(["switch", "org/base"], at);
    const r = await zz(["switch", "--default", "--json"], at);
    expect(json(r.stdout)).toMatchObject({
      persona: "team/payments",
      source: "default",
    });
  });

  it("refuses a persona together with --clear", async () => {
    const r = await zz(["switch", "--clear", "team/payments", "--json"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(r.code).toBe(1);
    expect(json(r.stdout).error).toMatchObject({ code: "usage" });
  });

  it("reports a home it cannot write as a filesystem error", async () => {
    mkdirSync(s.home, { recursive: true });
    chmodSync(s.home, 0o500);
    try {
      const r = await zz(["switch", "team/payments", "--json"], {
        cwd: s.root,
        home: s.home,
      });
      expect(r.code).toBe(1);
      expect(json(r.stdout).error).toMatchObject({ code: "filesystem" });
    } finally {
      chmodSync(s.home, 0o700);
    }
  });
});
