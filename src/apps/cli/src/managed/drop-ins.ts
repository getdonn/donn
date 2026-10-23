import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

// How Claude Code layers the policy files: managed-settings.json first, then every *.json in
// managed-settings.d/ by name; a later single value replaces an earlier one, lists combine.
// `check` asks which later files replace our values; `install` and `check` which earlier values
// ours replace. See docs/planning/21-managed-settings.md, section 3, and amendment 16.

export const SETTINGS_PATH = "managed-settings.d/50-zzpersona.json";
const DROP_INS = "managed-settings.d";
const OUR_NAME = SETTINGS_PATH.split("/")[1]!;

export const asObject = (
  value: unknown,
): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export async function readJson(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return asObject(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

/** Every single (non-list) value in `value`, as [dotted path, value]. */
export function singleValues(
  value: Record<string, unknown>,
  prefix: string[] = [],
): [string[], unknown][] {
  return Object.entries(value).flatMap(([key, v]): [string[], unknown][] => {
    const path = [...prefix, key];
    if (Array.isArray(v)) return []; // lists combine across files
    const nested = asObject(v);
    return nested ? singleValues(nested, path) : [[path, v]];
  });
}

/** Whether `other` holds a different value at `path` than `ours` (meeting either replaces the other). */
export function replaces(
  other: Record<string, unknown>,
  path: string[],
  ours: unknown,
): boolean {
  let at: unknown = other;
  for (const key of path) {
    const object = asObject(at);
    if (object === undefined) return true; // a single value where we have a block
    if (!Object.hasOwn(object, key)) return false;
    at = object[key];
  }
  return !isDeepStrictEqual(at, ours);
}

/** The policy files Claude Code reads before ours (`before`) or after it, root-relative, in order. */
export async function policyFiles(
  root: string,
  when: "before" | "after",
): Promise<string[]> {
  const names = (
    await readdir(join(root, DROP_INS)).catch(() => [] as string[])
  )
    .filter(
      (n) =>
        n.endsWith(".json") &&
        !n.startsWith(".") &&
        (when === "before" ? n < OUR_NAME : n > OUR_NAME),
    )
    .sort()
    .map((n) => `${DROP_INS}/${n}`);
  return when === "before" ? ["managed-settings.json", ...names] : names;
}

/** For each `files` entry, the single values of `ours` it holds differently, as [file, key]. */
export async function differing(
  root: string,
  files: string[],
  ours: Record<string, unknown>,
): Promise<{ file: string; key: string }[]> {
  const values = singleValues(ours);
  const found: { file: string; key: string }[] = [];
  for (const file of files) {
    const other = await readJson(join(root, ...file.split("/")));
    if (other === undefined) continue;
    for (const [path, value] of values) {
      if (replaces(other, path, value))
        found.push({ file, key: path.join(".") });
    }
  }
  return found;
}

/** The single values in files read before ours that ours replaces (nothing says so otherwise). */
export async function earlierReplaced(
  root: string,
  ours: Record<string, unknown>,
): Promise<{ key: string; file: string }[]> {
  return differing(root, await policyFiles(root, "before"), ours);
}
