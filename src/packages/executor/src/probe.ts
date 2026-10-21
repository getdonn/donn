import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import type { Probe } from "@zzpersona/adapter-sdk";

// The real Probe adapters' detect() runs against. It never throws for a missing command
// (exit code 127) or an absent path (undefined); see Probe in @zzpersona/adapter-sdk.

const isMissing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

export function nodeProbe(): Probe {
  return {
    platform: process.platform,
    run: (command, args) =>
      new Promise((resolve) => {
        execFile(
          command,
          args,
          { timeout: 10_000, encoding: "utf8" },
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
