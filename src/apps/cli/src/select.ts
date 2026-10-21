import type { Ref } from "@zzpersona/spec";
import type { Context } from "./context.js";
import { CliError } from "./errors.js";
import { projectKey } from "./state.js";

// Which persona a command uses, and why. First match wins: a persona named on the command line,
// this project's switch, this project's persona, the default. See
// docs/planning/07-cli-daily-use.md, section 1.

export type Source = "argument" | "switch" | "project" | "default";

export interface Selection {
  ref: Ref;
  source: Source;
  /** The project's state key, when the selection came from a project switch. */
  project?: string;
}

async function fromArgument(raw: string, ctx: Context): Promise<Ref> {
  const arg = raw.replace(/\.yaml$/, "");
  const available = await ctx.store.list();
  if (arg.includes("/")) {
    if (available.includes(arg)) return arg;
    // A ref the store can load but doesn't list (e.g. project/persona) still works.
    if ((await ctx.store.load(arg)) !== undefined) return arg;
    throw unknown(
      arg,
      available,
      (ref) => ref.toLowerCase() === arg.toLowerCase(),
    );
  }
  const candidates = available.filter((ref) => ref.endsWith(`/${arg}`));
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    throw new CliError(
      "ambiguous-persona",
      `${arg} matches several personas: ${candidates.join(", ")}`,
      { name: arg, candidates },
    );
  }
  throw unknown(arg, available, (ref) =>
    ref.toLowerCase().endsWith(`/${arg.toLowerCase()}`),
  );
}

function unknown(
  name: string,
  available: Ref[],
  matches: (ref: Ref) => boolean,
) {
  const close = available.filter(matches);
  const suggestion = close.length === 1 ? close[0] : undefined;
  return new CliError(
    "unknown-persona",
    `no persona named ${name}${suggestion ? ` — did you mean ${suggestion}?` : ""}`,
    { name, candidates: [], ...(suggestion !== undefined && { suggestion }) },
  );
}

export async function selectPersona(
  arg: string | undefined,
  ctx: Context,
): Promise<Selection> {
  if (arg !== undefined)
    return { ref: await fromArgument(arg, ctx), source: "argument" };
  if (ctx.projectDir !== undefined) {
    const key = await projectKey(ctx.projectDir);
    const switched = ctx.state.projects[key];
    if (switched !== undefined)
      return { ref: switched, source: "switch", project: key };
    return { ref: "project/persona", source: "project" };
  }
  if (ctx.state.default !== undefined)
    return { ref: ctx.state.default, source: "default" };
  const available = await ctx.store.list();
  throw new CliError(
    "no-persona",
    `not in a project (no .zzpersona/persona.yaml here or above) and no default set; name a persona or run \`zzpersona switch <persona>\`. Available: ${available.join(", ") || "(none found)"}`,
    { available },
  );
}
