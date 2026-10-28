import { rm } from "node:fs/promises";
import { add, type AddOptions } from "../agent/add.js";
import { build, type BuildOptions } from "../agent/build.js";
import { deploy, type DeployOptions } from "../agent/deploy.js";
import { create, type CreateOptions } from "../agent/create.js";
import { agentEnv, exec, formatDotenv } from "../agent/env.js";
import {
  locateAgent,
  noProjectPersona,
  projectContext,
  resolveProject,
} from "../agent/load.js";
import { agentStates, formatRows } from "../agent/list.js";
import { logs, run, stop, type RunOptions } from "../agent/run.js";
import { sync, type SyncOptions } from "../agent/sync.js";
import { templateRows } from "../agent/template.js";
import {
  assertNotInside,
  commitVendor,
  defaultTemplateName,
  parseVendorSource,
  readVendored,
  stageVendor,
} from "../agent/vendor.js";
import type { CliIo } from "../cli.js";
import { userHomeDir } from "../userhome.js";

// donn agent: build, run and deploy agents on a persona. See docs/planning/25-agent-runner.md.

export interface AgentOptions {
  json?: boolean;
  /** The agent project's folder; resolved with the project in a later step. */
  project?: string;
}

/** `donn agent list`: the project persona's agents and where each stands. */
export async function agentListCommand(
  io: CliIo,
  options: AgentOptions,
): Promise<number> {
  const ctx = await projectContext(io, options.project);
  const agents = await agentStates(ctx, io);
  io.stdout.write(
    options.json
      ? `${JSON.stringify({ agents }, null, 2)}\n`
      : formatRows(agents),
  );
  return 0;
}

/** `donn agent sync <name>`: see agent/sync.ts. */
export async function agentSyncCommand(
  io: CliIo,
  name: string,
  options: SyncOptions,
): Promise<number> {
  return sync(io, name, options);
}

/** `donn agent create <name>`: see agent/create.ts. */
export async function agentCreateCommand(
  io: CliIo,
  name: string,
  options: CreateOptions,
): Promise<number> {
  return create(io, name, options);
}

export interface EnvOptions extends AgentOptions {
  resolve?: boolean;
  format?: "dotenv" | "json";
}

/** `donn agent env <name>`: see agent/env.ts. */
export async function agentEnvCommand(
  io: CliIo,
  name: string,
  options: EnvOptions,
): Promise<number> {
  const ctx = await projectContext(io, options.project);
  const env = await agentEnv(ctx, io, name, {
    resolve: options.resolve === true,
  });
  io.stdout.write(
    options.json || options.format === "json"
      ? `${JSON.stringify({ env }, null, 2)}\n`
      : formatDotenv(env),
  );
  return 0;
}

/** `donn agent exec <name> -- <command>…`: see agent/env.ts. */
export async function agentExecCommand(
  io: CliIo,
  name: string,
  command: string[],
  options: AgentOptions,
): Promise<number> {
  return exec(await projectContext(io, options.project), io, name, command);
}

/** `donn agent run <name> [--dev]`: see agent/run.ts. */
export async function agentRunCommand(
  io: CliIo,
  name: string,
  options: RunOptions,
): Promise<number> {
  return run(io, name, options);
}

/** `donn agent stop <name>`: see agent/run.ts. */
export async function agentStopCommand(
  io: CliIo,
  name: string,
  options: AgentOptions,
): Promise<number> {
  return stop(io, name, options);
}

/** `donn agent logs <name> [--follow]`: see agent/run.ts. */
export async function agentLogsCommand(
  io: CliIo,
  name: string,
  options: AgentOptions & { follow?: boolean },
): Promise<number> {
  return logs(io, name, options);
}

/** `donn agent build <name>`: see agent/build.ts. */
export async function agentBuildCommand(
  io: CliIo,
  name: string,
  options: BuildOptions,
): Promise<number> {
  return build(io, name, options);
}

/** `donn agent deploy <name>`: see agent/deploy.ts. */
export async function agentDeployCommand(
  io: CliIo,
  name: string,
  options: DeployOptions,
): Promise<number> {
  return deploy(io, name, options);
}

