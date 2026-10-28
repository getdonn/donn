import type { ReportEntry } from "@getdonn/adapter-sdk";
import type { ResolvedPersona } from "@getdonn/spec";
import { patchSubagentTs, subagentEntry, subagentFile } from "./agent-ts.js";
import { EveCompileError } from "./errors.js";

// Subagents and the gateway. eve gives a declared subagent nothing of the root's, its model
// included, so with `models.gateway` each `agent/subagents/<name>/agent.ts` spreads its entry of
// `donnSubagent` (from `lib/donn/config.ts`) last, and the CLI makes that edit once, as it does
// agent.ts's. A file donn edited that no longer routes is the user's choice and is reported.
// `targets.eve.subagents.<name>.model` picks another model of the same gateway. Without a
// gateway nothing changes. See docs/planning/24-adapter-eve.md, section 2.

const SUBAGENT_TS = /^agent\/subagents\/([^/]+)\/agent\.ts$/;
/** Any agent module under a `subagents/` folder: nested, from an extension, or not `.ts`. */
const ANY_SUBAGENT =
  /(?:^|\/)subagents\/[^/]+\/agent\.(?:ts|mts|cts|js|mjs|cjs)$/;

/** The subagents whose `agent.ts` is among `paths`, by name, sorted. */
export function subagentNames(paths: Iterable<string>): string[] {
  const names: string[] = [];
  for (const path of paths) {
    const name = SUBAGENT_TS.exec(path)?.[1];
    if (name !== undefined) names.push(name);
  }
  return names.sort();
}

/** One entry of `donnSubagent`: routed through the gateway (with an override id), or `{}`. */
export interface SubagentEntry {
  name: string;
  routed: boolean;
  /** `targets.eve.subagents.<name>.model`, when given. */
  model?: string;
}

const byName = ([a]: [string, unknown], [b]: [string, unknown]) =>
  a < b ? -1 : a > b ? 1 : 0;

/** The valid `targets.eve.subagents` model overrides, and entries for what is not read. */
function overrides(
  ir: ResolvedPersona,
  known: ReadonlySet<string>,
): { models: Map<string, string>; entries: ReportEntry[] } {
  const models = new Map<string, string>();
  const entries: ReportEntry[] = [];
  const given = (ir.targets.eve ?? {}).subagents;
  if (given === undefined) return { models, entries };
  if (typeof given !== "object" || given === null || Array.isArray(given)) {
    entries.push({
      path: "targets.eve.subagents",
      outcome: "dropped",
      reason: "targets.eve.subagents must map a subagent name to { model }",
    });
    return { models, entries };
  }
  for (const [name, entry] of Object.entries(given).sort(byName)) {
    const path = `targets.eve.subagents.${name}`;
    if (!known.has(name)) {
      entries.push({
        path,
        outcome: "dropped",
        reason: `names no subagent: the template has no ${subagentFile(name)}`,
      });
      continue;
    }
    if (typeof entry !== "object" || entry === null) {
      entries.push({
        path,
        outcome: "dropped",
        reason: "must be an object with a model",
      });
      continue;
    }
    const model = (entry as Record<string, unknown>).model;
    if (typeof model === "string" && model.trim() !== "") {
      if (ir.models.gateway === undefined)
        entries.push({
          path: `${path}.model`,
          outcome: "dropped",
          reason:
            "applies only with models.gateway; without one the subagent keeps its own model",
        });
      else models.set(name, model);
    } else if (model !== undefined) {
      entries.push({
        path: `${path}.model`,
        outcome: "dropped",
        reason:
          "must be a non-empty string; the subagent gets the gateway's default model",
      });
    }
    for (const field of Object.keys(entry).filter((f) => f !== "model")) {
      entries.push({
        path: `${path}.${field}`,
        outcome: "dropped",
        reason: "unknown key; only model is read",
      });
    }
  }
  return { models, entries };
}

/**
 * The `donnSubagent` entries and report entries for the subagents in `project.texts`
 * (agent-directory path to text). With a gateway every subagent gets an entry. One whose
 * `agent.ts` the edit refuses, or whose spread a later `model` overrides, is
 * `agent-ts-unrecognised`, naming the file, unless donn edited it before (`project.edited`): then
 * the user changed it, and it is reported as bypassing the gateway, as is one that no longer
 * spreads its entry. Any other agent module under a `subagents/` folder (nested, from an
 * extension, not `.ts`) is reported as not routed. Without a gateway, a subagent an earlier
 * gateway's edit may still read gets an empty entry, so it keeps building.
 */
export function subagentPlan(
  ir: ResolvedPersona,
  defaultModel: { id: string; path: string },
  project: {
    texts?: Record<string, string>;
    edited?: string[];
    existing: string[];
  },
): { subagents: SubagentEntry[]; entries: ReportEntry[] } {
  const texts = project.texts ?? {};
  const edited = new Set(project.edited ?? []);
  const names = subagentNames(Object.keys(texts));
  const { models, entries } = overrides(ir, new Set(names));
  const subagents: SubagentEntry[] = [];
  const routed: ReportEntry[] = [];
  for (const name of names) {
    const file = subagentFile(name);
    const text = texts[file]!;
    const result = patchSubagentTs(text, name);
    if (ir.models.gateway === undefined) {
      // An empty entry wherever an earlier gateway's edit may still read it.
      if (edited.has(file) || (result.ok && result.spread !== "missing"))
        subagents.push({ name, routed: false });
      continue;
    }
    const model = models.get(name);
    subagents.push({ name, routed: true, ...(model && { model }) });
    const path =
      model === undefined
        ? defaultModel.path
        : `targets.eve.subagents.${name}.model`;
    const why = !result.ok
      ? "is no longer a file donn can edit"
      : result.spread === "shadowed"
        ? "spreads its donnSubagent entry before a model or modelContextWindowTokens that overrides it"
        : result.spread === "missing" && edited.has(file)
          ? "no longer spreads its donnSubagent entry"
          : undefined;
    if (why !== undefined && edited.has(file)) {
      routed.push({
        path,
        outcome: "dropped",
        reason: `subagent ${name} ${why}, so its model bypasses the gateway; put \`...${subagentEntry(name)}\` last in ${file} to route it`,
      });
      continue;
    }
    if (!result.ok) {
      throw new EveCompileError(
        "agent-ts-unrecognised",
        `${file}: ${result.hint}`,
      );
    }
    if (result.spread === "shadowed") {
      throw new EveCompileError(
        "agent-ts-unrecognised",
        `${file}: \`...${subagentEntry(name)}\` is followed by a model or modelContextWindowTokens property, which overrides the gateway's; put the spread last`,
      );
    }
    const id = model ?? defaultModel.id;
    const own = result.model;
    routed.push({
      path:
        model === undefined
          ? defaultModel.path
          : `targets.eve.subagents.${name}.model`,
      outcome: "advisory",
      reason:
        own.kind === "none"
          ? `subagent ${name}, which sets no model, gets the gateway's ${id}`
          : `subagent ${name}'s own model ${own.kind === "literal" ? `${own.id} ` : ""}is replaced by the gateway's ${id}`,
    });
  }
  if (ir.models.gateway !== undefined) {
    for (const path of [...project.existing].sort()) {
      if (!ANY_SUBAGENT.test(path) || SUBAGENT_TS.test(path)) continue;
      routed.push({
        path: defaultModel.path,
        outcome: "advisory",
        reason: `${path} is not routed through the gateway; donn edits top-level agent/subagents/<name>/agent.ts only`,
      });
    }
  }
  return { subagents, entries: [...routed, ...entries] };
}
