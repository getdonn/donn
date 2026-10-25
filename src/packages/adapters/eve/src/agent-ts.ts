import { parse } from "@babel/parser";

// The one-time edit to a template's `agent.ts`: import `donn` and spread it as the last property
// of the `defineAgent({...})` call, dropping a literal `model`. See
// docs/planning/24-adapter-eve.md, section 2. The edit is by source spans, never a re-print, so
// everything outside the edited spans is byte-identical. The parser only locates; it never prints.

const IMPORT_LINE = 'import { donn } from "./lib/donn/config";';
const CONFIG_SOURCE = "./lib/donn/config";

export type AgentTsResult =
  | { ok: true; text: string }
  | { ok: false; code: "agent-ts-unrecognised"; hint: string };

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

const refuse = (why: string): AgentTsResult => ({
  ok: false,
  code: "agent-ts-unrecognised",
  hint: `${why}. Add \`${IMPORT_LINE}\` to agent.ts and put \`...donn\` as the last property of the defineAgent({...}) call, removing any \`model\` property`,
});

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

  // Is `donn` already imported (from the config), and is any other `donn` binding in the way?
  let hasImport = false;
  let conflict = false;
  for (const decl of imports) {
    for (const spec of (decl["specifiers"] as Node[]) ?? []) {
      if (str(child(spec, "local") ?? spec, "name") !== "donn") continue;
      const proper =
        child(decl, "source")?.["value"] === CONFIG_SOURCE &&
        spec.type === "ImportSpecifier" &&
        str(child(spec, "imported") ?? spec, "name") === "donn" &&
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
      if (id?.type === "Identifier" && str(id, "name") === "donn")
        conflict = true;
    }
  });
  if (conflict)
    return refuse("agent.ts already has a different `donn` binding");

  const props = (object["properties"] as Node[]) ?? [];
  const hasSpread = props.some(
    (p) =>
      p.type === "SpreadElement" &&
      child(p, "argument")?.type === "Identifier" &&
      str(child(p, "argument")!, "name") === "donn",
  );
  const models = props.filter(
    (p) =>
      (p.type === "ObjectProperty" || p.type === "ObjectMethod") &&
      keyName(p) === "model",
  );
  if (hasImport && hasSpread && models.length === 0)
    return { ok: true, text: source };

  const nl = source.includes("\r\n") ? "\r\n" : "\n";
  const edits: Edit[] = [];

  // Remove each literal model property with its trailing comma.
  for (const model of models) {
    let end = model.end;
    const comma = commaAfter(source, end);
    if (comma !== -1) end = comma + 1;
    const first = lineStart(source, model.start);
    const own =
      /^[ \t]*$/.test(source.slice(first, model.start)) &&
      /^[ \t]*(?:\/\/[^\n]*)?\r?$/.test(
        source.slice(end, lineEnd(source, end)),
      );
    if (own) {
      const stop = lineEnd(source, end);
      edits.push({
        start: first,
        end: Math.min(source.length, stop + (source[stop] === "\n" ? 1 : 0)),
        text: "",
      });
    } else {
      let stop = end;
      while (source[stop] === " " || source[stop] === "\t") stop++;
      edits.push({ start: model.start, end: stop, text: "" });
    }
  }

  if (!hasSpread) {
    const kept = props.filter((p) => !models.includes(p));
    const open = object.start + 1;
    if (kept.length === 0 && props.length > 0) {
      // Only `model` was there: the spread takes its place (the line edit above is replaced).
      edits.length = 0;
      const lastProp = props[props.length - 1]!;
      edits.push({
        start: props[0]!.start,
        end: lastProp.end,
        text: "...donn",
      });
    } else if (kept.length === 0) {
      const inner = source.slice(open, object.end - 1);
      if (/^\s*$/.test(inner))
        edits.push({ start: open, end: object.end - 1, text: " ...donn " });
      else edits.push({ start: open, end: open, text: " ...donn " });
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
        const rest = /^[ \t]*(?:\/\/[^\n]*)?/.exec(
          source.slice(after, lineEnd(source, after)),
        )![0];
        const at = after + rest.length;
        edits.push({ start: at, end: at, text: `${nl}${indent}...donn,` });
      } else {
        const trailing = comma !== -1 && lastKept === props[props.length - 1];
        edits.push({
          start: after,
          end: after,
          text: comma === -1 || !trailing ? " ...donn" : " ...donn,",
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
      text: `${nl}${IMPORT_LINE}`,
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
  return { ok: true, text };
}
