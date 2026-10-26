import { z } from "zod";

/** `donn doctor --json`: one entry per check; `fix` is the command that would put it right. */
export const DoctorOutput = z.strictObject({
  checks: z.array(
    z.strictObject({
      id: z.string(),
      status: z.enum(["ok", "warn", "error", "skipped"]),
      message: z.string(),
      fix: z.string().optional(),
    }),
  ),
});
export type DoctorOutput = z.infer<typeof DoctorOutput>;
