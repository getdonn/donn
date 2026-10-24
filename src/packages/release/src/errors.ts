/** A failure the release tooling reports to the operator; `code` is stable. */
export class ReleaseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReleaseError";
    this.code = code;
  }
}
