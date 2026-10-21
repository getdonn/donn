import { HOOK_EVENTS } from "./common.js";

// Paths name a value inside a persona or the IR. Used by locks, provenance, warnings and errors.
//
//   mcp.gateway                       dotted keys into objects
//   permissions.deny[Bash(rm -rf:*)]  a final [entry] selects one item of a keyed list or set
//
// The entry may contain dots and parentheses (permission rules do), so it is always the last
// segment and everything between the first "[" and the final "]" belongs to it.

export interface PersonaPath {
  keys: string[];
  entry?: string;
}

export function parsePath(path: string): PersonaPath | undefined {
  const bracket = path.indexOf("[");
  const head = bracket === -1 ? path : path.slice(0, bracket);
  const keys = head.split(".");
  if (keys.some((key) => key === "" || /[\s\]]/.test(key))) return undefined;
  if (bracket === -1) return { keys };
  if (!path.endsWith("]")) return undefined;
  const entry = path.slice(bracket + 1, -1);
  return entry === "" ? undefined : { keys, entry };
}

export function formatPath({ keys, entry }: PersonaPath): string {
  return entry === undefined ? keys.join(".") : `${keys.join(".")}[${entry}]`;
}

const EVENTS: ReadonlySet<string> = new Set(HOOK_EVENTS);
const RULE_LISTS: ReadonlySet<string> = new Set(["allow", "deny", "ask"]);

/** Whether a lock path names something a lock can protect. Typos must not silently lock nothing. */
export function isValidLockPath(path: string): boolean {
  const parsed = parsePath(path);
  if (!parsed) return false;
  const { keys, entry } = parsed;
  const [root, second] = keys;
  const depth = keys.length;
  const hasEntry = entry !== undefined;

  switch (root) {
    case "instructions":
    case "skills":
    case "knowledge":
      return depth === 1;
    case "metadata":
      return !hasEntry && second === "labels" && depth <= 3;
    case "mcp":
      if (hasEntry) return false;
      if (depth === 1) return true;
      if (second === "gateway") return depth === 2;
      return second === "servers" && depth <= 3;
    case "permissions":
      return depth === 1 ? !hasEntry : depth === 2 && RULE_LISTS.has(second!);
    case "hooks":
      return depth === 1 ? !hasEntry : depth === 2 && EVENTS.has(second!);
    case "secrets":
      return (
        !hasEntry && (depth === 1 || (second === "providers" && depth <= 3))
      );
    case "targets":
      return !hasEntry;
    default:
      return false;
  }
}
