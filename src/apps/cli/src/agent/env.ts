import { createHash } from "node:crypto";
import { resolveSecrets, SecretResolutionError } from "@getdonn/secrets";
import type { CliIo } from "../cli.js";
import type { Context } from "../context.js";
import { CliError } from "../errors.js";
import { backendLoader } from "../plugins.js";
import { secretContext } from "../secret-context.js";
import { eveEnv } from "./eve.js";
import { compile, compileInputs } from "./inputs.js";
import { nodeSpawn } from "./spawn.js";
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
    const refs = entries.flatMap((e) => (e.ref === undefined ? [] : [e.ref]));
    let values: Record<string, string>;
    try {
      values = await resolveSecrets(
        [...new Set(refs)] as `secret://${string}`[],
        result.ir.secrets.providers,
        secretContext(io),
        { loadBackend: backendLoader(ctx, io.env) },
      );
    } catch (error) {
      if (!(error instanceof SecretResolutionError)) throw error;
      const byRef = new Map(entries.map((e) => [e.ref, e.name]));
      throw new CliError(
        "secret-unresolved",
        `cannot resolve ${error.failures
          .map((f) => `${byRef.get(f.ref) ?? "?"} (${f.ref}): ${f.reason}`)
          .join("; ")}`,
        {
          failures: error.failures.map((f) => ({
            name: byRef.get(f.ref) ?? "",
            ref: f.ref,
            reason: f.reason,
          })),
        },
      );
    }
    for (const e of entries) if (e.ref !== undefined) e.value = values[e.ref]!;
  }
  return { root, dir, entries };
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
