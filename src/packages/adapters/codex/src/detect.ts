import type { Detection, Probe } from "@zzpersona/adapter-sdk";

// Whether `codex` is installed, and its version (`codex-cli 0.163.0`).

export async function detect(probe: Probe): Promise<Detection> {
  const result = await probe.run("codex", ["--version"]);
  if (result.exitCode !== 0) return { installed: false, facts: {} };
  const version = /(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1];
  return { installed: true, ...(version && { version }), facts: {} };
}
