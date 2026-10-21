import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivationPlan, Probe } from "@zzpersona/adapter-sdk";
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

function recorder(exitCode = 0) {
  const calls: { plan: ActivationPlan; secretEnv: Record<string, string> }[] =
    [];
  const runPlan = async (
    plan: ActivationPlan,
    options: { secretEnv: Record<string, string> },
  ) => {
    calls.push({ plan, secretEnv: options.secretEnv });
    return exitCode;
  };
  return { calls, runPlan };
}

const launchArgs = (plan: ActivationPlan) => {
  const step = plan.steps[0];
  if (step?.kind !== "launch") throw new Error("expected a launch step");
  return step;
};

describe("zzpersona claude", () => {
  it("builds, resolves secrets and launches with passthrough args", async () => {
    useEnvVault();
    const { calls, runPlan } = recorder();
    const r = await zz(["claude", "--", "-p", "hi"], {
      cwd: s.repo,
      home: s.home,
      env: SECRET_ENV,
      runPlan,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    const step = launchArgs(calls[0]!.plan);
    expect(step.command).toBe("claude");
    expect(step.args.slice(-2)).toEqual(["-p", "hi"]);
    expect(step.args[0]).toBe("--plugin-dir");
    expect(calls[0]!.secretEnv).toEqual({ ZZP_SECRET_1: "tok-value" });
    // The session folder of plugins (spec 10); removed again once claude exits.
    expect(step.args[1]).toBe(join(step.env.ZZPERSONA_SESSION!, "plugins"));
  });

  it("forces partial mode with --mode", async () => {
    useEnvVault();
    const { calls, runPlan } = recorder();
    await zz(["claude", "--mode", "partial"], {
      cwd: s.repo,
      home: s.home,
      env: SECRET_ENV,
      runPlan,
    });
    expect(launchArgs(calls[0]!.plan).args[0]).toBe("--settings");
  });

  it("does not launch when a secret cannot be resolved", async () => {
    const { calls, runPlan } = recorder();
    const r = await zz(["claude"], { cwd: s.repo, home: s.home, runPlan });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("could not resolve 1 secret(s):");
    expect(calls).toHaveLength(0);
  });

  it("hints at --mode partial when claude fails right away", async () => {
    useEnvVault();
    const hint =
      "If Claude Code said flags are disabled by managed settings, retry with --mode partial.";
    const clock = (times: number[]) => () => times.shift() ?? 0;
    const quick = await zz(["claude"], {
      cwd: s.repo,
      home: s.home,
      env: SECRET_ENV,
      runPlan: recorder(1).runPlan,
      now: clock([0, 1000]),
    });
    expect(quick.code).toBe(1);
    expect(quick.stderr).toContain(hint);
    const slow = await zz(["claude"], {
      cwd: s.repo,
      home: s.home,
      env: SECRET_ENV,
      runPlan: recorder(1).runPlan,
      now: clock([0, 10_000]),
    });
    expect(slow.stderr).not.toContain(hint);
  });

  it("launches in the subdirectory it was run from", async () => {
    useEnvVault();
    const deep = join(s.repo, "src/deep");
    mkdirSync(deep, { recursive: true });
    const { calls, runPlan } = recorder();
    const r = await zz(["claude"], {
      cwd: deep,
      home: s.home,
      env: SECRET_ENV,
      runPlan,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(launchArgs(calls[0]!.plan).cwd).toBe(deep);
  });

  it("prints the plan as JSON and launches nothing with --json", async () => {
    const { calls, runPlan } = recorder();
    const r = await zz(["claude", "--json"], {
      cwd: s.repo,
      home: s.home,
      runPlan,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).plan.steps[0].command).toBe("claude");
    expect(calls).toHaveLength(0);
    expect(existsSync(join(s.home, "build"))).toBe(false);
  });

  it("prints the build with --dry-run and launches nothing", async () => {
    const { calls, runPlan } = recorder();
    const r = await zz(["claude", "--dry-run"], {
      cwd: s.repo,
      home: s.home,
      runPlan,
    });
    expect(r.stdout).toContain("plan (1)");
    expect(calls).toHaveLength(0);
  });

  it("reports when claude is not installed", async () => {
    const missing: Probe = {
      ...installedProbe,
      run: async () => ({ exitCode: 127, stdout: "", stderr: "" }),
    };
    const r = await zz(["claude", "--json"], {
      cwd: s.repo,
      home: s.home,
      probe: missing,
    });
    expect(r.code).toBe(0);
    const launched = await zz(["claude"], {
      cwd: s.repo,
      home: s.home,
      probe: missing,
      env: SECRET_ENV,
      runPlan: recorder().runPlan,
    });
    expect(launched.code).toBe(1);
    expect(launched.stderr).toContain("claude is not installed");
  });

  it("tells the session which persona it runs", async () => {
    useEnvVault();
    const { calls, runPlan } = recorder();
    const r = await zz(["claude"], {
      cwd: s.repo,
      home: s.home,
      env: SECRET_ENV,
      runPlan,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(launchArgs(calls[0]!.plan).env).toMatchObject({
      ZZPERSONA_PERSONA: "project/persona",
      ZZPERSONA_SOURCE: "project",
      ZZPERSONA_PROJECT: s.repo,
    });
    const json = await zz(["claude", "org/base", "--json"], {
      cwd: s.root,
      home: s.home,
    });
    const step = JSON.parse(json.stdout).plan.steps[0];
    expect(step.env).toMatchObject({
      ZZPERSONA_PERSONA: "org/base",
      ZZPERSONA_SOURCE: "argument",
    });
    expect(step.env).not.toHaveProperty("ZZPERSONA_PROJECT");
    const dry = await zz(["claude", "--dry-run"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(dry.stdout).toContain(
      "ZZPERSONA_PERSONA, ZZPERSONA_PROJECT, ZZPERSONA_SOURCE",
    );
  });

  it("launches with a session folder of plugins and removes it afterwards", async () => {
    useEnvVault();
    let seen:
      { pluginDir: string; session: string; existed: boolean } | undefined;
    const r = await zz(["claude"], {
      cwd: s.repo,
      home: s.home,
      env: SECRET_ENV,
      runPlan: async (plan: ActivationPlan) => {
        const step = launchArgs(plan);
        const pluginDir = step.args[step.args.indexOf("--plugin-dir") + 1]!;
        seen = {
          pluginDir,
          session: step.env.ZZPERSONA_SESSION!,
          existed: existsSync(
            join(pluginDir, "zzp-project--persona/.claude-plugin/plugin.json"),
          ),
        };
        return 0;
      },
    });
    expect(r.code, r.stderr).toBe(0);
    expect(seen!.pluginDir).toBe(join(seen!.session, "plugins"));
    expect(seen!.session.startsWith(join(s.home, "sessions"))).toBe(true);
    expect(seen!.existed).toBe(true);
    expect(existsSync(seen!.session)).toBe(false);
  });

  it("removes the session folder even when the launch fails", async () => {
    useEnvVault();
    for (const outcome of ["exit", "throw"] as const) {
      let session: string | undefined;
      await zz(["claude"], {
        cwd: s.repo,
        home: s.home,
        env: SECRET_ENV,
        runPlan: async (plan: ActivationPlan) => {
          session = launchArgs(plan).env.ZZPERSONA_SESSION!;
          if (outcome === "throw") throw new Error("spawn failed");
          return 1;
        },
      }).catch(() => undefined);
      expect(session, outcome).toMatch(/\/sessions\/[0-9a-f]{16}$/);
      expect(existsSync(session!), outcome).toBe(false);
    }
  });

  it("creates no session folder in partial mode, or for --dry-run", async () => {
    useEnvVault();
    const { calls, runPlan } = recorder();
    await zz(["claude", "--mode", "partial"], {
      cwd: s.repo,
      home: s.home,
      env: SECRET_ENV,
      runPlan,
    });
    expect(launchArgs(calls[0]!.plan).env).not.toHaveProperty(
      "ZZPERSONA_SESSION",
    );
    await zz(["claude", "--dry-run"], { cwd: s.repo, home: s.home });
    expect(existsSync(join(s.home, "sessions"))).toBe(false);
  });

  it("records what the session was launched with", async () => {
    useEnvVault();
    let launched: Record<string, unknown> | undefined;
    await zz(["claude", "--no-overlay"], {
      cwd: s.repo,
      home: s.home,
      env: SECRET_ENV,
      runPlan: async (plan: ActivationPlan) => {
        const session = launchArgs(plan).env.ZZPERSONA_SESSION!;
        launched = JSON.parse(
          readFileSync(join(session, "launched.json"), "utf8"),
        );
        return 0;
      },
    });
    expect(launched).toMatchObject({
      persona: "project/persona",
      source: "project",
      overlay: false,
      snapshot: {
        mcp: { servers: { "payments-schema": expect.any(Object) } },
        permissions: { deny: expect.arrayContaining(["Bash(rm -rf:*)"]) },
        settings: expect.any(Object),
      },
    });
  });
});
