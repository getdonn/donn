import { AdapterInputError } from "@getdonn/adapter-sdk";

/** The compile error codes of docs/planning/24-adapter-eve.md that this adapter raises. */
export type EveErrorCode =
  | "context-window-required"
  | "env-collision"
  | "framework-version"
  | "model-needs-gateway"
  | "name-collision"
  | "slot-collision";

/** A compile refusal with a spec 24 code; the message starts with the code. */
export class EveCompileError extends AdapterInputError {
  override name = "EveCompileError";
  constructor(
    readonly code: EveErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}
