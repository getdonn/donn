import { createHash } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { manifestFiles } from "@getdonn/adapter-eve";
import { isContainedPath, type AgentCompileOutput } from "@getdonn/adapter-sdk";
import { AgentTarget, AgentWorld } from "@getdonn/spec";
import type { LocalStore } from "@getdonn/store-local";
import { z } from "zod";
import { CliError } from "../errors.js";
import { fsStep, writeFileAtomic } from "../fs.js";

// donn's files in an agent directory and the ownership manifest that records them
// (`<dir>/.donn/agent.json`). See docs/planning/24-adapter-eve.md, section 4. Shared by
// `create` and `sync`.

export const MANIFEST_FILE = ".donn/agent.json";

export const Manifest = z.object({
  agent: z.string(),
  persona: z.string(),
  adapter: z.string(),
  frameworkVersion: z.string(),
  template: z.string(),
  target: AgentTarget,
  /** Project-relative, as the persona says. */
  path: z.string(),
  world: AgentWorld.optional(),
  /** donn-owned files: agent-directory path → `sha256:<hex>`. */
  files: z.record(z.string(), z.string()),
  /** `patched`: the template's agent.ts, edited once; `created`: donn wrote it. */
  agentTs: z.enum(["patched", "created"]).optional(),
  /** Files outside `files` that donn created or edited once (template- or user-owned after). */
  edits: z.array(z.string()),
  /** `incomplete` from materialising until every step of `create` finished. */
  state: z.enum(["incomplete", "complete"]),
});
export type Manifest = z.infer<typeof Manifest>;