/** `donn agent add <name> <item>`: see agent/add.ts. */
export async function agentAddCommand(
  io: CliIo,
  name: string,
  item: string,
  options: AddOptions,
): Promise<number> {
  return add(io, name, item, options);
}

/**
 * `donn agent templates`: the templates `create --template eve:<slug>` takes, and the ones
 * vendored into this project (none outside a project).
 */
export async function agentTemplatesCommand(
  io: CliIo,
  options: { json?: boolean; project?: string },
): Promise<number> {
  const templates = templateRows();
  const ctx = await projectContext(io, options.project);
  if (ctx.projectDir === undefined && options.project !== undefined) {
    throw noProjectPersona();
  }
  const records =
    ctx.projectDir === undefined ? {} : await readVendored(ctx.projectDir);
  const vendored = Object.entries(records)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, r]) => ({
      name,
      template: `./templates/${name}`,
      source: r.source,
      ...(r.ref !== undefined && { ref: r.ref }),
      ...(r.commit !== undefined && { commit: r.commit }),
    }));
  if (options.json) {
    io.stdout.write(`${JSON.stringify({ templates, vendored }, null, 2)}\n`);
    return 0;
  }
  for (const t of templates) {
    const tags = [
      t.vercelOnly ? "Vercel-only services" : undefined,
      t.services.length > 0 ? t.services.join(", ") : undefined,
    ].filter(Boolean);
    io.stdout.write(
      `eve:${t.slug}  ${t.title}${tags.length > 0 ? `  (${tags.join("; ")})` : ""}\n`,
    );
  }
  for (const v of vendored) {
    io.stdout.write(
      `${v.template}  vendored from ${v.source}${v.ref !== undefined ? `#${v.ref}` : ""}${v.commit !== undefined ? ` (${v.commit.slice(0, 7)})` : ""}\n`,
    );
  }
  return 0;
}

/** `donn agent vendor`: copy a template into `.donn/templates/<name>` and record its source. */
export async function agentVendorCommand(
  io: CliIo,
  given: string,
  options: { name?: string; force?: boolean; project?: string; json?: boolean },
): Promise<number> {
  const ctx = await projectContext(io, options.project);
  const project = await resolveProject(ctx);
  if (project === undefined) throw noProjectPersona();
  const { root, result } = project;
  const donnDir = ctx.projectDir!;
  const source = parseVendorSource(
    given,
    io.cwd,
    userHomeDir(io.env, io.passwdHome),
  );
  const agentPaths: string[] = [];
  for (const [name, agent] of Object.entries(result.ir.agents)) {
    agentPaths.push((await locateAgent(ctx, root, name, agent)).dir);
  }
  assertNotInside(source, root, agentPaths);
  const name = options.name ?? defaultTemplateName(source);
  const refreshing = Object.hasOwn(await readVendored(donnDir), name);
  const staged = await stageVendor(io, source, { name });
  let changes;
  try {
    changes = await commitVendor(donnDir, staged, {
      ...(options.force !== undefined && { force: options.force }),
      now: io.now ?? Date.now,
      io,
    });
  } finally {
    await rm(staged.dir, { recursive: true, force: true });
  }
  const path = `.donn/templates/${staged.name}`;
  if (options.json) {
    const template = {
      name: staged.name,
      path,
      source: staged.source,
      ...(staged.ref !== undefined && { ref: staged.ref }),
      ...(staged.commit !== undefined && { commit: staged.commit }),
      digest: staged.digest,
    };
    io.stdout.write(`${JSON.stringify({ template, ...changes }, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(
    refreshing
      ? `refreshed ${staged.name}: ${changes.added.length} added, ${changes.changed.length} changed, ${changes.removed.length} removed\n`
      : `vendored ${staged.name} into ${path} (${staged.files.length} files)\n`,
  );
  io.stdout.write(
    "agents created from it before keep their files; only agents created from now on get this copy\n",
  );
  return 0;
}
