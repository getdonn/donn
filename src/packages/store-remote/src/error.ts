import type { Problem, ProblemCode } from "@zzpersona/registry-api";

export type RegistryErrorCode =
  | ProblemCode
  | "insecure-url"
  | "unreachable"
  | "timeout"
  | "registry-protocol";

/**
 * A registry call that did not succeed. Messages come only from the server's problem `detail`
 * and `problems[].message`, or from fixed text; never from request data, headers or the token.
 */
export class RegistryError extends Error {
  override name = "RegistryError";
  problems?: Problem["problems"];

  constructor(
    readonly code: RegistryErrorCode,
    message: string,
    problems?: Problem["problems"],
  ) {
    super(message);
    if (problems !== undefined) this.problems = problems;
  }
}