export async function readManifest(dir: string): Promise<Manifest | undefined> {
  const file = join(dir, MANIFEST_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  const parsed = Manifest.safeParse(raw);
  if (!parsed.success) {
    throw new CliError(
      "invalid-manifest",
      `${file} is not a donn agent manifest`,
      { file },
    );
  }
  return parsed.data;
}

export async function writeManifest(dir: string, m: Manifest): Promise<void> {
  const file = join(dir, MANIFEST_FILE);
  await fsStep(file, () =>
    writeFileAtomic(file, `${JSON.stringify(m, null, 2)}\n`),
  );
}

const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/**
 * Every file below `dir` (regular, or a link to one), as sorted POSIX paths relative to it. A
 * directory whose relative path `skip` accepts is not entered.
 */
export async function listFiles(
  dir: string,
  skip: (path: string) => boolean = () => false,
): Promise<string[]> {
  const out: string[] = [];
  const visit = async (at: string) => {
    let entries;
    try {
      entries = await readdir(join(dir, at), { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }
    for (const entry of entries) {
      const path = at === "" ? entry.name : `${at}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!skip(path)) await visit(path);
      } else if (entry.isFile()) out.push(path);
      // A link to a file counts as the file; a linked folder is not entered.
      else if (entry.isSymbolicLink()) {
        const target = await stat(join(dir, path)).catch(() => undefined);
        if (target?.isFile()) out.push(path);
      }
    }
  };
  await visit("");
  return out.sort();
}

const unsafe = (path: string) =>
  new CliError(
    "unsafe-path",
    `the compile wrote ${path}, which is outside the agent directory`,
    { path },
  );

/** The files of a `copyFrom` directory, each checked to resolve inside its mount. */
async function copySource(
  store: Pick<LocalStore, "locate">,
  copyFrom: string,
): Promise<{ path: string; files: string[] }> {
  const location = store.locate(copyFrom);
  if (!location) {
    throw new CliError(
      "filesystem",
      `${copyFrom} is not inside any configured location`,
      { path: copyFrom },
    );
  }
  const realRoot = await realpath(location.root);
  const contained = async (path: string) => {
    const real = await realpath(path);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new CliError(
        "unsafe-path",
        `${copyFrom} resolves outside its location (${real} is outside ${realRoot})`,
        { path: copyFrom },
      );
    }
  };
  await fsStep(location.path, () => contained(location.path));
  const files = (await stat(location.path)).isDirectory()
    ? await listFiles(location.path)
    : [];
  for (const file of files) await contained(join(location.path, file));
  return { path: location.path, files };
}

/** Removes `path`'s empty parent directories, up to (not including) `dir`. */
async function pruneEmpty(dir: string, path: string): Promise<void> {
  for (let at = dirname(path); at !== dir && at.startsWith(dir + sep);) {
    try {
      await rmdir(at);
    } catch {
      return; // Not empty, or already gone.
    }
    at = dirname(at);
  }
}

/** A file's `sha256:<hex>` hash, or undefined when it is not there; any other read error stops. */
async function diskHash(
  dir: string,
  path: string,
): Promise<string | undefined> {
  const target = join(dir, path);
  const data = await fsStep(target, () =>
    readFile(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }),
  );
  return data === undefined ? undefined : `sha256:${sha256(data)}`;
}

export interface PlannedFiles {
  /** The manifest's `files` after a write: one hash per file, a copied directory expanded. */
  files: Record<string, string>;
  /** The files of each copied directory, with their content. */
  copies: { path: string; data: Buffer; mode: number }[];
}

/** What a compile's files come to on disk, without writing: see `writeAgentFiles`. */
export async function planFiles(
  output: AgentCompileOutput,
  store: Pick<LocalStore, "locate">,
): Promise<PlannedFiles> {
  for (const path of Object.keys(output.files))
    if (!isContainedPath(path)) throw unsafe(path);
  const files = manifestFiles(output.files, sha256);
  const copies: PlannedFiles["copies"] = [];
  for (const [path, entry] of Object.entries(output.files)) {
    if ("content" in entry) continue;
    // A copied directory: one manifest entry per file.
    const source = await copySource(store, entry.copyFrom);
    delete files[path];
    for (const file of source.files) {
      const from = join(source.path, file);
      const data = await readFile(from);
      const mode = entry.mode ?? (await stat(from)).mode & 0o777;
      copies.push({ path: `${path}/${file}`, data, mode });
      files[`${path}/${file}`] = `sha256:${sha256(data)}`;
    }
  }
  return {
    files: Object.fromEntries(
      Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    copies,
  };
}

/**
 * What writing `planned` over `dir` would change: the files whose content differs or is
 * missing, and the previously owned files it would remove.
 */
export async function pendingChanges(
  dir: string,
  planned: PlannedFiles,
  previous: Manifest | undefined,
): Promise<{ written: string[]; removed: string[] }> {
  const written: string[] = [];
  for (const [path, hash] of Object.entries(planned.files))
    if ((await diskHash(dir, path)) !== hash) written.push(path);
  const removed: string[] = [];
  for (const path of Object.keys(previous?.files ?? {})) {
    if (path in planned.files || !isContainedPath(path)) continue;
    if (await lstat(join(dir, path)).catch(() => undefined)) removed.push(path);
  }
  return { written, removed };
}

/**
 * Writes a compile's files into `dir` by the manifest's rules: an owned file whose hash no
 * longer matches `previous` stops with `owned-file-edited` (unless `force`); files the new
 * compile no longer produces are removed; each `copyFrom` directory is copied and recorded as
 * one hash per file. Returns the manifest's new `files`.
 */
export async function writeAgentFiles(
  dir: string,
  output: AgentCompileOutput,
  previous: Manifest | undefined,
  options: { force: boolean; store: Pick<LocalStore, "locate"> },
): Promise<Record<string, string>> {
  const planned = await planFiles(output, options.store);
  const old = previous?.files ?? {};
  const edited: string[] = [];
  for (const [path, hash] of Object.entries(old)) {
    if (!isContainedPath(path)) throw unsafe(path);
    // Gone is fine: nothing of the user's to lose. Any other read error stops.
    const now = await diskHash(dir, path);
    if (now !== undefined && now !== hash) edited.push(path);
  }
  if (edited.length > 0 && !options.force) {
    throw new CliError(
      "owned-file-edited",
      `donn owns ${edited.join(", ")}, which ${edited.length === 1 ? "was" : "were"} edited since donn wrote ${edited.length === 1 ? "it" : "them"}; move the change into the persona, or pass --force to overwrite`,
      { files: edited, fix: "move the change into the persona, or --force" },
    );
  }

  for (const [path, entry] of Object.entries(output.files)) {
    if (!("content" in entry)) continue;
    const target = join(dir, path);
    await fsStep(target, () =>
      writeFileAtomic(target, entry.content, entry.mode ?? 0o644),
    );
  }
  for (const copy of planned.copies) {
    const to = join(dir, copy.path);
    await fsStep(to, () => writeFileAtomic(to, copy.data, copy.mode));
  }
  for (const path of Object.keys(old)) {
    if (path in planned.files) continue;
    const target = join(dir, path);
    if (!(await lstat(target).catch(() => undefined))) continue;
    await fsStep(target, () => rm(target, { force: true }));
    await pruneEmpty(dir, target);
  }
  return planned.files;
}

/** A path relative to `dir`, POSIX-style. */
export const posixRelative = (dir: string, path: string) =>
  relative(dir, path).split(sep).join("/");
