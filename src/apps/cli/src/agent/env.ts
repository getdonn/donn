import { createHash } from "node:crypto";
import {
  BUILT_IN_TYPES,
  parseSecretRef,
  resolveSecrets,
  SecretResolutionError,
} from "@getdonn/secrets";
import type { ResolveResult } from "@getdonn/spec";
import type { CliIo } from "../cli.js";
import type { Context } from "../context.js";
import { CliError } from "../errors.js";
import { backendLoader } from "../plugins.js";
import { secretContext } from "../secret-context.js";
import { eveEnv } from "./eve.js";
import { compile, compileInputs } from "./inputs.js";
import { nodeSpawn } from "./spawn.js";
import type { Manifest } from "./files.js";
import { loadCreatedAgent } from "./load.js";

// `donn agent env` and `donn agent exec`: the environment an agent needs, from the compile's
// `secretEnv` and `env` and what its target adds, and a command run with it resolved.
// See docs/planning/25-agent-runner.md, section 5.

export interface EnvEntry {
  name: string;
  source: "secret" | "plain" | "runtime";
  /** The `secret://` ref of a secret entry. */
  ref?: string;
  /** Only when resolved: a secret's value, never otherwise. A plain entry always has its. */
  value?: string;
  why:
    | "persona-secret"
    | "gateway-key"
    | "template-variable"
    | "world-database"
    | "route-auth";
}

const ROUTE_TOKEN = "DONN_ROUTE_TOKEN";
const SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
const WORLD_DATABASE = "WORKFLOW_POSTGRES_URL";

export interface AgentEnvironment {
  /** The project's root folder (the one holding `.donn/`). */
  root: string;
  /** The agent's folder. */
  dir: string;
  entries: EnvEntry[];
  /** The resolved project persona and the agent's manifest it was read with. */
  result: ResolveResult;
  manifest: Manifest;
}

