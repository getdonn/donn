import { z } from "zod";

/**
 * What a command prints to stdout under `--json` when it fails: `{ error: { code, message,
 * ...details } }` (`report()` in the CLI's errors.ts). The details differ per code (`fix`,
 * `names`, `problems`, `path`, ...), so any are accepted; the code is a kebab-case string.
 *
 * `message` is optional because two of today's errors carry none: a resolver error
 * (`missing-ref`, `cycle`, ... print their details instead) and `secrets` (it prints `failures`).
 */
export const ErrorEnvelope = z.strictObject({
  error: z.looseObject({
    code: z.string().min(1),
    message: z.string().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
