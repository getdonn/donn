import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  patchSubagentTs,
  subagentFile,
  subagentNames,
} from "@getdonn/adapter-eve";
import type { ResolvedPersona } from "@getdonn/spec";
import { CliError } from "../errors.js";
import { fsStep, writeFileAtomic } from "../fs.js";

// A subagent's `agent.ts` with a gateway: it spreads its `donnSubagent` entry, so its model goes
// through the gateway too. `create` makes the edit as it edits agent.ts; `sync` makes it for a
// subagent it has not edited yet (one added later, or a gateway added later), and the daemon's
// sync with it. Each edited file is recorded in the manifest's `edits` and never edited again:
// one the user changed back is theirs, and the compile reports it. See
// docs/planning/24-adapter-eve.md, section 2.

/** The text of each subagent's `agent.ts` in the agent directory, by agent-directory path. */
export async function subagentTexts(
  dir: string,
): Promise<Record<string, string>> {
  let entries;
  try {
    entries = await readdir(join(dir, "agent/subagents"), {
      withFileTypes: true,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return {};
    throw error;
  }
  const texts: Record<string, string> = {};
  const paths = entries
    .filter((e) => e.isDirectory())
    .map((e) => subagentFile(e.name));
  for (const name of subagentNames(paths)) {
    const path = subagentFile(name);
    try {
      texts[path] = await readFile(join(dir, path), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return texts;
}

/**
 * The subagent files the persona's gateway needs edited, with their new text: none without a
 * gateway, none donn edited before (`edits`), none that already spread their entry. One the edit
 * refuses is `agent-ts-unrecognised`, naming it (the compile refused it first wherever it ran).
 */
export async function pendingSubagentEdits(
  dir: string,
  ir: ResolvedPersona,
  edits: readonly string[],
): Promise<{ path: string; text: string }[]> {
  if (ir.models.gateway === undefined) return [];
  const pending: { path: string; text: string }[] = [];
  const texts = await subagentTexts(dir);
  for (const name of subagentNames(Object.keys(texts))) {
    const path = subagentFile(name);
    if (edits.includes(path)) continue;
    const result = patchSubagentTs(texts[path]!, name);
    if (!result.ok) {
      throw new CliError(result.code, `${path}: ${result.hint}`, {
        file: join(dir, path),
        fix: result.hint,
      });
    }
    if (result.spread === "shadowed") {
      throw new CliError(
        "agent-ts-unrecognised",
        `${path}: its donnSubagent spread is followed by a model or modelContextWindowTokens property, which overrides the gateway's; put the spread last`,
        { file: join(dir, path) },
      );
    }
    if (result.spread === "missing") pending.push({ path, text: result.text });
  }
  return pending;
}

/** Makes the pending edits; returns the paths edited. */
export async function editSubagents(
  dir: string,
  ir: ResolvedPersona,
  edits: readonly string[],
): Promise<string[]> {
  const pending = await pendingSubagentEdits(dir, ir, edits);
  for (const { path, text } of pending) {
    const file = join(dir, path);
    await fsStep(file, () => writeFileAtomic(file, text));
  }
  return pending.map((p) => p.path);
}

/** How a subagent stands with the gateway, for `doctor`. */
export interface SubagentState {
  path: string;
  /** `pending`: sync edits it; `bypassed`: donn edited it and the user changed it back. */
  state: "routed" | "pending" | "bypassed" | "unrecognised";
}

/** Each subagent's state; none without a gateway. */
export async function subagentStates(
  dir: string,
  ir: ResolvedPersona,
  edits: readonly string[],
): Promise<SubagentState[]> {
  if (ir.models.gateway === undefined) return [];
  const texts = await subagentTexts(dir);
  return subagentNames(Object.keys(texts)).map((name) => {
    const path = subagentFile(name);
    const result = patchSubagentTs(texts[path]!, name);
    const state: SubagentState["state"] =
      result.ok && result.spread === "last"
        ? "routed"
        : edits.includes(path)
          ? "bypassed"
          : result.ok && result.spread === "missing"
            ? "pending"
            : "unrecognised";
    return { path, state };
  });
}
