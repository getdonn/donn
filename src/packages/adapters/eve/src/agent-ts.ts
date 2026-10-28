import { parse } from "@babel/parser";

// The one-time edit to a template's `agent.ts`: import `donn` and spread it as the last property
// of the `defineAgent({...})` call, dropping a literal `model`. With a gateway, each subagent's
// `agent/subagents/<name>/agent.ts` gets the same edit with its `donnSubagent` entry, keeping its
// own `model` for when there is no gateway. See docs/planning/24-adapter-eve.md, section 2. The
// edit is by source spans, never a re-print, so everything outside the edited spans is
// byte-identical. The parser only locates; it never prints.

const IMPORT_LINE = 'import { donn } from "./lib/donn/config";';
const CONFIG_SOURCE = "./lib/donn/config";
const SUBAGENT_CONFIG_SOURCE = "../../lib/donn/config";

export type AgentTsResult =
  | { ok: true; text: string }
  | { ok: false; code: "agent-ts-unrecognised"; hint: string };

/** A subagent's own `model`: a string literal, another expression, or none. */
export type SubagentModel =
  { kind: "literal"; id: string } | { kind: "expression" } | { kind: "none" };

/**
 * Where the subagent's file stood before the edit: spreading its entry last, not spreading it,
 * or spreading it before a `model` or `modelContextWindowTokens` property that overrides it.
 */
export type SubagentSpread = "last" | "missing" | "shadowed";

export type SubagentTsResult =
  | { ok: true; text: string; model: SubagentModel; spread: SubagentSpread }
  | { ok: false; code: "agent-ts-unrecognised"; hint: string };

/** The keys of a subagent's entry: written after its spread, they win over the gateway's. */
const ENTRY_KEYS = new Set(["model", "modelContextWindowTokens"]);

/** The agent-directory path of subagent `name`'s `agent.ts`. */
export const subagentFile = (name: string) =>
  `agent/subagents/${name}/agent.ts`;

/** `donnSubagent.<name>`, or `donnSubagent["<name>"]` for a name that is not an identifier. */
export const subagentEntry = (name: string) =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? `donnSubagent.${name}`
    : `donnSubagent[${JSON.stringify(name)}]`;

/** A file `donn agent create` writes when the template has no `agent.ts`. */
export function createdAgentTs(): string {
  return `import { defineAgent } from "eve";\n${IMPORT_LINE}\n\nexport default defineAgent({ ...donn });\n`;
}

/** The slice of a Babel node this file reads. */
interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Node).type === "string";

const kids = (node: Node): Node[] =>
  Object.values(node).flatMap((v) =>
    Array.isArray(v) ? v.filter(isNode) : isNode(v) ? [v] : [],
  );

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of kids(node)) walk(child, visit);
}

const str = (node: Node, key: string): string | undefined => {
  const value = node[key];
  return typeof value === "string" ? value : undefined;
};
const child = (node: Node, key: string): Node | undefined => {
  const value = node[key];
  return isNode(value) ? value : undefined;
};

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** What one edit adds: the import, the binding it brings, the spread, and whether `model` goes. */
interface Patch {
  /** Where the hint says to add the lines. */
  file: string;
  binding: string;
  source: string;
  /** The spread's argument: `donn`, or `donnSubagent.<name>`. */
  spread: string;
  isSpread: (argument: Node) => boolean;
  dropModel: boolean;
}

const importLine = (edit: Patch) =>
  `import { ${edit.binding} } from "${edit.source}";`;

type Refusal = Extract<AgentTsResult, { ok: false }>;

const refusal = (edit: Patch, why: string): Refusal => ({
  ok: false,
  code: "agent-ts-unrecognised",
  hint: `${why}. Add \`${importLine(edit)}\` to ${edit.file} and put \`...${edit.spread}\` as the last property of the defineAgent({...}) call${edit.dropModel ? ", removing any `model` property" : ""}`,
});

