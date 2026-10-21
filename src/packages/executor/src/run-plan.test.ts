import { describe, expect, it } from "vitest";
import { ExecutorError, runPlan } from "./index.js";

const launch = (args: string[], env: Record<string, string> = {}) => ({
  steps: [
    {
      kind: "launch" as const,
      command: process.execPath,
      args,
      env,
      cwd: process.cwd(),
    },
  ],
});

describe("runPlan", () => {
  it("returns the child's exit code", async () => {
    expect(
      await runPlan(launch(["-e", "process.exit(3)"]), { secretEnv: {} }),
    ).toBe(3);
  });

  it("passes the step env and the resolved secrets", async () => {
    const check =
      "process.exit(process.env.ZZ_A === 'a' && process.env.ZZ_SECRET === 's' ? 0 : 9)";
    expect(
      await runPlan(launch(["-e", check], { ZZ_A: "a" }), {
        secretEnv: { ZZ_SECRET: "s" },
      }),
    ).toBe(0);
  });

  it("refuses overlay steps", async () => {
    await expect(
      runPlan(
        { steps: [{ kind: "overlay", path: "AGENTS.md", content: "x" }] },
        { secretEnv: {} },
      ),
    ).rejects.toThrow(
      "overlay steps are not supported until the agents-md adapter",
    );
  });

  it("reports a missing command", async () => {
    await expect(
      runPlan(
        { steps: [{ kind: "launch", command: "zz-nope", args: [], env: {} }] },
        { secretEnv: {} },
      ),
    ).rejects.toThrow(new ExecutorError("command not found: zz-nope"));
  });
});

describe("signals (spec 07)", () => {
  it("reports a signal-killed child as 128 + the signal number", async () => {
    expect(
      await runPlan(launch(["-e", "process.kill(process.pid, 'SIGTERM')"]), {
        secretEnv: {},
      }),
    ).toBe(143);
  });
});
