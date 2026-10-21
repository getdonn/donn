import { dirname } from "node:path";
import type { CliIo } from "../cli.js";
import { createContext, resolvePersona, type Context } from "../context.js";
import { selectPersona } from "../select.js";
import { projectKey, writeState } from "../state.js";

// zzpersona switch: choose the persona for this project, or the default for everywhere else.
// See docs/planning/07-cli-daily-use.md, section 1.

export interface SwitchOptions {
  default?: boolean;
  clear?: boolean;
  json?: boolean;
}

type Scope =
  { scope: "project"; key: string; repo: string } | { scope: "default" };

async function scopeFor(ctx: Context, forceDefault: boolean): Promise<Scope> {
  if (forceDefault || ctx.projectDir === undefined) return { scope: "default" };
  return {
    scope: "project",
    key: await projectKey(ctx.projectDir),
    repo: dirname(ctx.projectDir),
  };
}

export async function switchCommand(
  io: CliIo,
  persona: string | undefined,
  options: SwitchOptions,
): Promise<number> {
  const ctx = await createContext(io);
  const print = (text: string, json: Record<string, unknown>) =>
    io.stdout.write(
      options.json ? `${JSON.stringify(json, null, 2)}\n` : `${text}\n`,
    );

  if (options.clear) {
    const target = await scopeFor(ctx, options.default === true);
    const state = ctx.state;
    const previous =
      target.scope === "project" ? state.projects[target.key] : state.default;
    if (previous === undefined) {
      print("nothing to clear", { scope: target.scope, persona: null });
      return 0;
    }
    if (target.scope === "project") delete state.projects[target.key];
    else delete state.default;
    await writeState(ctx.home, state);
    print(
      target.scope === "project"
        ? `cleared the switch for ${target.repo}`
        : "cleared your default",
      {
        scope: target.scope,
        persona: previous,
        ...(target.scope === "project" && { project: target.key }),
      },
    );
    return 0;
  }

  if (persona === undefined) {
    const selection = await selectPersona(undefined, ctx);
    const where =
      selection.source === "switch" || selection.source === "project"
        ? ` for ${dirname(ctx.projectDir!)}`
        : "";
    const label =
      selection.source === "project" ? "project persona" : selection.source;
    print(`${selection.ref} (${label}${where})`, {
      persona: selection.ref,
      source: selection.source,
      ...(selection.project !== undefined && { project: selection.project }),
    });
    return 0;
  }

  // Resolve before saving, so a typo or a broken persona is never stored.
  const selection = await selectPersona(persona, ctx);
  await resolvePersona(ctx, selection, true);
  const target = await scopeFor(ctx, options.default === true);
  const state = ctx.state;
  if (target.scope === "project") state.projects[target.key] = selection.ref;
  else state.default = selection.ref;
  await writeState(ctx.home, state);
  print(
    target.scope === "project"
      ? `${selection.ref} is now used for ${target.repo}`
      : `${selection.ref} is now your default`,
    {
      scope: target.scope,
      persona: selection.ref,
      ...(target.scope === "project" && { project: target.key }),
    },
  );
  return 0;
}
