import { ExecutorError } from "@zzpersona/executor";
import { ResolveError } from "@zzpersona/resolver";
import { SecretResolutionError } from "@zzpersona/secrets";
import { StoreError } from "@zzpersona/store-local";
import type { CliIo } from "./cli.js";

/** A problem with how the CLI was called or configured. */
export class CliError extends Error {
  override name = "CliError";
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const show = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);

/** The error as text and as the --json envelope. Unknown errors are bugs: rethrown. */
function describe(error: unknown): {
  text: string;
  json: Record<string, unknown>;
} {
  if (error instanceof ResolveError) {
    const { code, ...details } = error.toJSON();
    const fields = Object.entries(details).map(([k, v]) => `${k}=${show(v)}`);
    return { text: `${code}: ${fields.join(", ")}`, json: error.toJSON() };
  }
  if (error instanceof CliError) {
    return {
      text: error.message,
      json: { code: error.code, ...error.details },
    };
  }
  if (error instanceof StoreError) {
    const { file, line, configKey } = error;
    return {
      text: error.message,
      json: {
        code: "store",
        message: error.message,
        ...(file !== undefined && { file }),
        ...(line !== undefined && { line }),
        ...(configKey !== undefined && { configKey }),
      },
    };
  }
  if (error instanceof SecretResolutionError) {
    return {
      text: error.message,
      json: { code: "secrets", failures: error.failures },
    };
  }
  if (error instanceof ExecutorError) {
    return {
      text: error.message,
      json: { code: "executor", message: error.message },
    };
  }
  throw error;
}

/** Print an error the user can act on; returns the exit code. */
export function report(io: CliIo, json: boolean, error: unknown): number {
  const { text, json: envelope } = describe(error);
  if (json)
    io.stdout.write(`${JSON.stringify({ error: envelope }, null, 2)}\n`);
  else io.stderr.write(`error: ${text}\n`);
  return 1;
}
