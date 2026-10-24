import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import type { Probe } from "@getdonn/adapter-sdk";

// The real Probe adapters' detect() runs against. It never throws for a missing command
// (exit code 127) or an absent path (undefined); see Probe in @getdonn/adapter-sdk.

const isMissing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/**
 * `timeoutMs` bounds each command (default 10 s); a command killed by it returns exit code 124
 * (as timeout(1) does) with "timed out" on stderr.
 */
export function nodeProbe(options: { timeoutMs?: number } = {}): Probe {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    platform: process.platform,
    run: (command, args) =>
      new Promise((resolve) => {
        // No input: a command that reads stdin (an interactive shell's rc file) sees its end.
        // Its own process group, so a timeout kills what it started too (not on Windows).
        const child = spawn(command, args, {
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
        child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
        // SIGKILL: an interactive shell ignores SIGTERM.
        const timer = setTimeout(() => {
          timedOut = true;
          try {
            if (child.pid !== undefined && process.platform !== "win32")
              process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }, timeoutMs);
        child.on("error", (error) => {
          clearTimeout(timer);
          resolve(
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? { exitCode: 127, stdout: "", stderr: error.message }
              : { exitCode: 1, stdout, stderr: error.message },
          );
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(
            timedOut
              ? {
                  exitCode: 124,
                  stdout,
                  stderr: `${command} timed out after ${timeoutMs / 1000}s`,
                }
              : { exitCode: code ?? 1, stdout, stderr },
          );
        });
      }),
    readFile: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
    listDir: async (path) => {
      try {
        return await readdir(path);
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
  };
}
