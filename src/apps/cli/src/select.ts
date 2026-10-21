import type { Ref } from "@zzpersona/spec";
import type { Context } from "./context.js";
import { CliError } from "./errors.js";

/**
 * No argument: the project persona. A ref with a slash: as given. A bare name: the one listed
 * ref ending in /<name>. See docs/planning/06-cli-core-loop.md, section 4.
 */
export async function selectPersona(
  arg: string | undefined,
  ctx: Context,
): Promise<Ref> {
  if (arg === undefined) {
    if (ctx.projectDir !== undefined) return "project/persona";
    const available = await ctx.store.list();
    throw new CliError(
      "no-persona",
      `not in a project (no .zzpersona/persona.yaml here or above); name a persona: ${available.join(", ") || "(none found)"}`,
      { available },
    );
  }
  if (arg.includes("/")) return arg as Ref;
  const candidates = (await ctx.store.list()).filter((ref) =>
    ref.endsWith(`/${arg}`),
  );
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new CliError("unknown-persona", `no persona named ${arg}`, {
      name: arg,
      candidates,
    });
  }
  throw new CliError(
    "ambiguous-persona",
    `${arg} matches several personas: ${candidates.join(", ")}`,
    { name: arg, candidates },
  );
}
