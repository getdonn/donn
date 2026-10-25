import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, posix, resolve as resolvePath } from "node:path";
import adapter, {
  CHANNEL_FILE,
  createdAgentTs,
  manifestFiles,
  patchAgentTs,
} from "@getdonn/adapter-eve";
import type {
  AgentCompileInput,
  AgentCompileOutput,
  PortabilityEntry,
} from "@getdonn/adapter-sdk";
import {
  normalizeRelative,
  type AgentTarget,
  type ResolvedAgent,
  type ResolveResult,
} from "@getdonn/spec";
import { createHash } from "node:crypto";
import { printReport } from "../build.js";
import type { CliIo } from "../cli.js";
import {
  createContext,
  printWarnings,
  resolvePersona,
  type Context,
} from "../context.js";
import { CliError } from "../errors.js";
import { fsStep, writeFileAtomic } from "../fs.js";
import { addedLines, declareAgent, resolveEdited } from "./declare.js";
import {
  posixRelative,
  readManifest,
  writeAgentFiles,
  writeManifest,
  type Manifest,
} from "./files.js";
import { compile, compileInputs, inputsFor } from "./inputs.js";
import {
  dependenciesFor,
  ignoreGenerated,
  install,
  prepareInstall,
  vercelVersion,
} from "./install.js";
import {
  placeTemplate,
  stageTemplate,
  type TemplateSource,
} from "./materialise.js";
import { pinEve } from "./pin.js";
import { recordCreated } from "./registry.js";

// `donn agent create <name>`: declare the agent if needed, resolve and report, pin eve,
// materialise the template, install, edit agent.ts, write donn's files and the manifest, keep
// build output out of Git. See docs/planning/25-agent-runner.md, section 2. The pin and the
// staging of the template come before the compile, which needs both; nothing is written to the
// agent's path until the reports have printed and no blocking entry stopped the create.

const PROJECT_PERSONA = "project/persona";

export interface CreateOptions {
  template?: string;
  target?: AgentTarget;
  path?: string;
  eve?: string;
  dryRun?: boolean;
  force?: boolean;
  acceptPortability?: boolean;
  json?: boolean;
  /** The project folder; the current directory's project by default. */
  project?: string;
}

const NEXT: Record<AgentTarget, string> = {
  local: "run",
  "self-host": "build",
  vercel: "deploy",
};

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

function templateSource(
  ctx: Context,
  name: string,
  template: string,
): TemplateSource {
  if (template === "eve:blank") return { kind: "blank", name };
  if (template.startsWith("eve:"))
    return { kind: "eve", slug: template.slice("eve:".length) };
  const location = ctx.store.locate(template);
  if (!location || !existsSync(location.path)) {
    throw new CliError(
      "template-not-found",
      `the path template ${template} is not ${location ? `at ${location.path}` : "inside any configured location"}`,
      { template },
    );
  }
  return { kind: "path", dir: location.path };
}

/** The flags that disagree with an agent the persona already declares. */
function conflicts(agent: ResolvedAgent, options: CreateOptions): string[] {
  const out: string[] = [];
  if (options.template !== undefined) {
    const template = options.template.startsWith("eve:")
      ? options.template
      : posix.join("project", normalizeRelative(options.template));
    if (template !== agent.template) out.push("--template");
  }
  if (options.target !== undefined && options.target !== agent.target)
    out.push("--target");
  if (
    options.path !== undefined &&
    normalizeRelative(options.path) !== agent.path
  )
    out.push("--path");
  return out;
}

async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    if (code === "ENOTDIR") return false;
    throw error;
  }
}

function printPortability(io: CliIo, entries: PortabilityEntry[]): void {
  for (const e of entries) {
    const env = e.env ? ` [env: ${e.env.join(", ")}]` : "";
    io.stderr.write(
      `${e.blocking ? "blocking" : "advisory"}: ${e.service} (${e.target}) — ${e.instead}${env}\n`,
    );
  }
}

/** Prints the reports (text mode) and stops at a blocking entry unless accepted. */
function reportAndCheck(
  io: CliIo,
  output: AgentCompileOutput,
  options: CreateOptions,
): void {
  if (!options.json) {
    printReport(io, output);
    printPortability(io, output.portability);
  }
  const blocking = output.portability.filter((e) => e.blocking);
  if (blocking.length > 0 && !options.acceptPortability) {
    const services = [...new Set(blocking.map((e) => e.service))].join(", ");
    throw new CliError(
      "portability-blocking",
      `the agent could not run at ${blocking[0]!.target} until you act on: ${services}; act on the blocking entries above, or pass --accept-portability to create it anyway`,
      {
        entries: blocking,
        fix: "act on the blocking entries, or pass --accept-portability",
      },
    );
  }
}