const ROOT: Patch = {
  file: "agent.ts",
  binding: "donn",
  source: CONFIG_SOURCE,
  spread: "donn",
  isSpread: (argument) =>
    argument.type === "Identifier" && str(argument, "name") === "donn",
  dropModel: true,
};

function subagentPatch(name: string): Patch {
  return {
    file: subagentFile(name),
    binding: "donnSubagent",
    source: SUBAGENT_CONFIG_SOURCE,
    spread: subagentEntry(name),
    // `donnSubagent.<name>` or `donnSubagent["<name>"]`, either way round.
    isSpread: (argument) => {
      if (argument.type !== "MemberExpression") return false;
      const object = child(argument, "object");
      const property = child(argument, "property");
      if (
        object?.type !== "Identifier" ||
        str(object, "name") !== "donnSubagent"
      )
        return false;
      if (!property) return false;
      return argument["computed"] === true
        ? property.type === "StringLiteral" && str(property, "value") === name
        : property.type === "Identifier" && str(property, "name") === name;
    },
    dropModel: false,
  };
}

/** The name of a property key, if it is a plain identifier or string. */
function keyName(prop: Node): string | undefined {
  if (prop["computed"] === true) return undefined;
  const key = child(prop, "key");
  if (!key) return undefined;
  if (key.type === "Identifier") return str(key, "name");
  if (key.type === "StringLiteral") return str(key, "value");
  return undefined;
}

/** Index of the first `,` at or after `from`, skipping whitespace and comments; -1 if none. */
function commaAfter(source: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < source.length && /\s/.test(source[i]!)) i++;
    if (source.startsWith("//", i)) {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl;
    } else if (source.startsWith("/*", i)) {
      const close = source.indexOf("*/", i + 2);
      if (close === -1) return -1;
      i = close + 2;
    } else break;
  }
  return source[i] === "," ? i : -1;
}

const lineStart = (source: string, at: number) =>
  source.lastIndexOf("\n", at - 1) + 1;
const lineEnd = (source: string, at: number) => {
  const nl = source.indexOf("\n", at);
  return nl === -1 ? source.length : nl;
};

/**
 * Edit the template's `agent.ts`. Refuses (`agent-ts-unrecognised`, with the two lines to add by
 * hand) unless the file has exactly one `defineAgent` call imported from "eve" as `defineAgent`,
 * default-exported with a single object literal argument. A file that already imports and
 * spreads `donn` comes back unchanged.
 */
export function patchAgentTs(source: string): AgentTsResult {
  const result = patch(source, ROOT);
  return result.ok ? { ok: true, text: result.text } : result;
}

/**
 * Edit subagent `name`'s `agent/subagents/<name>/agent.ts`: import `donnSubagent` and spread its
 * entry last, so a gateway's model wins; the subagent's own `model` stays (it is the model when
 * there is no gateway) and is returned. The same refusals as patchAgentTs, with the subagent's
 * lines in the hint. A file that already imports and spreads its entry comes back unchanged; so
 * does one whose spread a later `model` or `modelContextWindowTokens` overrides (`shadowed`),
 * which the caller reports or refuses: adding a second spread would hide the user's choice.
 */
export function patchSubagentTs(
  source: string,
  name: string,
): SubagentTsResult {
  return patch(source, subagentPatch(name));
}

/** The literal `model` of an object's properties, if any. */
function modelOf(models: Node[]): SubagentModel {
  const last = models.at(-1);
  if (last === undefined) return { kind: "none" };
  const value = child(last, "value");
  if (last.type === "ObjectProperty" && value?.type === "StringLiteral")
    return { kind: "literal", id: str(value, "value")! };
  return { kind: "expression" };
}

