import { z } from "zod";

/**
 * `donn capabilities --json`: for each harness, what it does with every persona field. The keys
 * of `fields` are capability fields (`instructions`, `hooks.pre-tool-use`, `targets.codex`, ...).
 */
export const CapabilitiesOutput = z.strictObject({
  harnesses: z.array(
    z.strictObject({
      id: z.string(),
      /** With `--detect`. */
      detected: z
        .strictObject({
          installed: z.boolean(),
          version: z.string().optional(),
          error: z.string().optional(),
        })
        .optional(),
      fields: z.record(
        z.string(),
        z.strictObject({
          support: z.enum(["native", "approximated", "advisory", "none"]),
          note: z.string().optional(),
          caveat: z.string().optional(),
        }),
      ),
    }),
  ),
});
export type CapabilitiesOutput = z.infer<typeof CapabilitiesOutput>;