/** The template's agent.ts edited once, or a minimal one when it has none. */
async function editAgentTs(dir: string): Promise<"patched" | "created"> {
  const file = join(dir, "agent/agent.ts");
  let text: string | undefined;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text === undefined) {
    await fsStep(file, () => writeFileAtomic(file, createdAgentTs()));
    return "created";
  }
  const result = patchAgentTs(text);
  if (!result.ok) {
    throw new CliError(result.code, `agent/agent.ts: ${result.hint}`, {
      file,
      fix: result.hint,
    });
  }
  if (result.text !== text)
    await fsStep(file, () => writeFileAtomic(file, result.text));
  return "patched";
}

/** A failure after materialising: the folder stays, and `--force` starts again. */
function leftForInspection(
  error: unknown,
  name: string,
  dir: string,
  shown: string,
): unknown {
  if (!(error instanceof CliError)) return error;
  const again = `donn agent create ${name} --force`;
  const fix = error.details["fix"];
  return new CliError(
    error.code,
    `${error.message}\n${shown} is left for inspection; \`${again}\` removes it and starts again`,
    {
      ...error.details,
      dir,
      fix: typeof fix === "string" ? `${fix}; then ${again}` : again,
    },
  );
}

async function resolveAndDeclare(
  ctx: Context,
  io: CliIo,
  name: string,
  options: CreateOptions,
): Promise<{
  result: ResolveResult;
  edit?: { file: string; before: string; after: string };
}> {
  let result = await resolvePersona(
    ctx,
    { ref: PROJECT_PERSONA, source: "project" },
    false,
  );
  const declared = result.ir.agents[name];
  if (declared !== undefined) {
    const differ = conflicts(declared, options);
    if (differ.length > 0) {
      throw new CliError(
        "agent-declared",
        `${name} is declared in the persona (template ${declared.template}, target ${declared.target}, path ${declared.path}); ${differ.join(", ")} disagree${differ.length === 1 ? "s" : ""}`,
        {
          flags: differ,
          fix: `edit agents.define.${name} in the persona, or leave out ${differ.join(", ")}`,
        },
      );
    }
    return { result };
  }
  if (options.template === undefined || options.target === undefined) {
    throw new CliError(
      "agent-not-declared",
      `the persona declares no agent ${name}; pass --template and --target to declare it`,
      {
        agent: name,
        fix: `donn agent create ${name} --template <eve:slug|eve:blank|path> --target <local|self-host|vercel>`,
      },
    );
  }
  const file = join(ctx.projectDir!, "persona.yaml");
  const { before, after } = await declareAgent(
    file,
    name,
    {
      template: options.template,
      target: options.target,
      ...(options.path !== undefined && { path: options.path }),
    },
    {
      dryRun: options.dryRun === true,
      check: async (text) => {
        result = await resolveEdited(ctx, text);
      },
    },
  );
  if (!options.dryRun && !options.json)
    io.stderr.write(
      `declared agents.define.${name} in ${posixRelative(dirname(ctx.projectDir!), file)}\n`,
    );
  return { result, edit: { file, before, after } };
}

