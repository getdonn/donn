import { isDeepStrictEqual } from "node:util";
import { realpath, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import type { LocalStore } from "@zzpersona/store-local";
import claudeCode from "@zzpersona/adapter-claude-code";
import type {
  ManagedCode,
  ManagedEntry,
  ManagedLayer,
  ManagedManifest,
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
import { fail as registryFailure } from "../commands/registry.js";
import { cliVersion } from "../commands/daemon.js";
import type { CliIo } from "../cli.js";
import type { Context } from "../context.js";
import { CliError } from "../errors.js";
import { clientFor } from "../registry.js";
import {
  checkedPath,
  checkNoCaseDuplicates,
  MANIFEST_PATH,
  sha256,
} from "./bundle-io.js";

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

/**
 * Download the bundle from the registry (docs/planning/21-managed-settings.md, section 4). The
 * registry is not trusted with paths or bytes: every file key must stay inside the bundle folder
 * and every file must hash to the digest its manifest lists.
 */
async function downloadBundle(
  io: CliIo,
  context: Context,
  options: BuildOptions,
): Promise<ManagedResult> {
  const { client } = await clientFor(io, context.home, context.config);
  const layer = await pickLayer(context, options.layer);
  let answer;
  try {
    answer = await client.managedBundle({ layer, os: options.os });
  } catch (error) {
    if (!(error instanceof RegistryError)) throw error;
    // A registry without the route answers a bare 404; the mock and real servers name the layer
    // (`ref`) when it is the layer that is missing.
    const noRoute =
      error.code === "not-found" &&
      !(error.problems ?? []).some((p) => p.ref !== undefined);
    if (error.code === "format-unsupported" || noRoute) {
      throw new CliError(
        "not-supported",
        "not supported by this registry: --from-registry",
      );
    }
    if (error.code === "managed-refused") {
      // The mock and the control plane word a problem as `<path>: <code>: <reason>`.
      const entries: ManagedEntry[] = (error.problems ?? []).map((p) => {
        const path = p.path ?? "";
        const rest = p.message.startsWith(`${path}: `)
          ? p.message.slice(path.length + 2)
          : p.message;
        const coded = /^(managed-[a-z-]+): ([\s\S]*)$/.exec(rest);
        return {
          path,
          layer: p.ref ?? layer,
          outcome: "refused" as const,
          ...(coded && { code: coded[1] as ManagedCode }),
          reason: coded ? coded[2]! : rest,
        };
      });
      return { report: { entries, warnings: [] } };
    }
    return registryFailure(error);
  }
  const { manifest, files, rawManifest } = answer;
  // The bundle must be the one asked for: install trusts its os, check its deepest layer.
  const deepest = manifest.layers.at(-1)?.ref;
  if (manifest.os !== options.os || deepest !== layer) {
    throw new CliError(
      "managed-bundle-mismatch",
      manifest.os !== options.os
        ? `the registry sent a bundle for ${manifest.os}; --os asked for ${options.os}`
        : `the registry sent a bundle for ${deepest ?? "no layer"}; --layer asked for ${layer}`,
      { os: manifest.os, layer: deepest },
    );
  }
  for (const path of Object.keys(files)) checkedPath(path);
  checkNoCaseDuplicates(Object.keys(files));
  const listed = new Set(Object.keys(manifest.files));
  for (const [path, expected] of Object.entries(manifest.files)) {
    checkedPath(path);
    const bytes = files[path];
    if (bytes === undefined || sha256(bytes) !== expected) {
      throw new CliError(
        "managed-bundle-mismatch",
        `${path} ${bytes === undefined ? "is listed in" : "does not match its digest in"} the manifest the registry sent`,
        { path },
      );
    }
  }
  for (const path of Object.keys(files)) {
    if (path !== MANIFEST_PATH && !listed.has(path)) {
      throw new CliError(
        "managed-bundle-mismatch",
        `${path} is not listed in the manifest the registry sent`,
        { path },
      );
    }
  }
  const manifestBytes = files[MANIFEST_PATH];
  if (manifestBytes === undefined) {
    throw new CliError(
      "managed-bundle-mismatch",
      `${MANIFEST_PATH} is missing from the bundle the registry sent`,
    );
  }
  // The bytes install will read must be the manifest the digests were checked against, as the
  // registry sent it: a newer server's extra manifest field is not tampering.
  let written: unknown;
  try {
    written = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    written = undefined;
  }
  if (!isDeepStrictEqual(written, rawManifest)) {
    throw new CliError(
      "managed-bundle-mismatch",
      `${MANIFEST_PATH} does not match the manifest the registry sent`,
      { path: MANIFEST_PATH },
    );
  }
  return {
    report: manifest.report as ManagedManifest["report"],
    bundle: { files, manifest: manifest as ManagedManifest },
  };
}

/** `io` is needed only for `fromRegistry` (it reads the registry token). */
export async function buildBundle(
  context: Context,
  options: BuildOptions,
  io?: CliIo,
): Promise<ManagedResult> {
  if (options.fromRegistry) {
    if (io === undefined) throw new Error("--from-registry needs the CLI io");
    return downloadBundle(io, context, options);
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
