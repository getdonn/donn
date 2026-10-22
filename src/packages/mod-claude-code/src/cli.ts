import type { Mod$ } from "./api.js";
import { UNAVAILABLE } from "./decide.js";
import { viaDaemon, type Output } from "./transport.js";

// Runs `zzpersona <args> --json` for the mod: through the daemon when it answers, else as a
// process. Never throws: every failure is a reason the mod can show. See
// docs/planning/09-mod-claude-code.md, section 1, and docs/planning/15-mod-transport.md, section 2.

export const CLI_TIMEOUT_MS = 5000;

export type CliResult =
  { ok: true; json: unknown } | { ok: false; reason: string; code?: string };

export async function runCli(
  $: Mod$,
  args: string[],
  cwd: string,
): Promise<CliResult> {
  let result: Output | undefined = await viaDaemon($, [...args, "--json"], cwd);
  try {
    result ??= await $.process.run(["zzpersona", ...args, "--json"], {
      cwd,
      timeoutMs: CLI_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT|not found|could not start|cannot start/i.test(message))
      return { ok: false, reason: "zzpersona not found on PATH" };
    if (/timed? ?out/i.test(message)) return { ok: false, reason: "timed out" };
    // Refused, and no daemon answered either: say what fixes it.
    return { ok: false, code: "unavailable", reason: UNAVAILABLE };
  }
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      reason: "zzpersona printed something that is not JSON",
    };
  }
  if (result.exitCode === 0) return { ok: true, json };
  const error =
    typeof json === "object" && json !== null
      ? (json as { error?: { code?: string; message?: string } }).error
      : undefined;
  return {
    ok: false,
    ...(error?.code !== undefined && { code: error.code }),
    reason: error?.message ?? `zzpersona exited ${result.exitCode}`,
  };
}
