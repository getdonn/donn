import { randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { z } from "zod";
import {
  LayerRef,
  bundleDigest,
  normalizeBundlePath,
  type LayerVersion,
} from "@zzpersona/registry-api";
import type { RegistryClient } from "./client.js";
import { RegistryError } from "./error.js";

// ~/.zzpersona/cache/registry/<ref>/<version>/ holds layer.yaml and the bundled files; index.json
// names the current version of each ref. See docs/planning/18-registry-contract.md section 3.

export interface CacheIndex {
  url: string;
  pulledAt: string;
  layers: Record<string, { version: number; digest: string }>;
}

/** `to` undefined: the ref was removed; `from` undefined: it is new. */
export interface PullChange {
  ref: string;
  from?: number;
  to?: number;
}

const CacheIndexSchema = z.object({
  url: z.string(),
  pulledAt: z.string(),
  layers: z.record(
    z.string(),
    z.object({ version: z.int().min(1), digest: z.string() }),
  ),
});

const cacheRoot = (home: string) => join(home, "cache", "registry");
const indexPath = (home: string) => join(cacheRoot(home), "index.json");

export const cacheFolder = (
  home: string,
  ref: string,
  version: number,
): string => join(cacheRoot(home), ...ref.split("/"), String(version));

/** The index, or undefined when there is none or it cannot be read (the next pull rebuilds it). */
export async function readIndex(home: string): Promise<CacheIndex | undefined> {
  try {
    return CacheIndexSchema.parse(
      JSON.parse(await readFile(indexPath(home), "utf8")),
    ) as CacheIndex;
  } catch {
    return undefined;
  }
}

/** Write to a temp file in the same folder, then rename: readers see the old file or the new. */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, content);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

const protocol = (message: string) =>
  new RegistryError("registry-protocol", message);

/** A version's files into `dir`: layer.yaml, then each bundle file. Unsafe paths are refused. */
async function writeVersion(dir: string, version: LayerVersion): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "layer.yaml"), version.source);
  for (const { path, content } of version.files) {
    const clean = normalizeBundlePath(path);
    if (
      posix.isAbsolute(clean) ||
      clean === ".." ||
      clean.startsWith("../") ||
      clean === "layer.yaml"
    ) {
      throw protocol(`${version.ref}: the registry sent an unsafe path`);
    }
    const target = join(dir, ...clean.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(content, "base64"));
  }
}

/** Move a finished folder into place, replacing a leftover one from an interrupted pull. */
async function install(tmp: string, target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await rename(tmp, target);
}

/** Every `<ref>/<version>` folder under the cache, found by their layer.yaml. */
async function versionFolders(
  home: string,
): Promise<{ ref: string; version: number; path: string }[]> {
  const root = cacheRoot(home);
  const found: { ref: string; version: number; path: string }[] = [];
  const walk = async (dir: string, segments: string[]): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "layer.yaml")) {
      const version = Number(segments.at(-1));
      const ref = segments.slice(0, -1).join("/");
      if (Number.isInteger(version) && LayerRef.safeParse(ref).success) {
        found.push({ ref, version, path: dir });
      }
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        await walk(join(dir, entry.name), [...segments, entry.name]);
      }
    }
  };
  await walk(root, []);
  return found;
}

/** Remove version folders the index does not name, then folders left empty. */
async function prune(home: string, index: CacheIndex): Promise<void> {
  for (const { ref, version, path } of await versionFolders(home)) {
    if (index.layers[ref]?.version === version) continue;
    await rm(path, { recursive: true, force: true });
    // Walk up while the parent is an empty ref folder.
    for (
      let dir = dirname(path);
      dir.length > cacheRoot(home).length;
      dir = dirname(dir)
    ) {
      if ((await readdir(dir)).length > 0) break;
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Bring the cache up to the registry's listing. A version is fetched only when its digest is new.
 * Everything is written to `.tmp-*` folders first and moved into place at the end; `index.json`
 * is written last, atomically, and is what switches versions. If anything fails the previous
 * index still names folders that were not touched. A changed `url` starts from an empty index.
 */
export async function pull(
  home: string,
  client: RegistryClient,
  url: string,
  now: () => Date = () => new Date(),
): Promise<PullChange[]> {
  const root = cacheRoot(home);
  await mkdir(root, { recursive: true });
  for (const name of await readdir(root)) {
    if (name.startsWith(".tmp-")) {
      await rm(join(root, name), { recursive: true, force: true });
    }
  }

  const previous = await readIndex(home);
  const old = previous?.url === url ? previous.layers : {};
  const oldAll = previous?.layers ?? {};
  const listing = await client.listLayers();

  const layers: CacheIndex["layers"] = {};
  const fetched: { ref: string; version: number; tmp: string }[] = [];
  const changes: PullChange[] = [];
  const stage = join(root, `.tmp-${randomBytes(6).toString("hex")}`);

  for (const { ref, version, digest } of listing) {
    layers[ref] = { version, digest };
    const have = old[ref];
    if (have?.version === version && have.digest === digest) continue;
    const full = await client.getVersion(ref, version);
    if (
      full.ref !== ref ||
      full.version !== version ||
      bundleDigest(full.source, full.files) !== digest
    ) {
      throw protocol(`${ref}@${version}: the bundle does not match its digest`);
    }
    const tmp = join(stage, String(fetched.length));
    await writeVersion(tmp, full);
    fetched.push({ ref, version, tmp });
    changes.push({
      ref,
      ...(oldAll[ref] && { from: oldAll[ref].version }),
      to: version,
    });
  }
  for (const [ref, { version }] of Object.entries(oldAll)) {
    if (!(ref in layers)) changes.push({ ref, from: version });
  }

  for (const { ref, version, tmp } of fetched) {
    await install(tmp, cacheFolder(home, ref, version));
  }
  const index: CacheIndex = { url, pulledAt: now().toISOString(), layers };
  await writeFileAtomic(indexPath(home), `${JSON.stringify(index, null, 2)}\n`);
  await rm(stage, { recursive: true, force: true });
  await prune(home, index);
  return changes.sort((a, b) => a.ref.localeCompare(b.ref));
}

/**
 * After a publish: put the version the registry accepted into the cache so the next command
 * resolves it without a pull. Keeps `pulledAt`, so the freshness clock is not reset.
 */
export async function recordPublished(
  home: string,
  url: string,
  version: LayerVersion,
): Promise<void> {
  const root = cacheRoot(home);
  await mkdir(root, { recursive: true });
  const tmp = join(root, `.tmp-${randomBytes(6).toString("hex")}`);
  try {
    await writeVersion(tmp, version);
    await install(tmp, cacheFolder(home, version.ref, version.version));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const previous = await readIndex(home);
  const same = previous?.url === url;
  const index: CacheIndex = {
    url,
    pulledAt: same ? previous.pulledAt : new Date(0).toISOString(),
    layers: {
      ...(same ? previous.layers : {}),
      [version.ref]: { version: version.version, digest: version.digest },
    },
  };
  await writeFileAtomic(indexPath(home), `${JSON.stringify(index, null, 2)}\n`);
  await prune(home, index);
}
