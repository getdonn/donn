import type { CliIo } from "../cli.js";
import { runChecks, type Check } from "../doctor/checks.js";

export interface DoctorOptions {
  fix?: boolean;
  json?: boolean;
}

export async function doctorCommand(
  io: CliIo,
  persona: string | undefined,
  options: DoctorOptions,
): Promise<number> {
  const checks = await runChecks(io, {
    ...(persona !== undefined && { persona }),
    fix: options.fix === true,
  });
  if (options.json) {
    io.stdout.write(`${JSON.stringify({ checks }, null, 2)}\n`);
  } else {
    io.stdout.write(checkLines(checks));
  }
  return checks.some((c) => c.status === "error") ? 1 : 0;
}

/** The checks as `donn doctor` prints them: one line each, and its fix under it. */
export function checkLines(checks: Check[]): string {
  return checks
    .map(
      (check) =>
        `${check.status.padEnd(8)}${check.id.padEnd(Math.max(10, check.id.length + 1))}${check.message}\n${
          check.fix === undefined ? "" : `${" ".repeat(8)}fix: ${check.fix}\n`
        }`,
    )
    .join("");
}