/** The agent's folder and its env entries; values only for secrets, and only with `resolve`. */
export async function agentEnvironment(
  ctx: Context,
  io: CliIo,
  name: string,
  options: {
    resolve: boolean;
    /** Runs on the declared agent before any secret is resolved; it may throw. */
    check?: (target: string) => void;
    /**
     * With `resolve`: values for env-provider refs the caller resolved (a terminal `agent run`
     * sent them to the daemon), used for those refs. Each must be one the agent uses, unless
     * `unused` is `ignore` (a restart after a sync, whose persona may no longer use one).
     */
    provided?: Record<string, string>;
    unused?: "refuse" | "ignore";
    /**
     * With `resolve`, which refs this process resolves: all of them (the default); only the
     * env-provider ones (a terminal before it asks the daemon); or all but those, each of which
     * then fails unless provided (a run with no shell environment, from donn ui).
     */
    refs?: "all" | "env" | "not-env";
  },
): Promise<AgentEnvironment> {
  const { root, result, dir, manifest } = await loadCreatedAgent(ctx, io, name);
  const agent = result.ir.agents[name]!;
  options.check?.(agent.target);
  const output = compile(
    await compileInputs(ctx, result.ir, name, dir, manifest.frameworkVersion),
  );

  const gateway = result.ir.models.gateway;
  const gatewayRefs = new Set<string>(
    [gateway?.apiKey, ...Object.values(gateway?.headers ?? {})].filter(
      (v): v is string => v !== undefined,
    ),
  );
  const entries: EnvEntry[] = [];
  for (const [envName, ref] of Object.entries(output.secretEnv)) {
    entries.push({
      name: envName,
      source: "secret",
      ref,
      why:
        envName === "AI_GATEWAY_API_KEY" || gatewayRefs.has(ref)
          ? "gateway-key"
          : "persona-secret",
    });
  }
  for (const [envName, value] of Object.entries(output.env)) {
    entries.push(
      envName === ROUTE_TOKEN && value === ""
        ? { name: envName, source: "runtime", why: "route-auth" }
        : { name: envName, source: "plain", value, why: "template-variable" },
    );
  }
  if (
    agent.world === "postgres" &&
    !entries.some((e) => e.name === WORLD_DATABASE)
  )
    entries.push({
      name: WORLD_DATABASE,
      source: "runtime",
      why: "world-database",
    });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  if (options.resolve) {
    const providers = result.ir.secrets.providers;
    const isEnv = (ref: string) => providerType(ref, providers).type === "env";
    const refs = [
      ...new Set(entries.flatMap((e) => (e.ref === undefined ? [] : [e.ref]))),
    ];
    const provided = options.provided ?? {};
    const given = (ref: string) => Object.hasOwn(provided, ref) && isEnv(ref);
    // Never a value in the message: only the refs.
    const unused = Object.keys(provided).filter(
      (ref) => !refs.includes(ref) || !isEnv(ref),
    );
    if (unused.length > 0 && options.unused !== "ignore") {
      throw new CliError(
        "env-not-used",
        `${name} has no env-provider secret ${unused.join(", ")}`,
        { refs: unused },
      );
    }
    const mode = options.refs ?? "all";
    const noShell = refs.filter(
      (ref) => mode === "not-env" && isEnv(ref) && !given(ref),
    );
    if (noShell.length > 0) {
      throw unresolved(
        noShell.map((ref) => ({ ref, reason: "no shell environment" })),
        entries,
        providers,
      );
    }
    let values: Record<string, string>;
    try {
      values = await resolveSecrets(
        refs.filter(
          (ref) =>
            !given(ref) && (mode === "all" || (mode === "env") === isEnv(ref)),
        ) as `secret://${string}`[],
        providers,
        secretContext(io),
        { loadBackend: backendLoader(ctx, io.env) },
      );
    } catch (error) {
      if (!(error instanceof SecretResolutionError)) throw error;
      throw unresolved(error.failures, entries, providers);
    }
    for (const ref of refs) if (given(ref)) values[ref] = provided[ref]!;
    for (const e of entries) {
      const value = e.ref === undefined ? undefined : values[e.ref];
      if (value !== undefined) e.value = value;
    }
  }
  return { root, dir, entries, result, manifest };
}

/**
 * A `secret-unresolved` of env-provider refs, with the fix for a command donn ui started: it has
 * no shell environment (docs/planning/26-gui.md §2). Any other error is returned as it is.
 */
export function noShellFix(
  error: unknown,
  command: "run" | "deploy",
  name: string,
): unknown {
  if (!(error instanceof CliError) || error.code !== "secret-unresolved")
    return error;
  const failures = (error.details["failures"] ?? []) as {
    ref?: string;
    type?: string;
  }[];
  const refs = failures.filter((f) => f.type === "env").map((f) => f.ref);
  if (refs.length === 0) return error;
  return new CliError(error.code, error.message, {
    ...error.details,
    fix: `a ${command} started from donn ui has no shell environment: use the keychain provider for ${refs.join(" and ")}, or run donn agent ${command} ${name} in a terminal`,
  });
}

/** `secret-unresolved`, naming each failed ref's variable and its provider type. */
function unresolved(
  failures: { ref: string; reason: string }[],
  entries: EnvEntry[],
  providers: Record<string, { type: string }>,
): CliError {
  const byRef = new Map(entries.map((e) => [e.ref, e.name]));
  return new CliError(
    "secret-unresolved",
    `cannot resolve ${failures
      .map((f) => `${byRef.get(f.ref) ?? "?"} (${f.ref}): ${f.reason}`)
      .join("; ")}`,
    {
      failures: failures.map((f) => ({
        name: byRef.get(f.ref) ?? "",
        ref: f.ref,
        reason: f.reason,
        ...providerType(f.ref, providers),
      })),
    },
  );
}

/**
 * The values of the agent's env-provider refs, by ref, resolved in this process's environment:
 * what a terminal `agent run` sends the daemon (spec 26 §2). A ref unset here fails.
 */
