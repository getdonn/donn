import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, posix, sep } from "node:path";
import { parse } from "yaml";
import {
  LayerRef,
  MAX_BUNDLE_BYTES,
  normalizeBundlePath,
  referencedPaths,
  type BundleFile,
} from "@getdonn/registry-api";
import { PersonaDocument } from "@getdonn/spec";
import type { LocalStore } from "@getdonn/store-local";
import { RegistryError } from "./error.js";

const isMissing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

const inside = (real: string, root: string) =>
  real === root || real.startsWith(root + sep);

/**
 * The layer's YAML and every file it references, read from the local store (never the cache),
 * ready to publish. Skill folders are walked recursively. Every file's realpath must stay inside
 * the layer's folder: a symlink pointing out is `path-escapes-layer`, before anything is sent.
 */
export async function bundleLayer(
  local: LocalStore,
  ref: string,
): Promise<{ source: string; files: BundleFile[] }> {
  if (!LayerRef.safeParse(ref).success) {
    if (/^(project|user)\//.test(ref)) {
      throw new RegistryError(
        "not-publishable",
        `${ref} cannot be published: only org, area and team layers can`,
      );
    }
    throw new RegistryError("invalid", `${ref} is not a layer ref`);
  }
  const location = local.locate(`${ref}.yaml`);
  if (location === undefined) {
    throw new RegistryError(
      "not-found",
      `${ref} is not in a configured personas folder`,
    );
  }
  let source: string;
  try {
    source = await readFile(location.path, "utf8");
  } catch (error) {
    if (isMissing(error))
      throw new RegistryError("not-found", `${ref} has no local file`);
    throw error;
  }
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (error) {
    throw new RegistryError(
      "invalid",
      `${ref}: YAML does not parse: ${(error as Error).message}`,
    );
  }
  const parsed = PersonaDocument.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new RegistryError("invalid", `${ref}: ${issues}`);
  }
  if (parsed.data.kind !== "Persona") {
    throw new RegistryError("invalid", `${ref}: expected kind: Persona`);
  }

  const folder = dirname(location.path);
  const realFolder = await realpath(folder);
  const { files: filePaths, dirs: dirPaths } = referencedPaths(parsed.data);

  for (const path of [...filePaths, ...dirPaths]) {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(path)) {
      throw new RegistryError(
        "invalid",
        `${ref}: a referenced path contains a control character: ${JSON.stringify(path)}`,
      );
    }
    if (posix.isAbsolute(path) || path === ".." || path.startsWith("../")) {
      throw new RegistryError(
        "path-escapes-layer",
        `${ref}: ${path} is outside the layer's folder`,
      );
    }
  }

  let total = Buffer.byteLength(source);
  const found = new Map<string, Buffer>();
  const tooLarge = () =>
    new RegistryError(
      "bundle-too-large",
      `${ref}: the bundle is over ${MAX_BUNDLE_BYTES} bytes`,
    );
  if (total > MAX_BUNDLE_BYTES) throw tooLarge();

  /** Read one file after checking where its realpath lands. */
  const take = async (path: string, physical: string): Promise<void> => {
    const real = await realpath(physical);
    if (!inside(real, realFolder)) {
      throw new RegistryError(
        "path-escapes-layer",
        `${ref}: ${path} points outside the layer's folder`,
      );
    }
    const size = (await stat(real)).size;
    total += size;
    if (total > MAX_BUNDLE_BYTES) throw tooLarge();
    found.set(normalizeBundlePath(path), await readFile(real));
  };

  const missing = (path: string, what = "") =>
    new RegistryError(
      "missing-file",
      `${ref}: ${path}${what} is referenced but missing`,
    );

  const walk = async (
    path: string,
    physical: string,
    seen: Set<string>,
  ): Promise<void> => {
    const real = await realpath(physical);
    if (!inside(real, realFolder)) {
      throw new RegistryError(
        "path-escapes-layer",
        `${ref}: ${path} points outside the layer's folder`,
      );
    }
    if (seen.has(real)) return;
    seen.add(real);
    for (const entry of (await readdir(real)).sort()) {
      const child = join(real, entry);
      const childPath = `${path}/${entry}`;
      if ((await stat(child)).isDirectory()) await walk(childPath, child, seen);
      else await take(childPath, child);
    }
  };

  for (const path of filePaths) {
    const physical = join(folder, ...path.split("/"));
    try {
      await take(path, physical);
    } catch (error) {
      if (isMissing(error)) throw missing(path);
      throw error;
    }
  }
  for (const path of dirPaths) {
    const physical = join(folder, ...path.split("/"));
    const before = found.size;
    try {
      if ((await stat(physical)).isDirectory())
        await walk(path, physical, new Set());
      else await take(path, physical);
    } catch (error) {
      if (isMissing(error)) throw missing(path, "/");
      throw error;
    }
    if (found.size === before) throw missing(path, "/");
  }

  const files = [...found.entries()]
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(([path, bytes]) => ({ path, content: bytes.toString("base64") }));
  return { source, files };
}