function patch(
  source: string,
  want: Patch,
):
  | Refusal
  | { ok: true; text: string; model: SubagentModel; spread: SubagentSpread } {
  const refuse = (why: string) => refusal(want, why);
  let program: Node;
  try {
    const file = parse(source, {
      sourceType: "module",
      plugins: ["typescript"],
    });
    program = file.program as unknown as Node;
  } catch {
    return refuse("agent.ts could not be parsed");
  }
  const body = (program["body"] as Node[]) ?? [];

  // `defineAgent` must come from "eve" under its own name; an alias is refused, not followed.
  const imports = body.filter((n) => n.type === "ImportDeclaration");
  const fromEve = imports.some(
    (decl) =>
      child(decl, "source")?.["value"] === "eve" &&
      decl["importKind"] !== "type" &&
      ((decl["specifiers"] as Node[]) ?? []).some(
        (s) =>
          s.type === "ImportSpecifier" &&
          s["importKind"] !== "type" &&
          str(child(s, "imported") ?? s, "name") === "defineAgent" &&
          str(child(s, "local") ?? s, "name") === "defineAgent",
      ),
  );
  if (!fromEve)
    return refuse('`defineAgent` is not imported from "eve" under that name');

  let calls = 0;
  walk(program, (node) => {
    if (
      node.type === "CallExpression" &&
      child(node, "callee")?.type === "Identifier" &&
      str(child(node, "callee")!, "name") === "defineAgent"
    )
      calls++;
  });
  if (calls !== 1) return refuse(`found ${calls} defineAgent calls, not one`);

  const defaults = body.filter((n) => n.type === "ExportDefaultDeclaration");
  const call =
    defaults.length === 1 ? child(defaults[0]!, "declaration") : undefined;
  const callee = call && child(call, "callee");
  const args = (call?.["arguments"] as Node[] | undefined) ?? [];
  if (
    call?.type !== "CallExpression" ||
    callee?.type !== "Identifier" ||
    str(callee, "name") !== "defineAgent"
  )
    return refuse("there is no default-exported `defineAgent({...})` call");
  const object = args[0];
  if (args.length !== 1 || object?.type !== "ObjectExpression")
    return refuse("the defineAgent argument is not a single object literal");

  // Is the binding already imported (from the config), and is any other one of its name in the way?
  let hasImport = false;
  let conflict = false;
  for (const decl of imports) {
    for (const spec of (decl["specifiers"] as Node[]) ?? []) {
      if (str(child(spec, "local") ?? spec, "name") !== want.binding) continue;
      const proper =
        child(decl, "source")?.["value"] === want.source &&
        spec.type === "ImportSpecifier" &&
        str(child(spec, "imported") ?? spec, "name") === want.binding &&
        decl["importKind"] !== "type";
      if (proper) hasImport = true;
      else conflict = true;
    }
  }
  walk(program, (node) => {
    if (
      node.type === "VariableDeclarator" ||
      node.type === "FunctionDeclaration" ||
      node.type === "ClassDeclaration"
    ) {
      const id = child(node, "id");
      if (id?.type === "Identifier" && str(id, "name") === want.binding)
        conflict = true;
    }
  });
  if (conflict)
    return refuse(
      `agent.ts already has a different \`${want.binding}\` binding`,
    );

  const props = (object["properties"] as Node[]) ?? [];
  const at = props.findLastIndex((p) => {
    const argument = p.type === "SpreadElement" && child(p, "argument");
    return argument ? want.isSpread(argument) : false;
  });
  const hasSpread = at !== -1;
  const isProperty = (p: Node) =>
    p.type === "ObjectProperty" || p.type === "ObjectMethod";
  const own = props.filter((p) => isProperty(p) && keyName(p) === "model");
  const model = modelOf(own);
  // A subagent keeps its model, so its spread must come after it; only the root's model goes.
  const shadowed =
    !want.dropModel &&
    hasSpread &&
    props
      .slice(at + 1)
      .some((p) => isProperty(p) && ENTRY_KEYS.has(keyName(p) ?? ""));
  if (shadowed) return { ok: true, text: source, model, spread: "shadowed" };
  const spread: SubagentSpread = hasSpread ? "last" : "missing";
  const models = want.dropModel ? own : [];
  if (hasImport && hasSpread && models.length === 0)
    return { ok: true, text: source, model, spread };

  const nl = source.includes("\r\n") ? "\r\n" : "\n";
  const edits: Edit[] = [];

  // Each literal model property is removed with its own trailing comma (and its line, when it
  // has the line to itself); nothing between two of them is touched.
  const removal = (model: Node): Edit => {
    let end = model.end;
    const comma = commaAfter(source, end);
    if (comma !== -1) end = comma + 1;
    const first = lineStart(source, model.start);
    const own =
      /^[ \t]*$/.test(source.slice(first, model.start)) &&
      /^[ \t]*(?:\/\/[^\r\n]*)?\r?$/.test(
        source.slice(end, lineEnd(source, end)),
      );
    if (own) {
      const stop = lineEnd(source, end);
      return {
        start: first,
        end: Math.min(source.length, stop + (source[stop] === "\n" ? 1 : 0)),
        text: "",
      };
    }
    let stop = end;
    while (source[stop] === " " || source[stop] === "\t") stop++;
    return { start: model.start, end: stop, text: "" };
  };
  edits.push(...models.map(removal));

  if (!hasSpread) {
    const kept = props.filter((p) => !models.includes(p));
    const open = object.start + 1;
    if (kept.length === 0 && props.length > 0) {
      // Only `model` was there: the spread takes the first one's place.
      const [first, ...rest] = models;
      edits.length = 0;
      edits.push(
        { start: first!.start, end: first!.end, text: `...${want.spread}` },
        ...rest.map(removal),
      );
    } else if (kept.length === 0) {
      const inner = source.slice(open, object.end - 1);
      if (/^\s*$/.test(inner))
        edits.push({
          start: open,
          end: object.end - 1,
          text: ` ...${want.spread} `,
        });
      else edits.push({ start: open, end: open, text: ` ...${want.spread} ` });
    } else {
      const lastKept = kept[kept.length - 1]!;
      const comma = commaAfter(source, lastKept.end);
      const startsLine = /^[ \t]*$/.test(
        source.slice(lineStart(source, lastKept.start), lastKept.start),
      );
      const multiline =
        startsLine && source.slice(open, lastKept.start).includes("\n");
      let after = lastKept.end;
      if (comma !== -1) after = comma + 1;
      if (multiline) {
        const indent = source.slice(
          lineStart(source, lastKept.start),
          lastKept.start,
        );
        // Past a trailing `// comment` on the property's line, so the comment stays with it.
        const rest = /^[ \t]*(?:\/\/[^\r\n]*)?/.exec(
          source.slice(after, lineEnd(source, after)),
        )![0];
        const at = after + rest.length;
        edits.push({
          start: at,
          end: at,
          text: `${nl}${indent}...${want.spread},`,
        });
      } else {
        const trailing = comma !== -1 && lastKept === props[props.length - 1];
        edits.push({
          start: after,
          end: after,
          text:
            comma === -1 || !trailing
              ? ` ...${want.spread}`
              : ` ...${want.spread},`,
        });
      }
      // Pushed after the spread: edits at one offset apply in order, so the comma lands first.
      if (comma === -1)
        edits.push({ start: lastKept.end, end: lastKept.end, text: "," });
    }
  }

  if (!hasImport) {
    const lastImport = imports[imports.length - 1]!;
    edits.push({
      start: lastImport.end,
      end: lastImport.end,
      text: `${nl}${importLine(want)}`,
    });
  }

  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let text = source;
  let floor = Infinity;
  for (const edit of edits) {
    if (edit.end > floor) return refuse("agent.ts has overlapping edits");
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    floor = edit.start;
  }
  return { ok: true, text, model, spread };
}
