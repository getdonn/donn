import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seed, zz, type Seeded } from "./test/seed.js";

let s: Seeded;
beforeEach(() => {
  s = seed();
});
afterEach(() => s.cleanup());

const buildDirOf = (stdout: string) => /^build: (.+)$/m.exec(stdout)?.[1];

describe("donn compile", () => {
  it("writes the Claude Code build for the project persona", async () => {
    const r = await zz(["compile"], { cwd: s.repo, home: s.home });
    expect(r.code, r.stderr).toBe(0);
    const dir = buildDirOf(r.stdout)!;
    expect(dir).toMatch(
      new RegExp(
        `^${join(s.home, "build")}/project-persona-[0-9a-f]{8}/claude-code$`,
      ),
    );
    expect(existsSync(join(dir, "settings.json"))).toBe(true);
    expect(readFileSync(join(dir, "system-prompt.md"), "utf8")).toContain(
      "Checkout overview text.",
    );
    expect(
      existsSync(join(dir, "plugin/skills/run-payment-sim/SKILL.md")),
    ).toBe(true);
    expect(r.stderr).toContain(
      "dropped: skills[pr-review] — skill registries are not supported in v0",
    );
  });

  it("writes nothing with --dry-run", async () => {
    const r = await zz(["compile", "--dry-run"], { cwd: s.repo, home: s.home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("mode: relaunch");
    expect(existsSync(join(s.home, "build"))).toBe(false);
  });

  it("reports the build, the secret refs it needs, and the plan as JSON", async () => {
    const r = await zz(["compile", "--json"], { cwd: s.repo, home: s.home });
    const json = JSON.parse(r.stdout);
    expect(json.secretRefs).toEqual(["secret://vault/payments/schema-token"]);
    expect(json.buildDir).toBe(buildDirOf(`build: ${json.buildDir}`));
    expect(json.report.mode).toBe("relaunch");
    expect(json.plan.steps[0].command).toBe("claude");
    expect(readdirSync(join(s.home, "build"))).toHaveLength(1);
  });

  it("rejects an unknown harness", async () => {
    const r = await zz(["compile", "--harness", "no-such-harness", "--json"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("unknown-harness");
  });

  it("names a missing instruction file by its virtual and physical path", async () => {
    const file = join(s.repo, ".donn/instructions/checkout-overview.md");
    rmSync(file);
    const r = await zz(["compile"], { cwd: s.repo, home: s.home });
    expect(r.code).toBe(1);
    const errors = r.stderr
      .split("\n")
      .filter((line) => line.startsWith("error:"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("project/instructions/checkout-overview.md");
    expect(errors[0]).toContain(file);
  });
});

describe("review fixes", () => {
  it("reports a skill path outside the personas root as one error, no stack trace (I1)", async () => {
    const team = join(s.personas, "team/payments.yaml");
    writeFileSync(
      team,
      readFileSync(team, "utf8").replace(
        "- ./skills/run-payment-sim",
        "- ./skills/run-payment-sim\n    - ../../../outside",
      ),
    );
    const r = await zz(["compile"], { cwd: s.repo, home: s.home });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(
      /^error: skill outside: .* is outside the personas root$/m,
    );
    expect(r.stderr).not.toContain("    at ");
  });
});
