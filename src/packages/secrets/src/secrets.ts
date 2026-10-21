import type { ResolvedPersona } from "@zzpersona/spec";

// secret://<provider>/<path> → value. The provider name is looked up in the persona's resolved
// secrets.providers; its type picks the backend. See docs/planning/06-cli-core-loop.md, section 2.
// Values only ever reach a launch step's env: never a file, a log, an error or --json output.

export interface SecretBackend {
  type: string;
  resolve(
    path: string,
    config: Record<string, unknown>,
    env: NodeJS.ProcessEnv,
  ): Promise<string | undefined>;
}

/** The path is an environment variable name. An empty value counts as unset. */
export const envBackend: SecretBackend = {
  type: "env",
  resolve: async (path, _config, env) => env[path] || undefined,
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

/** Resolve every ref, or throw one error listing every ref that failed and why. */
export async function resolveSecrets(
  refs: string[],
  providers: ResolvedPersona["secrets"]["providers"],
  options: { backends?: SecretBackend[]; env?: NodeJS.ProcessEnv } = {},
): Promise<Record<string, string>> {
  const backends = options.backends ?? [envBackend];
  const env = options.env ?? process.env;
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
      (parsed.provider === "env" ? { type: "env" } : undefined);
    if (!provider) {
      failures.push({
        ref,
        reason: `provider "${parsed.provider}" is not declared in secrets.providers`,
      });
      continue;
    }
    const backend = backends.find((b) => b.type === provider.type);
    if (!backend) {
      failures.push({
        ref,
        reason: `provider type "${provider.type}" is not supported yet`,
      });
      continue;
    }
    const value = await backend.resolve(parsed.path, provider, env);
    if (value === undefined) {
      failures.push({
        ref,
        reason:
          backend.type === "env"
            ? `environment variable ${parsed.path} is not set`
            : `no value for ${parsed.path}`,
      });
      continue;
    }
    values[ref] = value;
  }

  if (failures.length > 0) throw new SecretResolutionError(failures);
  return values;
}
