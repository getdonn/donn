import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import type { ManagedManifest } from "@zzpersona/adapter-sdk";
import { CliError } from "../errors.js";

// A bundle is a folder: the policy root's files plus zzpersona/manifest.json, which lists the
// sha256 of every other file. See docs/planning/21-managed-settings.md, section 2.

export const MANIFEST_PATH = "zzpersona/manifest.json";

export const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const isMissing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/** A bundle-relative path that stays inside the folder, `/`-separated. */
export function checkedPath(path: string): string {
  const normal = posix.normalize(path);
  if (
    path.includes("\\") ||
    /^[A-Za-z]:/.test(path) ||
    posix.isAbsolute(normal) ||
    normal === ".." ||
    normal.startsWith("../") ||
    normal !== path
  ) {
    throw new CliError(
      "managed-bad-path",
      `${JSON.stringify(path)} is not a path inside the bundle`,
      { path },
    );
  }
  return path;
}

/** Refuse two paths that differ only in case: on a case-insensitive disk they are one file. */
export function checkNoCaseDuplicates(paths: Iterable<string>): void {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const key = path.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined && other !== path) {
      throw new CliError(
        "managed-bad-path",
        `${JSON.stringify(other)} and ${JSON.stringify(path)} differ only in case`,
        { path },
      );
    }
    seen.set(key, path);
  }
}

/** True when `dir` holds a zzpersona bundle (its manifest file exists). */
async function isBundle(dir: string): Promise<boolean> {
  try {
    await readFile(join(dir, ...MANIFEST_PATH.split("/")));
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/**
 * Write `files` to `dir`. A missing or empty folder is filled; a folder holding a bundle is
 * replaced; any other folder is refused. The new bundle is written beside `dir` first and
 * swapped in, so a failure never leaves half a bundle.
 */
export async function writeBundle(
  dir: string,
  files: Record<string, Uint8Array>,
): Promise<void> {
  let existing: string[] | undefined;
  try {
    existing = await readdir(dir);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const replacing = existing !== undefined && existing.length > 0;
  if (replacing && !(await isBundle(dir))) {
    throw new CliError(
      "managed-out-not-a-bundle",
      `${dir} exists and is not a zzpersona bundle; choose another --out or remove it`,
      { out: dir },
    );
  }
  checkNoCaseDuplicates(Object.keys(files));
  const parent = dirname(dir);
  const staging = join(
    parent,
    `.${basename(dir)}.tmp-${process.pid}-${Date.now()}`,
  );
  await mkdir(parent, { recursive: true });
  try {
    for (const [path, bytes] of Object.entries(files)) {
      const target = join(staging, ...checkedPath(path).split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    if (existing !== undefined) await rm(dir, { recursive: true });
    await rename(staging, dir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Read a bundle folder and check it: every file the manifest lists must exist with the listed
 * sha256. Throws naming the first mismatch. Files the manifest does not list are ignored, so
 * callers (`install`) must install only the returned `files`, never the folder's contents.
 */
export async function readBundle(dir: string): Promise<{
  files: Record<string, Uint8Array>;
  manifest: ManagedManifest;
}> {
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(join(dir, ...MANIFEST_PATH.split("/")));
  } catch (error) {
    if (isMissing(error)) {
      throw new CliError(
        "managed-not-a-bundle",
        `${dir} is not a zzpersona bundle: ${MANIFEST_PATH} is missing`,
        { dir },
      );
    }
    throw error;
  }
  let manifest: ManagedManifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8")) as ManagedManifest;
  } catch {
    throw new CliError(
      "managed-bad-manifest",
      `${MANIFEST_PATH} in ${dir} is not valid JSON`,
      { dir },
    );
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    manifest.format !== 1 ||
    typeof manifest.files !== "object" ||
    manifest.files === null
  ) {
    throw new CliError(
      "managed-bad-manifest",
      `${MANIFEST_PATH} in ${dir} is not a format 1 manifest`,
      { dir },
    );
  }
  checkNoCaseDuplicates(Object.keys(manifest.files));
  const files: Record<string, Uint8Array> = {
    [MANIFEST_PATH]: new Uint8Array(manifestBytes),
  };
  for (const [path, expected] of Object.entries(manifest.files)) {
    checkedPath(path);
    let bytes: Buffer;
    try {
      bytes = await readFile(join(dir, ...path.split("/")));
    } catch (error) {
      if (isMissing(error)) {
        throw new CliError(
          "managed-bundle-mismatch",
          `${path} is listed in the manifest but missing from ${dir}`,
          { path },
        );
      }
      throw error;
    }
    if (sha256(bytes) !== expected) {
      throw new CliError(
        "managed-bundle-mismatch",
        `${path} does not match its digest in the manifest of ${dir}`,
        { path },
      );
    }
    files[path] = new Uint8Array(bytes);
  }
  return { files, manifest };
}
