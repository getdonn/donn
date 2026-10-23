import { realpath, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import type { LocalStore } from "@zzpersona/store-local";
import claudeCode from "@zzpersona/adapter-claude-code";
import type {
  ManagedLayer,
  ManagedOs,
  ManagedResult,
} from "@zzpersona/adapter-sdk";
import { bundleDigest, compileFromSource } from "@zzpersona/registry-api";
import { resolve } from "@zzpersona/resolver";
import type { Ref } from "@zzpersona/spec";
import {
  cacheFolder,
  readIndex,
  bundleLayer,
  RegistryError,
  type RegistryStore,
} from "@zzpersona/store-remote";
import { cliVersion } from "../commands/daemon.js";
import type { Context } from "../context.js";
import { CliError } from "../errors.js";

// Compile the locks of an org, area or team chain to a managed policy bundle.
// See docs/planning/21-managed-settings.md, sections 2 and 3.

export const MANAGED_OSES: readonly ManagedOs[] = ["macos", "linux", "windows"];

export function defaultOs(platform: string = process.platform): ManagedOs {
  return platform === "darwin"
    ? "macos"
    : platform === "win32"
      ? "windows"
      : "linux";
}

const SHARED = /^(org|area|team)\//;

/** `--layer`, or the only org layer in the store. */
async function pickLayer(context: Context, layer?: string): Promise<Ref> {
  if (layer !== undefined) {
    if (!SHARED.test(layer)) {
      throw new CliError(
        "managed-bad-layer",
        `${layer} cannot be built: a managed bundle takes an org, area or team layer`,
        { layer },
      );
    }
    return layer;
  }
  const orgs = (await context.store.list()).filter((ref) =>
    ref.startsWith("org/"),
  );
  if (orgs.length === 1) return orgs[0]!;
  throw new CliError(
    "managed-layer-required",
    orgs.length === 0
      ? "no org/ layer found; pass --layer <ref>"
      : `several org layers (${orgs.join(", ")}); pass --layer <ref>`,
    { candidates: orgs },
  );
}

/** The cached files that get compiled must still hash to the digest the index records. */
async function verifyCached(
  home: string,
  ref: Ref,
  version: number,
  digest: string,
): Promise<void> {
  const folder = cacheFolder(home, ref, version, digest);
  const asStore = {
    locate: () => ({ path: join(folder, "layer.yaml"), root: folder }),
  } as unknown as LocalStore;
  let actual: string | undefined;
  try {
    const { source, files } = await bundleLayer(asStore, ref);
    actual = bundleDigest(source, files);
  } catch {
    // Unreadable or incomplete counts as a mismatch.
  }
  if (actual !== digest) {
    throw new CliError(
      "managed-cache-mismatch",
      `the cached copy of ${ref} @${version} does not match the registry's digest; run \`zzpersona pull\` to refresh it`,
      { ref, version },
    );
  }
}

/** Version and digest of each layer: the published ones from the cache, the rest hashed locally. */
async function describeLayers(
  context: Context,
  refs: Ref[],
): Promise<ManagedLayer[]> {
  const index = await readIndex(context.home);
  const published = (context.store as Partial<RegistryStore>).published;
  const out: ManagedLayer[] = [];
  for (const ref of refs) {
    const version =
      typeof published === "function"
        ? published.call(context.store, ref)
        : undefined;
    const cached = version !== undefined ? index?.layers[ref] : undefined;
    if (version !== undefined && cached !== undefined) {
      await verifyCached(context.home, ref, version, cached.digest);
      out.push({ ref, version, digest: cached.digest });
      continue;
    }
    const { source, files } = await bundleLayer(context.local, ref).catch(
      (error: unknown) => {
        if (error instanceof RegistryError) {
          throw new CliError("managed-layer-files", error.message, { ref });
        }
        throw error;
      },
    );
    out.push({ ref, digest: bundleDigest(source, files) });
  }
  return out;
}

/** Read a store file by its virtual path, never from outside the store's mount. */
function storeReader(context: Context) {
  return async (path: string): Promise<Uint8Array> => {
    const location = context.store.locate(path);
    if (location === undefined) {
      throw new CliError(
        "managed-file-outside-store",
        `${path} is not inside the personas folder`,
        { path },
      );
    }
    try {
      const [real, root] = await Promise.all([
        realpath(location.path),
        realpath(location.root),
      ]);
      if (real !== root && !real.startsWith(root + sep)) {
        throw new CliError(
          "managed-file-outside-store",
          `${path} resolves outside its personas folder`,
          { path },
        );
      }
      return new Uint8Array(await readFile(real));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CliError("managed-missing-file", `${path} does not exist`, {
          path,
        });
      }
      throw error;
    }
  };
}

export interface BuildOptions {
  layer?: string;
  os: ManagedOs;
  fromRegistry: boolean;
}

export async function buildBundle(
  context: Context,
  options: BuildOptions,
): Promise<ManagedResult> {
  if (options.fromRegistry) {
    // The registry route lands in Task 5 (docs/planning/21-managed-settings.md, section 4).
    throw new CliError(
      "not-supported",
      "not supported by this registry: --from-registry",
    );
  }
  const compiler = claudeCode.managed;
  if (compiler === undefined) {
    throw new CliError(
      "managed-unsupported",
      "claude-code has no managed compile",
    );
  }
  const ref = await pickLayer(context, options.layer);
  const { ir } = await resolve(ref, { source: context.store });
  const layers = await describeLayers(context, ir.layers);
  return compileFromSource(compiler, {
    source: context.store,
    ref,
    os: options.os,
    layers,
    zzpersona: cliVersion(),
    readFile: storeReader(context),
  });
}
