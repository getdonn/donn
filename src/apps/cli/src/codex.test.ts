import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivationPlan, Probe } from "@getdonn/adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installedProbe, seed, zz, type Seeded } from "./test/seed.js";

let s: Seeded;
beforeEach(() => {
  s = seed();
});
afterEach(() => s.cleanup());

/** Switch fixture 002's vault provider to the env backend so its one secret can resolve. */
function useEnvVault() {
  const file = join(s.personas, "org/base.yaml");
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      "vault: { type: hashicorp-vault, address: https://vault.corp }",
      "vault: { type: env }",
    ),
  );
}
const SECRET_ENV = { "payments/schema-token": "tok-value" };

function recorder() {
  const calls: { plan: ActivationPlan; secretEnv: Record<string, string> }[] =
    [];
  const runPlan = async (
    plan: ActivationPlan,
    options: { secretEnv: Record<string, string> },
  ) => {
    calls.push({ plan, secretEnv: options.secretEnv });
    return 0;
  };
  return { calls, runPlan };
}

const launchStep = (plan: ActivationPlan) => {
  const step = plan.steps[0];
  if (step?.kind !== "launch") throw new Error("expected a launch step");
  return step;
};

describe("donn codex", () => {
  it("launches codex with the sandbox defaults and secrets in the environment", async () => {
    useEnvVault();
    const { calls, runPlan } = recorder();
    const r = await zz(["codex"], {
      cwd: s.repo,
      home: s.home,
      env: SECRET_ENV,
      runPlan,
    });
    expect(r.code, r.stderr).toBe(0);
    const step = launchStep(calls[0]!.plan);
    expect(step.command).toBe("codex");
    expect(step.args.slice(0, 4)).toEqual([
      "-s",
      "workspace-write",
      "-a",
      "on-request",
    ]);
    expect(calls[0]!.secretEnv).toEqual({ SCHEMA_TOKEN: "tok-value" });
    expect(step.args.join(" ")).not.toContain("tok-value");
    expect(step.args.join(" ")).toContain('env_vars = ["SCHEMA_TOKEN"]');
    expect(step.env.DONN_PERSONA).toBe("project/persona");
  });

  it("registers a session while codex runs and removes it after", async () => {
    useEnvVault();
    const dir = join(s.home, "sessions");
    let during: { name: string; launched: Record<string, unknown> }[] = [];
    const r = await zz(["codex"], {
      cwd: s.repo,
      home: s.home,
      env: SECRET_ENV,
      runPlan: async () => {
        during = readdirSync(dir).map((name) => ({
          name,
          launched: JSON.parse(
            readFileSync(join(dir, name, "launched.json"), "utf8"),
          ),
        }));
        return 0;
      },
    });
    expect(r.code, r.stderr).toBe(0);
    expect(during).toHaveLength(1);
    expect(during[0]!.launched).toMatchObject({
      persona: "project/persona",
      harness: "codex",
      project: s.repo,
      pid: process.pid,
      buildHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(existsSync(join(dir, during[0]!.name))).toBe(false);
  });

  it("passes passthrough arguments last", async () => {
    useEnvVault();
    const { calls, runPlan } = recorder();
    await zz(["codex", "--", "--help"], {
      cwd: s.repo,
      home: s.home,
      env: SECRET_ENV,
      runPlan,
    });
    expect(launchStep(calls[0]!.plan).args.at(-1)).toBe("--help");
  });

  it("prints the plan with --dry-run and launches nothing", async () => {
    const { calls, runPlan } = recorder();
    const r = await zz(["codex", "--dry-run"], {
      cwd: s.repo,
      home: s.home,
      runPlan,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("launch codex -s workspace-write");
    expect(calls).toHaveLength(0);
  });

  it("prints the plan as JSON with --json", async () => {
    const r = await zz(["codex", "--json"], { cwd: s.repo, home: s.home });
    expect(r.code, r.stderr).toBe(0);
    const json = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual([
      "buildDir",
      "plan",
      "report",
      "secretRefs",
    ]);
    expect(json.secretRefs).toEqual(["secret://vault/payments/schema-token"]);
  });

  it("fails with codex-not-installed when codex is missing", async () => {
    useEnvVault();
    const missing: Probe = {
      ...installedProbe,
      run: async () => ({ exitCode: 127, stdout: "", stderr: "" }),
    };
    const { calls, runPlan } = recorder();
    const r = await zz(["codex", "--json"], {
      cwd: s.repo,
      home: s.home,
      env: SECRET_ENV,
      probe: missing,
      runPlan,
    });
    expect(r.code).toBe(0); // --json plans without launching
    const launch = await zz(["codex"], {
      cwd: s.repo,
      home: s.home,
      env: SECRET_ENV,
      probe: missing,
      runPlan,
    });
    expect(launch.code).toBe(1);
    expect(launch.stderr).toContain("codex is not installed");
    expect(calls).toHaveLength(0);
  });

  it("compiles for codex with compile --harness codex", async () => {
    const r = await zz(["compile", "--harness", "codex", "--dry-run"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("instructions.md");
  });
});
