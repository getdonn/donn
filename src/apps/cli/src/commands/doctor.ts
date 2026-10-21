import type { CliIo } from "../cli.js";
import { runChecks } from "../doctor/checks.js";

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
    for (const check of checks) {
      io.stdout.write(
        `${check.status.padEnd(8)}${check.id.padEnd(10)}${check.message}\n`,
      );
      if (check.fix !== undefined)
        io.stdout.write(`${" ".repeat(8)}fix: ${check.fix}\n`);
    }
  }
  return checks.some((c) => c.status === "error") ? 1 : 0;
}
