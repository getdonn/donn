import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { ActivationPlan } from "@getdonn/adapter-sdk";
import { ExecutorError } from "./errors.js";

// Carries out an activation plan's steps in order. A launch step inherits the terminal, gets the
// resolved secrets in its env, and its exit code becomes ours. See 06 §3.

const FORWARDED = ["SIGINT", "SIGTERM"] as const;

export async function runPlan(
  plan: ActivationPlan,
  options: { secretEnv: Record<string, string>; env?: NodeJS.ProcessEnv },
): Promise<number> {
  let code = 0;
  for (const step of plan.steps) {
    if (step.kind === "overlay") {
      throw new ExecutorError(
        "overlay steps are not supported until the agents-md adapter",
      );
    }
    code = await new Promise<number>((resolve, reject) => {
      const child = spawn(step.command, step.args, {
        ...(step.cwd !== undefined && { cwd: step.cwd }),
        env: {
          ...(options.env ?? process.env),
          ...step.env,
          ...options.secretEnv,
        },
        stdio: "inherit",
      });
      const forward = (signal: NodeJS.Signals) => child.kill(signal);
      for (const signal of FORWARDED) process.on(signal, forward);
      const done = () => {
        for (const signal of FORWARDED) process.off(signal, forward);
      };
      child.on("error", (error) => {
        done();
        reject(
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? new ExecutorError(`command not found: ${step.command}`)
            : error,
        );
      });
      child.on("exit", (exitCode, signal) => {
        done();
        // The shell convention: a child ended by signal N exits 128 + N.
        resolve(
          signal ? 128 + (constants.signals[signal] ?? 0) : (exitCode ?? 1),
        );
      });
    });
    if (code !== 0) return code;
  }
  return code;
}
