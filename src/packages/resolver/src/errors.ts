import type { ErrorCode } from "@zzpersona/spec";

/** A persona stack that cannot be resolved. `details` names the refs and paths involved. */
export class ResolveError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly details: Record<string, unknown>,
  ) {
    super(`${code}: ${JSON.stringify(details)}`);
    this.name = "ResolveError";
  }

  toJSON(): { code: ErrorCode } & Record<string, unknown> {
    return { code: this.code, ...this.details };
  }
}
