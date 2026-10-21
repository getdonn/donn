import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ADAPTER_API_VERSION,
  defineAdapter,
  type HarnessAdapter,
} from "@zzpersona/adapter-sdk";
import {
  BUILT_IN_TYPES,
  defineSecretProvider,
  SECRET_PROVIDER_API_VERSION,
  type Env,
  type SecretBackend,
  type SecretProvider,
} from "@zzpersona/secrets";
import { expandPath } from "./config.js";
import type { Context } from "./context.js";
import { CliError } from "./errors.js";
import { HARNESSES } from "./harness.js";

// Third-party adapters and secret providers, listed in config.yaml and imported only when a
// command needs one that is not built in. Nothing is discovered by scanning.
// See docs/planning/08-cli-reach.md, section 1.

export interface LoadedPlugin<T> {
  entry: string;
  /** The file that was imported. */
  resolved: string;
  /** From the package's package.json, when there is one. */
  version?: string;
  plugin: T;
}

const isPath = (entry: string) => /^[./~]/.test(entry);

const fail = (entry: string, reason: string, message?: string): never => {
  throw new CliError(
    "plugin-load",
    `cannot load plugin ${entry}: ${message ?? reason}`,
    { entry, reason },
  );
};

interface PackageJson {
  version?: string;
  main?: string;
  exports?: unknown;
}

async function readPackage(dir: string): Promise<PackageJson | undefined> {
  const text = await readFile(join(dir, "package.json"), "utf8").catch(
    () => undefined,
  );
  return text === undefined ? undefined : (JSON.parse(text) as PackageJson);
}

/** The package's main entry: exports ".", then main, then index.js. ESM conditions first. */
function entryOf(pkg: PackageJson | undefined): string {
  const exports = pkg?.exports;
  if (typeof exports === "string") return exports;
  const dot =
    exports && typeof exports === "object"
      ? (exports as Record<string, unknown>)["."]
      : undefined;
  if (typeof dot === "string") return dot;
  if (dot && typeof dot === "object") {
    const conditions = dot as Record<string, unknown>;
    const chosen = conditions.import ?? conditions.default;
    if (typeof chosen === "string") return chosen;
  }
  return pkg?.main ?? "index.js";
}

/** Import one config entry: a path, or a package from <home>/adapters/node_modules. */
export async function loadPlugin(
  home: string,
  entry: string,
  env: Env,
): Promise<Omit<LoadedPlugin<unknown>, "plugin"> & { module: unknown }> {
  const target = isPath(entry)
    ? expandPath(entry, home, env)
    : join(home, "adapters/node_modules", entry);
  if (!existsSync(target)) {
    if (isPath(entry)) fail(entry, "not-found", `${target} does not exist`);
    fail(
      entry,
      "not-installed",
      `not installed; run \`npm install --prefix ${join(home, "adapters")} ${entry}\``,
    );
  }
  let resolved = target;
  let version: string | undefined;
  if (statSync(target).isDirectory()) {
    const pkg = await readPackage(target);
    version = pkg?.version;
    resolved = join(target, entryOf(pkg));
  }
  let module: unknown;
  try {
    module = await import(pathToFileURL(resolved).href);
  } catch (error) {
    fail(entry, "import-failed", (error as Error).message);
  }
  return {
    entry,
    resolved,
    ...(version !== undefined && { version }),
    module: (module as { default?: unknown }).default,
  };
}

function asAdapter(entry: string, value: unknown): HarnessAdapter {
  const candidate = value as Partial<HarnessAdapter> | undefined;
  if (candidate === undefined || typeof candidate !== "object")
    fail(entry, "no-default-export", "it has no default export");
  if (candidate!.apiVersion === undefined)
    fail(
      entry,
      "not-an-adapter",
      "its default export is not a defineAdapter() result",
    );
  if (candidate!.apiVersion !== ADAPTER_API_VERSION)
    fail(
      entry,
      "api-version",
      `it targets adapter API ${String(candidate!.apiVersion)}; this zzpersona supports ${ADAPTER_API_VERSION}`,
    );
  try {
    return defineAdapter(candidate as HarnessAdapter);
  } catch (error) {
    return fail(entry, "invalid-declaration", (error as Error).message);
  }
}

