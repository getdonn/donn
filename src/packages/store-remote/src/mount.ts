import { readFile, realpath } from "node:fs/promises";
import { join, posix, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import type { LocalStore } from "@zzpersona/store-local";
import { cacheFolder, type CacheIndex } from "./cache.js";

const PREFIX = ".registry/";

export interface RegistryStore extends LocalStore {
  /** The published version a ref resolves to, when it comes from the cache. */
  published(ref: string): number | undefined;
}

/**
 * The local store with the registry cache in front: every ref in `index` loads from its cached
 * version. `.registry/<ref>/@/<path>` maps to that version's folder, so two published layers can
 * each bundle their own `instructions/conduct.md`. `onShadow` is called once per ref when a local
 * file for the same ref differs from the published one.
 */
export function withRegistry(
  local: LocalStore,
  home: string,
  index: CacheIndex,
  onShadow: (ref: string, version: number) => void,
): RegistryStore {
  const warned = new Set<string>();
  const published = (ref: string) => index.layers[ref]?.version;

  /** `.registry/org/acme/@/x/y` → ref `org/acme`, tail `x/y`: split at the first `@` segment. */
  const split = (virtualPath: string) => {
    if (!virtualPath.startsWith(PREFIX)) return undefined;
    const segments = virtualPath.slice(PREFIX.length).split("/");
    const at = segments.indexOf("@");
    if (at < 1) return undefined;
    const ref = segments.slice(0, at).join("/");
    if (index.layers[ref] === undefined) return undefined;
    return { ref, tail: segments.slice(at + 1).join("/") };
  };

  const locate: LocalStore["locate"] = (virtualPath) => {
    if (!virtualPath.startsWith(PREFIX)) return local.locate(virtualPath);
    const found = split(virtualPath);
    if (found === undefined) return undefined;
    const tail = posix.normalize(found.tail === "" ? "." : found.tail);
    if (tail === ".." || tail.startsWith("../") || posix.isAbsolute(tail)) {
      return undefined;
    }
    const { version, digest } = index.layers[found.ref]!;
    const root = cacheFolder(home, found.ref, version, digest);
    return { path: join(root, ...tail.split("/")), root };
  };

  return {
    locate,
    published,

    dir(ref) {
      return published(ref) === undefined
        ? (local.dir?.(ref) ?? posix.dirname(ref))
        : `${PREFIX}${ref}/@`;
    },

    async load(ref) {
      const entry = index.layers[ref];
      if (entry === undefined) return local.load(ref);
      const { version, digest } = entry;
      const cached = parse(
        await readFile(
          join(cacheFolder(home, ref, version, digest), "layer.yaml"),
          "utf8",
        ),
      ) as unknown;
      if (!warned.has(ref)) {
        const mine = await local.load(ref).catch(() => undefined);
        if (mine !== undefined && !isDeepStrictEqual(mine, cached)) {
          warned.add(ref);
          onShadow(ref, version);
        }
      }
      return cached;
    },

    async readText(virtualPath) {
      if (!virtualPath.startsWith(PREFIX)) return local.readText(virtualPath);
      const location = locate(virtualPath);
      if (location === undefined) {
        throw new Error(`${virtualPath} is not a published file`);
      }
      const [real, realRoot] = await Promise.all([
        realpath(location.path),
        realpath(location.root),
      ]);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        throw new Error(`${virtualPath} resolves outside its published folder`);
      }
      return readFile(location.path, "utf8");
    },

    async list() {
      const refs = new Set([
        ...(await local.list()),
        ...Object.keys(index.layers),
      ]);
      return [...refs].sort();
    },

    strayLayerDirs: () => local.strayLayerDirs(),
  };
}
