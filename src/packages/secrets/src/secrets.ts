import type { ResolvedPersona } from "@getdonn/spec";
import { keychainBackend } from "./keychain.js";

// secret://<provider>/<path> → value. The provider name is looked up in the persona's resolved
// secrets.providers; its type picks the backend. See docs/planning/06-cli-core-loop.md, section 2.
// Values only ever reach a launch step's env: never a file, a log, an error or --json output.

/** Environment variables. Plain types, so provider packages need no @types/node. */
export type Env = Record<string, string | undefined>;

/** What a backend may use: the environment, the platform, and the CLI's command runner. */
export interface SecretContext {
  env: Env;
  /** process.platform's value, e.g. "darwin" or "linux". */
  platform: string;
  /** Runs a command. Never throws for a missing command: returns exit code 127. */
  run(
    command: string,
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Resolves the path of a secret://<provider>/<path> ref. Returns undefined when the secret does
 * not exist; throws an Error whose message is the reason for any other failure. Never put the
 * value in an error.
 */
export interface SecretBackend {
  type: string;
  resolve(
    path: string,
    config: Record<string, unknown>,
    ctx: SecretContext,
  ): Promise<string | undefined>;
}

/** Provider types every persona can use without a provider package. */
export const BUILT_IN_TYPES: readonly string[] = ["env", "keychain"];

/** The path is an environment variable name. An empty value counts as unset. */
export const envBackend: SecretBackend = {
  type: "env",
  resolve: async (path, _config, ctx) => ctx.env[path] || undefined,
};

export class SecretResolutionError extends Error {
  override name = "SecretResolutionError";
  constructor(readonly failures: { ref: string; reason: string }[]) {
    super(
      [
        `could not resolve ${failures.length} secret(s):`,
        ...failures.map((f) => `  ${f.ref}: ${f.reason}`),
      ].join("\n"),
    );
  }
}

export function parseSecretRef(
  ref: string,
): { provider: string; path: string } | undefined {
  const match = /^secret:\/\/([^/]+)\/(.+)$/.exec(ref);
  return match ? { provider: match[1]!, path: match[2]! } : undefined;
}

const notFound = (type: string, path: string) =>
  type === "env"
    ? `environment variable ${path} is not set`
    : type === "keychain"
      ? "not found in the keychain"
      : `no value for ${path}`;

/**
 * Resolve every ref, or throw one error listing every ref that failed and why. Built-in
 * backends come first; `loadBackend` is asked, once per type, for any other provider type.
 */
export async function resolveSecrets(
  refs: string[],
  providers: ResolvedPersona["secrets"]["providers"],
  ctx: SecretContext,
  options: {
    loadBackend?: (type: string) => Promise<SecretBackend | undefined>;
  } = {},
): Promise<Record<string, string>> {
  const loaded = new Map<string, Promise<SecretBackend | undefined>>();
  const backendFor = (type: string) => {
    const builtIn = BUILT_IN_BACKENDS.find((b) => b.type === type);
    if (builtIn) return Promise.resolve(builtIn);
    if (!loaded.has(type)) {
      loaded.set(
        type,
        options.loadBackend?.(type) ?? Promise.resolve(undefined),
      );
    }
    return loaded.get(type)!;
  };
  const values: Record<string, string> = {};
  const failures: { ref: string; reason: string }[] = [];

  for (const ref of refs) {
    const parsed = parseSecretRef(ref);
    if (!parsed) {
      failures.push({ ref, reason: "not a secret://<provider>/<path> ref" });
      continue;
    }
    const provider =
      providers[parsed.provider] ??
      (BUILT_IN_TYPES.includes(parsed.provider)
        ? { type: parsed.provider }
        : undefined);
    if (!provider) {
      failures.push({
        ref,
        reason: `provider "${parsed.provider}" is not declared in secrets.providers`,
      });
      continue;
    }
    const backend = await backendFor(provider.type);
    if (!backend) {
      failures.push({
        ref,
        reason: `provider type "${provider.type}" is not built in; list a provider package under secretProviders`,
      });
      continue;
    }
    let value: unknown;
    try {
      value = await backend.resolve(parsed.path, provider, ctx);
    } catch (error) {
      // The message only: a stack could carry anything the backend had in scope.
      failures.push({
        ref,
        reason: error instanceof Error ? error.message : "provider failed",
      });
      continue;
    }
    if (value === undefined || value === "") {
      failures.push({ ref, reason: notFound(backend.type, parsed.path) });
      continue;
    }
    if (typeof value !== "string") {
      failures.push({ ref, reason: "provider returned a non-string value" });
      continue;
    }
    values[ref] = value;
  }

  if (failures.length > 0) throw new SecretResolutionError(failures);
  return values;
}

export const BUILT_IN_BACKENDS: readonly SecretBackend[] = [
  envBackend,
  keychainBackend,
];
