import { randomBytes } from "node:crypto";
import { readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isContainedPath, type Step } from "@zzpersona/adapter-sdk";
import { ExecutorError } from "./errors.js";

// Writes an overlay step into a project: the whole file, or, with `block`, the text between
// `<!-- <block>:begin … -->` and `<!-- <block>:end -->`, leaving everything else byte for byte.
// See docs/planning/11-agents-md.md, section 2.

export type OverlayStep = Extract<Step, { kind: "overlay" }>;
export type OverlayMode = "write" | "check" | "remove";
export type OverlayStatus =
  "created" | "updated" | "unchanged" | "removed" | "stale";

/** The file's markers are not exactly one begin followed by one end. */
export class OverlayMarkersError extends ExecutorError {
  override name = "OverlayMarkersError";
  constructor(
    readonly path: string,
    readonly line: number,
    message: string,
  ) {
    super(`${path}:${line}: ${message}`);
  }
}

interface Line {
  text: string;
  /** The line including its terminator. */
  raw: string;
}

const splitLines = (text: string): Line[] =>
  (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((raw) => ({
    raw,
    text: raw.replace(/\r?\n$/, ""),
  }));

/** Where the block is: undefined when the file has no markers. */
function findBlock(
  path: string,
  lines: Line[],
  block: string,
): { begin: number; end: number } | undefined {
  const begins: number[] = [];
  const ends: number[] = [];
  lines.forEach(({ text }, i) => {
    const line = text.trim();
    if (line.startsWith(`<!-- ${block}:begin`) && line.endsWith("-->"))
      begins.push(i);
    else if (line === `<!-- ${block}:end -->`) ends.push(i);
  });
  if (begins.length === 0 && ends.length === 0) return undefined;
  const fail = (i: number, why: string): never => {
    throw new OverlayMarkersError(path, i + 1, why);
  };
  if (begins.length > 1) fail(begins[1]!, `a second ${block} block`);
  if (ends.length > 1) fail(ends[1]!, `a second ${block}:end marker`);
  if (begins.length === 0)
    fail(ends[0]!, `${block}:end without ${block}:begin`);
  if (ends.length === 0)
    fail(begins[0]!, `${block}:begin without ${block}:end`);
  if (ends[0]! < begins[0]!)
    fail(ends[0]!, `${block}:end before ${block}:begin`);
  return { begin: begins[0]!, end: ends[0]! };
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Atomic, and through a symlink to its target, so a linked file stays linked. */
async function writeThrough(path: string, content: string): Promise<void> {
  const target = await realpath(path).catch(() => path);
  const tmp = join(
    dirname(target),
    `.zzpersona-${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    await writeFile(tmp, content);
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** The file with the block merged in (spec §2), or the file with it removed. */
function merge(
  path: string,
  current: string | undefined,
  step: OverlayStep & { block: string },
  remove: boolean,
): string | undefined {
  const text = current ?? "";
  const lines = splitLines(text);
  const eol = lines[0]?.raw.endsWith("\r\n") ? "\r\n" : "\n";
  const found = findBlock(path, lines, step.block);
  const body = step.content.replace(/\r?\n$/, "").split(/\r?\n/);
  const blockLines = [
    `<!-- ${step.block}:begin — generated; edit the source, not this block -->`,
    ...(body.length === 1 && body[0] === "" ? [] : body),
    `<!-- ${step.block}:end -->`,
  ];
  if (remove) {
    if (!found) return current;
    let from = found.begin;
    // The blank line `write` put before an appended block goes with it.
    if (from > 0 && lines[from - 1]!.text.trim() === "") from -= 1;
    const rest = [...lines.slice(0, from), ...lines.slice(found.end + 1)]
      .map((l) => l.raw)
      .join("");
    return rest.trim() === "" ? undefined : rest;
  }
  const rendered = blockLines.join(eol);
  if (!found) {
    if (text === "") return `${rendered}${eol}`;
    const separator = text.endsWith("\n") ? eol : `${eol}${eol}`;
    return `${text}${separator}${rendered}${eol}`;
  }
  const endLine = lines[found.end]!;
  const terminator = endLine.raw.slice(endLine.text.length);
  return [
    ...lines.slice(0, found.begin).map((l) => l.raw),
    `${rendered}${terminator}`,
    ...lines.slice(found.end + 1).map((l) => l.raw),
  ].join("");
}

export async function applyOverlay(
  step: OverlayStep,
  root: string,
  options: { mode: OverlayMode },
): Promise<{ path: string; status: OverlayStatus }> {
  if (!isContainedPath(step.path)) {
    throw new ExecutorError(`overlay path ${step.path} is outside the project`);
  }
  const path = join(root, step.path);
  const current = await readIfPresent(path);
  const { mode } = options;
  const next =
    step.block === undefined
      ? mode === "remove"
        ? undefined
        : step.content
      : merge(path, current, { ...step, block: step.block }, mode === "remove");

  if (mode === "check") {
    return { path, status: next === current ? "unchanged" : "stale" };
  }
  if (next === current) return { path, status: "unchanged" };
  if (next === undefined) {
    // A symlinked file loses the link, never the shared file it points at.
    await rm(path, { force: true });
    return { path, status: "removed" };
  }
  await writeThrough(path, next);
  if (mode === "remove") return { path, status: "removed" };
  return { path, status: current === undefined ? "created" : "updated" };
}