export async function create(
  io: CliIo,
  name: string,
  options: CreateOptions,
): Promise<number> {
  const ctx = await createContext(
    options.project === undefined
      ? io
      : { ...io, cwd: resolvePath(io.cwd, options.project) },
  );
  if (ctx.projectDir === undefined) {
    throw new CliError(
      "no-project-persona",
      "no project persona here; an agent is declared in the repo's project persona",
      { fix: "donn init --extends <persona>" },
    );
  }
  const root = dirname(ctx.projectDir);

  // 1. Declare if needed.
  const { result, edit } = await resolveAndDeclare(ctx, io, name, options);
  printWarnings(io, result);
  const userLayer = result.ir.layers.find((ref) => ref.startsWith("user/"));
  if (userLayer !== undefined) {
    throw new CliError(
      "user-layer-in-shared-file",
      `project/persona extends ${userLayer}, which only you can resolve; a committed agent cannot include it`,
      { layer: userLayer },
    );
  }
  const agent = result.ir.agents[name];
  if (agent === undefined) {
    throw new CliError(
      "agent-not-declared",
      `the resolved persona has no agent ${name} (a layer removes it)`,
      { agent: name },
    );
  }
  const dir = resolvePath(root, agent.path);
  const shown = posixRelative(root, dir);

  // The agent's path: missing or empty, or an incomplete create that --force replaces.
  const previous = await readManifest(dir);
  if (previous?.state === "complete") {
    throw new CliError(
      "agent-exists",
      `${shown} already holds agent ${previous.agent}`,
      {
        dir,
        fix: `donn agent sync ${name}`,
      },
    );
  }
  if (previous?.state === "incomplete" && !options.force) {
    throw new CliError(
      "agent-incomplete",
      `${shown} holds an incomplete create of ${previous.agent}`,
      { dir, fix: `donn agent create ${name} --force` },
    );
  }
  if (previous === undefined && !(await isEmptyDir(dir))) {
    throw new CliError(
      "agent-exists",
      `${shown} exists and is not empty; an agent is created into a new or empty folder`,
      { dir, fix: `set agents.define.${name}.path to a new folder` },
    );
  }

  // 3. Pin eve (the compile needs the version).
  const version = await pinEve(io, adapter.frameworkRange, options.eve);
  const source = templateSource(ctx, name, agent.template);

  // 2. Resolve and report. A dry run compiles without the template's files.
  if (options.dryRun) {
    const output = compile(await inputsFor(ctx, result.ir, name, version, []));
    reportAndCheck(io, output, options);
    const files = manifestFiles(output.files, sha256);
    if (options.json) {
      io.stdout.write(
        `${JSON.stringify(
          {
            agent: name,
            dir,
            dryRun: true,
            frameworkVersion: version,
            files,
            report: output.report,
            portability: output.portability,
            ...(edit && { declared: { file: edit.file, after: edit.after } }),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    if (edit) {
      io.stdout.write(`would add to ${posixRelative(root, edit.file)}:\n`);
      for (const line of addedLines(edit.before, edit.after))
        io.stdout.write(`+ ${line}\n`);
    }
    io.stdout.write(
      `would create ${shown}: eve ${version}, template ${agent.template}, target ${agent.target}\n` +
        `  donn files: ${Object.keys(files).join(", ")}\n` +
        "  (a dry run does not fetch the template; its own files can change the reports)\n",
    );
    return 0;
  }

  const vercel =
    agent.target === "vercel" ? await vercelVersion(io) : undefined;
  const progress = (line: string) => io.stderr.write(`  ${line}\n`);

  // 4. Materialise: staged outside the project, compiled and reported, then moved into place.
  const staging = await stageTemplate(io, source, version, {
    onProgress: progress,
  });
  let output: AgentCompileOutput;
  try {
    // The agent/channels/eve.ts that `eve init` scaffolds (vercelOidc, localDev,
    // placeholderAuth) is eve's boilerplate, not a template author's route auth: off Vercel,
    // eve:blank drops it so donn writes and owns its own channel. A slug or path template keeps
    // its channel (and the blocking entry with the two lines); vercel keeps eve's file.
    if (source.kind === "blank" && agent.target !== "vercel")
      await rm(join(staging, CHANNEL_FILE), { force: true });
    output = compile(
      await compileInputs(ctx, result.ir, name, staging, version),
    );
    reportAndCheck(io, output, options);
    // Only an incomplete create (its manifest says so) is removed, and only with --force.
    if (previous !== undefined)
      await fsStep(dir, () => rm(dir, { recursive: true, force: true }));
    await placeTemplate(staging, dir);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  let manifest: Manifest = {
    agent: name,
    persona: PROJECT_PERSONA,
    adapter: adapter.id,
    frameworkVersion: version,
    template: agent.template,
    target: agent.target,
    path: agent.path,
    ...(agent.world !== undefined && { world: agent.world }),
    files: {},
    edits: [],
    state: "incomplete",
  };
  await writeManifest(dir, manifest);
  try {
    // 5. Pin and add dependencies, install in place.
    const edits = await prepareInstall(
      dir,
      version,
      dependenciesFor(output.files, agent, vercel),
    );
    if (!options.json) io.stderr.write(`installing in ${shown}\n`);
    await install(io, dir, progress);
    // 6. Edit agent.ts once; write donn's files.
    const agentTs = await editAgentTs(dir);
    edits.push("agent/agent.ts");
    const files = await writeAgentFiles(dir, output, undefined, {
      force: false,
      store: ctx.store,
    });
    // 7. Ignore what must not be committed.
    if (await ignoreGenerated(dir)) edits.push(".gitignore");
    const tsconfig = await readFile(join(dir, "tsconfig.json"), "utf8").catch(
      () => undefined,
    );
    if (tsconfig !== undefined && !/"skipLibCheck"\s*:\s*true/.test(tsconfig))
      io.stderr.write(
        `warning: ${shown}/tsconfig.json does not set compilerOptions.skipLibCheck: true; the agent may not type-check with the AI SDK packages until it does\n`,
      );
    manifest = {
      ...manifest,
      files,
      agentTs,
      edits: [...new Set(edits)].sort(),
      state: "complete",
    };
    await writeManifest(dir, manifest);
  } catch (error) {
    throw leftForInspection(error, name, dir, shown);
  }
  await recordCreated(ctx.home, { project: root, name, path: agent.path });

  if (options.json) {
    io.stdout.write(
      `${JSON.stringify(
        {
          agent: name,
          dir,
          frameworkVersion: version,
          files: manifest.files,
          report: output.report,
          portability: output.portability,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  const count = Object.keys(manifest.files).length;
  io.stdout.write(
    `created ${shown}: eve ${version}, template ${agent.template}, target ${agent.target}\n` +
      `  ${count} donn file${count === 1 ? "" : "s"}; agent/agent.ts ${manifest.agentTs}; manifest ${shown}/.donn/agent.json\n` +
      `next: donn agent ${NEXT[agent.target]} ${name}\n`,
  );
  return 0;
}
