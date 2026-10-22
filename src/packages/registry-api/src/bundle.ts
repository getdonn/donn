import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Persona } from "@zzpersona/spec";
import type { BundleFile } from "./schemas.js";

export const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;

/**
 * The sha256 of the canonical manifest: the YAML and the files sorted by path. File order in the
 * request never changes the digest.
 */
export function bundleDigest(source: string, files: BundleFile[]): string {
  const sorted = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path, content }) => ({ path, content }));
  const manifest = JSON.stringify({ source, files: sorted });
  return `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
}

const isUrl = (value: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(value);

const relative = (path: string): string =>
  posix.normalize(path.startsWith("./") ? path.slice(2) : path);

/**
 * The files and folders a layer points at, relative to the layer's folder: instruction files,
 * local skill folders and hook scripts (`run` values starting `./`). URLs and registry skills are
 * skipped. Paths are normalised but not checked; callers refuse the ones that escape.
 */
export function referencedPaths(doc: Persona): {
  files: string[];
  dirs: string[];
} {
  const files: string[] = [];
  const dirs: string[] = [];
  for (const fragment of doc.instructions ?? []) {
    if ("file" in fragment) files.push(relative(fragment.file));
  }
  for (const skill of doc.skills?.include ?? []) {
    if (!isUrl(skill)) dirs.push(relative(skill));
  }
  for (const hooks of Object.values(doc.hooks ?? {})) {
    if (!Array.isArray(hooks)) continue;
    for (const hook of hooks) {
      if (typeof hook !== "string" && hook.run.startsWith("./"))
        files.push(relative(hook.run));
    }
  }
  return { files, dirs };
}
