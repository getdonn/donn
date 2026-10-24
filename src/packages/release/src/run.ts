import { spawn } from "node:child_process";

export type RunResult = { code: number; stdout: string; stderr: string };

export type Runner = (
  cmd: string,
  args: string[],
  opts?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: "pipe" | "inherit";
  },
) => Promise<RunResult>;

/** Runs a command without a shell; a missing binary resolves with code 127. */
export const realRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const inherit = opts.stdio === "inherit";
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", (err) =>
      resolve({ code: 127, stdout, stderr: stderr + err.message }),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
