import { randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  stat,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
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

/**
 * A version's folder: `<ref>/@<version>-<first 12 hex of the digest>`. `@` cannot start a ref
 * segment, so `org/a`'s versions never collide with the folders of `org/a/1`, and a changed
 * digest for the same version gets a new folder instead of replacing one the index names.
 */
export const cacheFolder = (
  home: string,
  ref: string,
  version: number,
  digest: string,
): string =>
  join(
    cacheRoot(home),
    ...ref.split("/"),
    `@${version}-${digest.replace(/^sha256:/, "").slice(0, 12)}`,
  );

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

/** Move a finished folder into place; a folder with that name (digest included) is the same. */
async function install(tmp: string, target: string): Promise<void> {
  if (
    await stat(target).then(
      () => true,
      () => false,
    )
  ) {
    await rm(tmp, { recursive: true, force: true });
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await rename(tmp, target);
}

const STALE_LOCK_MS = 60_000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

/** True when the lock file's owner is gone or it is older than a minute. */
async function lockIsStale(path: string): Promise<string | undefined> {
  try {
    const [text, info] = await Promise.all([
      readFile(path, "utf8"),
      stat(path),
    ]);
    const pid = Number.parseInt(text, 10);
    const dead = Number.isInteger(pid) && pid > 0 && !alive(pid);
    return dead || Date.now() - info.mtimeMs > STALE_LOCK_MS ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run `fn` holding `<cache>/.lock`, created exclusively with this pid. A lock whose pid is dead
 * or that is over 60 s old is taken over. Waits (polling every 50 ms) until it gets the lock or
 * `signal` aborts, which is a `timeout`. Always released.
 */
async function withLock<T>(
  home: string,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const root = cacheRoot(home);
  await mkdir(root, { recursive: true });
  const path = join(root, ".lock");
  for (;;) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stale = await lockIsStale(path);
    if (
      stale !== undefined &&
      (await readFile(path, "utf8").catch(() => "")) === stale
    ) {
      await rm(path, { force: true });
      continue;
    }
    if (signal?.aborted) {
      throw new RegistryError(
        "timeout",
        "the registry cache is locked by another zzpersona process",
      );
    }
    await sleep(50, undefined, signal ? { signal } : undefined).catch(() => {});
  }
  try {
    return await fn();
  } finally {
    await rm(path, { force: true });
  }
}

/** Every `<ref>/@<version>-<digest>` folder under the cache. */
async function versionFolders(home: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.name.startsWith("@")) found.push(path);
      else await walk(path);
    }
  };
  await walk(cacheRoot(home));
  return found;
}

/** Remove every version folder the index does not name, then ref folders left empty. */
async function prune(home: string, index: CacheIndex): Promise<void> {
  const keep = new Set(
    Object.entries(index.layers).map(([ref, { version, digest }]) =>
      cacheFolder(home, ref, version, digest),
    ),
  );
  for (const path of await versionFolders(home)) {
    if (keep.has(path)) continue;
    await rm(path, { recursive: true, force: true });
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
  signal?: AbortSignal,
): Promise<PullChange[]> {
  return withLock(home, signal, () => pullLocked(home, client, url, now));
}

async function pullLocked(
  home: string,
  client: RegistryClient,
  url: string,
  now: () => Date,
): Promise<PullChange[]> {
  const root = cacheRoot(home);
  for (const name of await readdir(root)) {
    if (name.startsWith(".tmp-") || name.startsWith("index.json.tmp-")) {
      await rm(join(root, name), { recursive: true, force: true });
    }
  }

  const previous = await readIndex(home);
  const old = previous?.url === url ? previous.layers : {};
  const oldAll = previous?.layers ?? {};
  const listing = await client.listLayers();

  const layers: CacheIndex["layers"] = {};
  const fetched: {
    ref: string;
    version: number;
    digest: string;
    tmp: string;
  }[] = [];
  const changes: PullChange[] = [];
  const stage = join(root, `.tmp-${randomBytes(6).toString("hex")}`);

  for (const { ref, version, digest } of listing) {
    layers[ref] = { version, digest };
    const have = old[ref];
    if (
      have?.version === version &&
      have.digest === digest &&
      (await stat(cacheFolder(home, ref, version, digest)).then(
        () => true,
        () => false,
      ))
    ) {
      continue;
    }
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
    fetched.push({ ref, version, digest, tmp });
    changes.push({
      ref,
      ...(oldAll[ref] && { from: oldAll[ref].version }),
      to: version,
    });
  }
  for (const [ref, { version }] of Object.entries(oldAll)) {
    if (!(ref in layers)) changes.push({ ref, from: version });
  }

  for (const { ref, version, digest, tmp } of fetched) {
    await install(tmp, cacheFolder(home, ref, version, digest));
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
  signal?: AbortSignal,
): Promise<void> {
  return withLock(home, signal, () => recordLocked(home, url, version));
}

async function recordLocked(
  home: string,
  url: string,
  version: LayerVersion,
): Promise<void> {
  const root = cacheRoot(home);
  const tmp = join(root, `.tmp-${randomBytes(6).toString("hex")}`);
  try {
    await writeVersion(tmp, version);
    await install(
      tmp,
      cacheFolder(home, version.ref, version.version, version.digest),
    );
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
