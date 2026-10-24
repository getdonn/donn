import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ADAPTER_API_VERSION,
  defineAdapter,
  type HarnessAdapter,
} from "@getdonn/adapter-sdk";
import {
  BUILT_IN_TYPES,
  defineSecretProvider,
  SECRET_PROVIDER_API_VERSION,
  type Env,
  type SecretBackend,
  type SecretProvider,
} from "@getdonn/secrets";
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

async function readPackage(
  entry: string,
  dir: string,
): Promise<PackageJson | undefined> {
  const text = await readFile(join(dir, "package.json"), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as PackageJson;
  } catch (error) {
    return fail(
      entry,
      "invalid-package-json",
      `${join(dir, "package.json")} is not valid JSON: ${(error as Error).message}`,
    );
  }
}

/** The conditions a plugin import matches, as Node matches them for `import()`. */
const CONDITIONS = new Set(["node", "import", "default"]);

/** An exports target: a string, the first usable array item, or the first matching condition. */
function target(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = target(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (!CONDITIONS.has(key)) continue;
      const found = target(child);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** The file for `subpath` ("." or "./x"): exports first, then main, then index.js. */
function entryOf(pkg: PackageJson | undefined, subpath: string): string {
  const exports = pkg?.exports;
  if (exports !== undefined && exports !== null) {
    const isSubpathMap =
      typeof exports === "object" &&
      !Array.isArray(exports) &&
      Object.keys(exports).some((key) => key.startsWith("."));
    const found = isSubpathMap
      ? target((exports as Record<string, unknown>)[subpath])
      : subpath === "."
        ? target(exports)
        : undefined;
    if (found !== undefined) return found;
  }
  if (subpath !== ".") return subpath;
  return pkg?.main ?? "index.js";
}

/** `file` as written, or with the extensions and index Node's old resolution would try. */
function withExtension(file: string): string {
  for (const candidate of [
    file,
    `${file}.js`,
    `${file}.mjs`,
    join(file, "index.js"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return file;
}

/** "@scope/name/sub" → the package name and "./sub"; "name" → the name and ".". */
function splitPackage(entry: string): { name: string; subpath: string } {
  const parts = entry.split("/");
  const size = entry.startsWith("@") ? 2 : 1;
  const rest = parts.slice(size);
  return {
    name: parts.slice(0, size).join("/"),
    subpath: rest.length === 0 ? "." : `./${rest.join("/")}`,
  };
}

/** Import one config entry: a path, or a package from <home>/adapters/node_modules. */
export async function loadPlugin(
  home: string,
  entry: string,
  env: Env,
): Promise<Omit<LoadedPlugin<unknown>, "plugin"> & { module: unknown }> {
  let resolved: string;
  let version: string | undefined;
  if (isPath(entry)) {
    const path = expandPath(entry, home, env);
    if (!existsSync(path)) fail(entry, "not-found", `${path} does not exist`);
    resolved = path;
    if (statSync(path).isDirectory()) {
      const pkg = await readPackage(entry, path);
      version = pkg?.version;
      resolved = withExtension(join(path, entryOf(pkg, ".")));
    }
  } else {
    const { name, subpath } = splitPackage(entry);
    const dir = join(home, "adapters/node_modules", name);
    if (!existsSync(dir)) {
      fail(
        entry,
        "not-installed",
        `not installed; run \`npm install --prefix ${join(home, "adapters")} ${name}\``,
      );
    }
    const pkg = await readPackage(entry, dir);
    version = pkg?.version;
    resolved = withExtension(join(dir, entryOf(pkg, subpath)));
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
      `it targets adapter API ${String(candidate!.apiVersion)}; this donn supports ${ADAPTER_API_VERSION}`,
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
      `it targets secret provider API ${String(candidate!.apiVersion)}; this donn supports ${SECRET_PROVIDER_API_VERSION}`,
    );
  try {
    return defineSecretProvider(candidate as SecretBackend);
  } catch (error) {
    return fail(entry, "invalid-declaration", (error as Error).message);
  }
}

/** Every listed adapter, validated: contract version, no built-in or duplicate ids. */
export async function loadAdapters(
  ctx: Pick<Context, "home" | "config">,
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
  ctx: Pick<Context, "home" | "config">,
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

/** The built-in adapters, then the ones the config lists. */
export async function allAdapters(
  ctx: Pick<Context, "home" | "config">,
  env: Env,
): Promise<HarnessAdapter[]> {
  const loaded = await loadAdapters(ctx, env);
  return [...Object.values(HARNESSES), ...loaded.map((l) => l.plugin)];
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
