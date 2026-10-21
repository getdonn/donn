import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import type { Probe } from "@zzpersona/adapter-sdk";

// The real Probe adapters' detect() runs against. It never throws for a missing command
// (exit code 127) or an absent path (undefined); see Probe in @zzpersona/adapter-sdk.

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
        execFile(
          command,
          args,
          { timeout: timeoutMs, encoding: "utf8" },
          (error, stdout, stderr) => {
            if (!error) return resolve({ exitCode: 0, stdout, stderr });
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") {
              return resolve({
                exitCode: 127,
                stdout: "",
                stderr: error.message,
              });
            }
            if ((error as { killed?: boolean }).killed) {
              return resolve({
                exitCode: 124,
                stdout,
                stderr: `${command} timed out after ${timeoutMs / 1000}s`,
              });
            }
            const exitCode =
              typeof (error as { code?: unknown }).code === "number"
                ? (error as unknown as { code: number }).code
                : 1;
            resolve({ exitCode, stdout, stderr });
          },
        );
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
