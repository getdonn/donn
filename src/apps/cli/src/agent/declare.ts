import { readFile } from "node:fs/promises";
import { resolve, ResolveError } from "@getdonn/resolver";
import type { AgentTarget, ResolveResult } from "@getdonn/spec";
import type { LocalStore } from "@getdonn/store-local";
import { isDeepStrictEqual } from "node:util";
import {
  isMap,
  isNode,
  parse,
  parseDocument,
  stringify,
  type Node as YNode,
  type YAMLMap,
} from "yaml";
import type { Context } from "../context.js";
import { CliError } from "../errors.js";
import { writeFileAtomic } from "../fs.js";

// Step 1 of `donn agent create`: add `agents.define.<name>` to the project persona, the one
// place donn writes to a persona file. yaml's Document API finds where the entry goes and the
// entry is spliced into the source text, so every comment, blank line and flow collection
// outside it keeps its bytes. See docs/planning/25-agent-runner.md, section 2.

const PROJECT_PERSONA = "project/persona";

export interface DeclaredAgent {
  template: string;
  target: AgentTarget;
  path?: string;
}

const notEditable = (file: string, why: string) =>
  new CliError(
    "invalid-persona-file",
    `${file}: ${why}, so donn cannot add the agent; add it under agents.define by hand`,
    { file },
  );

const lineStart = (text: string, at: number) =>
  text.lastIndexOf("\n", at - 1) + 1;

/** `text`'s lines, each indented by `indent` spaces. */
const indented = (text: string, indent: number) =>
  text
    .split("\n")
    .map((line) => (line === "" ? line : `${" ".repeat(indent)}${line}`))
    .join("\n");

/**
 * `source` with `entry` (a mapping) added to the map node `node`: as indented block lines after
 * its last line, or before the closing brace of a flow map.
 */
function spliceInto(
  source: string,
  node: YAMLMap,
  entry: Record<string, unknown>,
): string {
  const [start, valueEnd, end] = node.range!;
  if (node.flow) {
    const text = stringify(entry, { collectionStyle: "flow" })
      .trim()
      .replace(/^\{\s*|\s*\}$/g, "");
    const last = node.items.at(-1);
    if (last === undefined)
      return `${source.slice(0, start)}{ ${text} }${source.slice(valueEnd)}`;
    const after = isNode(last.value)
      ? last.value.range![1]
      : (last.key as YNode).range![1];
    return `${source.slice(0, after)}, ${text}${source.slice(after)}`;
  }
  const first = node.items[0]!.key as YNode;
  const indent = first.range![0] - lineStart(source, first.range![0]);
  const head = source.slice(0, end);
  const gap = head === "" || head.endsWith("\n") ? "" : "\n";
  return `${head}${gap}${indented(stringify(entry), indent)}${source.slice(end)}`;
}

/**
 * Adds `agents.define.<name>` to the persona at `file`, changing no byte outside the new entry.
 * `check` sees the edited text before anything is written and may refuse it (a lock); with
 * `dryRun` nothing is written either way.
 */
export async function declareAgent(
  file: string,
  name: string,
  agent: DeclaredAgent,
  options: { dryRun: boolean; check?: (after: string) => Promise<void> },
): Promise<{ before: string; after: string }> {
  const before = await readFile(file, "utf8");
  const doc = parseDocument(before);
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    throw new CliError(
      "invalid-persona-file",
      `${file} does not parse as a persona; fix it first`,
      { file },
    );
  }
  const value = {
    template: agent.template,
    target: agent.target,
    ...(agent.path !== undefined && { path: agent.path }),
  };
  const root = doc.contents;
  const agents = root.get("agents", true);
  let after: string;
  if (agents === undefined) {
    if (root.flow) throw notEditable(file, "the persona is a flow mapping");
    const gap = before === "" || before.endsWith("\n") ? "" : "\n";
    after = `${before}${gap}${stringify({ agents: { define: { [name]: value } } })}`;
  } else if (!isMap(agents) || agents.items.length === 0) {
    throw notEditable(file, "agents is not a mapping with entries");
  } else {
    const define = agents.get("define", true);
    if (define === undefined) {
      after = spliceInto(before, agents, { define: { [name]: value } });
    } else if (!isMap(define) || (!define.flow && define.items.length === 0)) {
      throw notEditable(file, "agents.define is not a mapping");
    } else {
      after = spliceInto(before, define, { [name]: value });
    }
  }
  // The splice must say exactly what was meant, and nothing else may have moved.
  const check = parseDocument(after);
  const expected = doc.clone();
  expected.setIn(["agents", "define", name], value);
  if (
    check.errors.length > 0 ||
    !isDeepStrictEqual(check.toJSON(), expected.toJSON())
  )
    throw notEditable(file, "its layout is one donn cannot add to safely");
  await options.check?.(after);
  if (!options.dryRun) await writeFileAtomic(file, after);
  return { before, after };
}

/** The store with the project persona read from `text` instead of its file. */
function withPersonaText(store: LocalStore, text: string): LocalStore {
  return {
    ...store,
    load: async (ref) =>
      ref === PROJECT_PERSONA ? parse(text) : store.load(ref),
  };
}

/**
 * Resolves the project persona as `text` would make it. A lock on `agents.define` (or the
 * agent's entry) from an earlier layer becomes `agent-locked`, naming that layer.
 */
export async function resolveEdited(
  ctx: Context,
  text: string,
): Promise<ResolveResult> {
  try {
    return await resolve(PROJECT_PERSONA, {
      source: withPersonaText(ctx.store, text),
    });
  } catch (error) {
    if (
      error instanceof ResolveError &&
      error.code === "lock-violation" &&
      String(error.details.path).startsWith("agents")
    ) {
      const layer = String(error.details.lockedBy);
      throw new CliError(
        "agent-locked",
        `${layer} locks ${String(error.details.lock)}, so this project cannot declare an agent`,
        { layer, lock: error.details.lock },
      );
    }
    throw error;
  }
}

/** The lines `after` inserts between the head and tail it shares with `before`. */
export function addedLines(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  return b.slice(head, b.length - tail);
}
