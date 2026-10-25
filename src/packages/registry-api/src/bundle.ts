import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Hook, Persona } from "@getdonn/spec";
import type { BundleFile } from "./schemas.js";

export const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;

const sha256 = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

/** A bundle path as hashed and stored: a leading `./` stripped, then `posix.normalize`. */
export const normalizeBundlePath = (path: string): string =>
  posix.normalize(path.startsWith("./") ? path.slice(2) : path);

/**
 * The bundle digest, version 1: `sha256:` plus the hex sha256 of this UTF-8 text.
 *
 *     donn-bundle/1\n
 *     layer.yaml <sha256hex(UTF-8 bytes of source)>\n
 *     <path> <sha256hex(decoded file bytes)>\n        (one line per file)
 *
 * Paths are normalised first (see `normalizeBundlePath`) and the file lines are sorted by the
 * UTF-8 bytes of the normalised path, so file order and a leading `./` never change the digest.
 * Paths with control characters are refused at publish, so a line never contains a newline.
 */
export function bundleDigest(source: string, files: BundleFile[]): string {
  const lines = files
    .map(({ path, content }) => ({
      path: Buffer.from(normalizeBundlePath(path)),
      hash: sha256(Buffer.from(content, "base64")),
    }))
    .sort((a, b) => Buffer.compare(a.path, b.path))
    .map(({ path, hash }) => `${path.toString("utf8")} ${hash}\n`);
  const text = `donn-bundle/1\nlayer.yaml ${sha256(source)}\n${lines.join("")}`;
  return `sha256:${sha256(text)}`;
}

/**
 * The files and folders a layer points at, relative to the layer's folder: instruction files,
 * local skill folders, hook scripts (every `run` is a path, as in the resolver) and path
 * agent templates (folders). Skills containing `://` are
 * skipped. Paths are normalised but not checked; callers refuse the ones that escape.
 */
export function referencedPaths(doc: Persona): {
  files: string[];
  dirs: string[];
} {
  const files: string[] = [];
  const dirs: string[] = [];
  for (const fragment of doc.instructions ?? []) {
    if ("file" in fragment) files.push(normalizeBundlePath(fragment.file));
  }
  for (const skill of doc.skills?.include ?? []) {
    if (!skill.includes("://")) dirs.push(normalizeBundlePath(skill));
  }
  for (const [event, hooks] of Object.entries(doc.hooks ?? {})) {
    if (event === "remove") continue;
    for (const hook of hooks as Hook[])
      files.push(normalizeBundlePath(hook.run));
  }
  for (const agent of Object.values(doc.agents?.define ?? {})) {
    if (!agent.template.startsWith("eve:"))
      dirs.push(normalizeBundlePath(agent.template));
  }
  return { files, dirs };
}
