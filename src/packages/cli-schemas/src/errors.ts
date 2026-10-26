import { z } from "zod";

/**
 * What a command prints to stdout under `--json` when it fails: `{ error: { code, message,
 * ...details } }` (`report()` in the CLI's errors.ts). The details differ per code (`fix`,
 * `names`, `problems`, `path`, `failures`, ...), so any are accepted; the code is a kebab-case
 * string. Every envelope carries a message: a resolver error's is its text form (`missing-ref:
 * ref=org/x, from=team/y`), with the details beside it.
 */
export const ErrorEnvelope = z.strictObject({
  error: z.looseObject({
    code: z.string().min(1),
    message: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