export async function envSecrets(
  ctx: Context,
  io: CliIo,
  name: string,
  check?: (target: string) => void,
): Promise<Record<string, string>> {
  const { entries } = await agentEnvironment(ctx, io, name, {
    resolve: true,
    refs: "env",
    ...(check && { check }),
  });
  const values: Record<string, string> = {};
  for (const e of entries)
    if (e.ref !== undefined && e.value !== undefined) values[e.ref] = e.value;
  return values;
}

/** The provider type a ref resolves with, when known: `{ type }`, else nothing. */
function providerType(
  ref: string,
  providers: Record<string, { type: string }>,
): { type?: string } {
  const provider = parseSecretRef(ref)?.provider;
  if (provider === undefined) return {};
  const type =
    providers[provider]?.type ??
    (BUILT_IN_TYPES.includes(provider) ? provider : undefined);
  return type === undefined ? {} : { type };
}

/**
 * The agent's plain values, for `eve build`: it evaluates the agent's modules, which may read
 * them at load. Never a secret nor a run-time entry (the route token).
 */
export function plainEnv(entries: EnvEntry[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const e of entries)
    if (e.source === "plain" && e.value !== undefined && e.name !== ROUTE_TOKEN)
      env[e.name] = e.value;
  return env;
}

/**
 * A digest of what an agent's env is made from: each entry's name, source and ref, and a plain
 * entry's value. Never a secret's value nor a run-time one (the route token), resolved or not,
 * so it changes only when the persona's inputs do.
 */
export function envInputs(entries: EnvEntry[]): string {
  const inputs = entries.map((e) => [
    e.name,
    e.source,
    e.ref ?? null,
    e.source === "plain" ? (e.value ?? "") : null,
  ]);
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}

/** The entries of `agentEnvironment`, for callers that only want the list. */
export async function agentEnv(
  ctx: Context,
  io: CliIo,
  name: string,
  options: { resolve: boolean },
): Promise<EnvEntry[]> {
  return (await agentEnvironment(ctx, io, name, options)).entries;
}

/**
 * NAME=value lines. A secret without its value is `NAME=` and its ref as a comment; a value set
 * at run time is a comment line only, so loading the file never overrides the real value.
 */
export function formatDotenv(entries: EnvEntry[]): string {
  return entries
    .map((e) => {
      if (e.source === "runtime")
        return `# ${e.name}: set at run time (${e.why})`;
      if (e.source === "plain" || e.value !== undefined)
        return `${e.name}=${quote(e.value ?? "")}`;
      return `${e.name}= # ${e.ref}`;
    })
    .map((line) => `${line}\n`)
    .join("");
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]*$/.test(value) ? value : JSON.stringify(value);
}

/** Runs `command` in the agent's folder with its env resolved; returns the exit code. */
export async function exec(
  ctx: Context,
  io: CliIo,
  name: string,
  command: string[],
): Promise<number> {
  const [program, ...args] = command;
  if (program === undefined) {
    throw new CliError(
      "exec-no-command",
      "nothing to run; give a command after `--`",
      { fix: `donn agent exec ${name} -- <command>` },
    );
  }
  const { dir, entries } = await agentEnvironment(ctx, io, name, {
    resolve: true,
  });
  const values: Record<string, string> = {};
  for (const e of entries) if (e.value !== undefined) values[e.name] = e.value;
  // A runtime value (the route token, the world database) is the caller's to set.
  const child = (io.spawn ?? nodeSpawn)(program, args, {
    cwd: dir,
    env: eveEnv(io.env, values),
    onLine: (line, stream) =>
      (stream === "stderr" ? io.stderr : io.stdout).write(`${line}\n`),
  });
  // As a container's entrypoint this is the process that gets the signal; pass it on, so the
  // child (which holds the resolved secrets) is not orphaned.
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  const handlers = SIGNALS.map((s) => [s, forward(s)] as const);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    return await child.exited;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}
