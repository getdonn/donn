import { dirname } from "node:path";
import type { CliIo } from "../cli.js";
import { createContext, resolvePersona, type Context } from "../context.js";
import { CliError } from "../errors.js";
import { findAdapter } from "../plugins.js";
import { builtFrom, freshen } from "../registry.js";
import { selectPersona, type Selection } from "../select.js";
import { projectKey, readState, updateState } from "../state.js";
import { harnessReport, reportLines } from "../switch-report.js";

// donn switch: choose the persona for this project, or the default for everywhere else.
// See docs/planning/07-cli-daily-use.md, section 1.

export interface SwitchOptions {
  default?: boolean;
  clear?: boolean;
  json?: boolean;
  /** Report this harness only. */
  harness?: string;
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
  if (!options.json) await freshen(io, { budgetMs: 1000 });
  const ctx = await createContext(io);
  // A typo in --harness is refused before anything is saved.
  if (options.harness !== undefined)
    await findAdapter(ctx, io.env, options.harness);
  const print = (text: string, json: Record<string, unknown>) =>
    io.stdout.write(
      options.json ? `${JSON.stringify(json, null, 2)}\n` : `${text}\n`,
    );
  /** After a choice is saved: what it means in each harness (spec 17). */
  const printWithReport = async (
    text: string,
    json: Record<string, unknown>,
    selection: Selection | undefined,
    here: boolean,
  ) => {
    if (selection === undefined) return print(text, json);
    const results = await harnessReport(io, ctx, selection, {
      ...(options.harness !== undefined && { only: options.harness }),
      here,
    });
    print([text, ...reportLines(results, selection.ref)].join("\n"), {
      ...json,
      harnesses: results,
    });
  };

  if (options.clear) {
    if (persona !== undefined) {
      throw new CliError(
        "usage",
        "switch --clear takes no persona; it clears this project's switch, or the default with --default",
      );
    }
    const target = await scopeFor(ctx, options.default === true);
    let previous: string | undefined;
    await updateState(ctx.home, (state) => {
      previous =
        target.scope === "project" ? state.projects[target.key] : state.default;
      if (target.scope === "project") delete state.projects[target.key];
      else delete state.default;
    });
    if (previous === undefined) {
      print("nothing to clear", { scope: target.scope, persona: null });
      return 0;
    }
    // The report is for the persona that applies now, if any. The same context, with the new
    // state: a second one would repeat its warnings.
    const now: Context = { ...ctx, state: await readState(ctx.home) };
    const applies = await selectPersona(undefined, now).catch((error) => {
      if (error instanceof CliError && error.code === "no-persona")
        return undefined;
      throw error;
    });
    await printWithReport(
      target.scope === "project"
        ? `cleared the switch for ${target.repo}`
        : "cleared your default",
      {
        scope: target.scope,
        persona: previous,
        ...(target.scope === "project" && { project: target.key }),
      },
      applies,
      target.scope === "project",
    );
    return 0;
  }

  if (persona === undefined && options.default) {
    const ref = ctx.state.default;
    print(ref === undefined ? "no default set" : `${ref} (default)`, {
      persona: ref ?? null,
      source: "default",
    });
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
  const target = await scopeFor(ctx, options.default === true);
  if (target.scope === "default" && selection.ref.startsWith("project/")) {
    throw new CliError(
      "invalid-default",
      "a project persona cannot be the default: it only exists inside its project",
      { persona: selection.ref },
    );
  }
  const resolved = await resolvePersona(ctx, selection, true);
  await updateState(ctx.home, (state) => {
    if (target.scope === "project") state.projects[target.key] = selection.ref;
    else state.default = selection.ref;
  });
  await printWithReport(
    target.scope === "project"
      ? `${selection.ref} is now used for ${target.repo}`
      : `${selection.ref} is now your default`,
    {
      scope: target.scope,
      persona: selection.ref,
      ...(target.scope === "project" && { project: target.key }),
      builtFrom: builtFrom(ctx.store, resolved.ir.layers),
    },
    selection,
    target.scope === "project",
  );
  return 0;
}
