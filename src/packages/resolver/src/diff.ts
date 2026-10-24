import {
  parsePath,
  type ResolvedPersona,
  type ResolveResult,
} from "@getdonn/spec";

// What changes from one resolved persona to another, over the paths provenance already uses.
// Pure: no provider is called, and secret refs stay refs. See docs/planning/08-cli-reach.md §3.

export interface Change {
  path: string;
  change: "added" | "removed" | "changed";
  from?: unknown;
  to?: unknown;
  fromLayer?: string;
  toLayer?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value at a provenance path: keys walk objects; a final [entry] selects a keyed item. */
export function valueAt(ir: ResolvedPersona, path: string): unknown {
  const parsed = parsePath(path);
  if (!parsed) return undefined;
  let value: unknown = ir;
  for (const key of parsed.keys) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  if (parsed.entry === undefined) return value;
  if (!Array.isArray(value)) return undefined;
  return value.find((item: unknown) =>
    isRecord(item)
      ? item.id === parsed.entry || item.name === parsed.entry
      : item === parsed.entry,
  );
}

/** JSON with sorted keys, so structurally equal values compare equal. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isRecord(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}

/** Each compared path with its value and the layer that set it. */
function entries(result: ResolveResult) {
  const found = new Map<string, { value: unknown; layer: string }>();
  for (const [path, layer] of Object.entries(result.provenance)) {
    if (path.startsWith("metadata.")) continue;
    found.set(path, { value: valueAt(result.ir, path), layer });
  }
  for (const lock of result.ir.locks) {
    found.set(`locks[${lock.path}]`, { value: lock.layer, layer: lock.layer });
  }
  return found;
}

/** Every difference from `a` to `b`, sorted by path. */
export function diff(a: ResolveResult, b: ResolveResult): Change[] {
  const from = entries(a);
  const to = entries(b);
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  const changes: Change[] = [];
  for (const path of paths) {
    const before = from.get(path);
    const after = to.get(path);
    if (before === undefined) {
      changes.push({
        path,
        change: "added",
        to: after!.value,
        toLayer: after!.layer,
      });
    } else if (after === undefined) {
      changes.push({
        path,
        change: "removed",
        from: before.value,
        fromLayer: before.layer,
      });
    } else if (stable(before.value) !== stable(after.value)) {
      changes.push({
        path,
        change: "changed",
        from: before.value,
        to: after.value,
        fromLayer: before.layer,
        toLayer: after.layer,
      });
    }
  }
  return changes;
}
