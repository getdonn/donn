import { resolveSecrets, SecretResolutionError } from "@getdonn/secrets";
import type { CliIo } from "../cli.js";
import { printWarnings, type Context } from "../context.js";
import { CliError } from "../errors.js";
import { backendLoader } from "../plugins.js";
import { secretContext } from "../secret-context.js";
import { eveEnv } from "./eve.js";
import { posixRelative } from "./files.js";
import { compile, compileInputs } from "./inputs.js";
import { nodeSpawn } from "./spawn.js";
import { locateAgent, resolveProject } from "./sync.js";

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
const WORLD_DATABASE = "WORKFLOW_POSTGRES_URL";

export interface AgentEnvironment {
  /** The agent's folder. */
  dir: string;
  entries: EnvEntry[];
}

/** The agent's folder and its env entries; values only for secrets, and only with `resolve`. */
export async function agentEnvironment(
  ctx: Context,
  io: CliIo,
  name: string,
  options: { resolve: boolean },
): Promise<AgentEnvironment> {
  const project = await resolveProject(ctx);
  if (project === undefined) {
    throw new CliError(
      "no-project-persona",
      "no project persona here; an agent is declared in the repo's project persona",
      { fix: "donn init --extends <persona>" },
    );
  }
  const { root, result } = project;
  printWarnings(io, result);
  const agent = result.ir.agents[name];
  if (agent === undefined) {
    throw new CliError(
      "agent-not-declared",
      `the persona declares no agent ${name}`,
      {
        agent: name,
        fix: `donn agent create ${name} --template <…> --target <…>`,
      },
    );
  }
  const { dir, manifest } = await locateAgent(ctx, root, name, agent);
  if (manifest === undefined || manifest.state !== "complete") {
    throw new CliError(
      "agent-not-created",
      `agent ${name} is not created (nothing complete at ${posixRelative(root, dir)})`,
      { agent: name, fix: `donn agent create ${name}` },
    );
  }
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
  return { dir, entries };
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

/** NAME=value lines; a secret without its value is `NAME=` and its ref as a comment. */
export function formatDotenv(entries: EnvEntry[]): string {
  return entries
    .map((e) => {
      if (e.source === "plain" || e.value !== undefined)
        return `${e.name}=${quote(e.value ?? "")}`;
      return e.ref === undefined
        ? `${e.name}= # ${e.why}`
        : `${e.name}= # ${e.ref}`;
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
  return child.exited;
}