function asProvider(entry: string, value: unknown): SecretProvider {
  const candidate = value as Partial<SecretProvider> | undefined;
  if (candidate === undefined || typeof candidate !== "object")
    fail(entry, "no-default-export", "it has no default export");
  if (candidate!.apiVersion === undefined)
    fail(
      entry,
      "not-a-provider",
      "its default export is not a defineSecretProvider() result",
    );
  if (candidate!.apiVersion !== SECRET_PROVIDER_API_VERSION)
    fail(
      entry,
      "api-version",
      `it targets secret provider API ${String(candidate!.apiVersion)}; this zzpersona supports ${SECRET_PROVIDER_API_VERSION}`,
    );
  try {
    return defineSecretProvider(candidate as SecretBackend);
  } catch (error) {
    return fail(entry, "invalid-declaration", (error as Error).message);
  }
}

/** Every listed adapter, validated: contract version, no built-in or duplicate ids. */
export async function loadAdapters(
  ctx: Context,
  env: Env,
): Promise<LoadedPlugin<HarnessAdapter>[]> {
  const loaded: LoadedPlugin<HarnessAdapter>[] = [];
  for (const entry of ctx.config.adapters ?? []) {
    const { module, ...where } = await loadPlugin(ctx.home, entry, env);
    const plugin = asAdapter(entry, module);
    if (plugin.id in HARNESSES)
      fail(entry, "built-in-id", `its id ${plugin.id} is a built-in adapter`);
    const clash = loaded.find((l) => l.plugin.id === plugin.id);
    if (clash)
      fail(
        entry,
        "duplicate-id",
        `its id ${plugin.id} is also used by ${clash.entry}`,
      );
    loaded.push({ ...where, plugin });
  }
  return loaded;
}

/** Every listed secret provider, validated: contract version, no built-in or duplicate types. */
export async function loadSecretProviders(
  ctx: Context,
  env: Env,
): Promise<LoadedPlugin<SecretProvider>[]> {
  const loaded: LoadedPlugin<SecretProvider>[] = [];
  for (const entry of ctx.config.secretProviders ?? []) {
    const { module, ...where } = await loadPlugin(ctx.home, entry, env);
    const plugin = asProvider(entry, module);
    if (BUILT_IN_TYPES.includes(plugin.type))
      fail(entry, "built-in-type", `its type ${plugin.type} is built in`);
    const clash = loaded.find((l) => l.plugin.type === plugin.type);
    if (clash)
      fail(
        entry,
        "duplicate-type",
        `its type ${plugin.type} is also provided by ${clash.entry}`,
      );
    loaded.push({ ...where, plugin });
  }
  return loaded;
}

/** A built-in adapter without loading anything; otherwise the listed adapters are loaded. */
export async function findAdapter(
  ctx: Context,
  env: Env,
  id: string,
): Promise<HarnessAdapter> {
  const builtIn = HARNESSES[id];
  if (builtIn) return builtIn;
  const loaded = await loadAdapters(ctx, env);
  const found = loaded.find((l) => l.plugin.id === id);
  if (found) return found.plugin;
  const available = [
    ...Object.keys(HARNESSES),
    ...loaded.map((l) => l.plugin.id),
  ];
  throw new CliError(
    "unknown-harness",
    `unknown harness ${id}; available: ${available.join(", ")}`,
    { harness: id, available },
  );
}

/** For resolveSecrets: loads the listed providers the first time a non-built-in type is needed. */
export function backendLoader(
  ctx: Context,
  env: Env,
): (type: string) => Promise<SecretBackend | undefined> {
  let providers: Promise<LoadedPlugin<SecretProvider>[]> | undefined;
  return async (type) => {
    providers ??= loadSecretProviders(ctx, env);
    return (await providers).find((p) => p.plugin.type === type)?.plugin;
  };
}
