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
import { CliError, errorEnvelope } from "../errors.js";
import { fsStep, writeFileAtomic } from "../fs.js";
import {
  addedLines,
  declareAgent,
  resolveEdited,
  writeDeclaration,
} from "./declare.js";
import {
  posixRelative,
  readManifest,
  writeAgentFiles,
  writeManifest,
  type Manifest,
} from "./files.js";
import {
  assertNotInside,
  assertTemplateName,
  commitVendor,
  defaultTemplateName,
  isVendorSource,
  parseVendorSource,
  readVendored,
  removeVendored,
  stageVendor,
  type StagedVendor,
  type VendorSource,
} from "./vendor.js";
import { locateAgent } from "./load.js";
import { userHomeDir } from "../userhome.js";
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
import { editSubagents } from "./subagents.js";

// `donn agent create <name>`: declare the agent if needed, resolve and report, pin eve,
// materialise the template, install, edit agent.ts, write donn's files and the manifest, keep
// build output out of Git. See docs/planning/25-agent-runner.md, section 2. The pin and the
// staging of the template come before the compile, which needs both; nothing is written to the
// agent's path or the persona until the reports have printed and no blocking entry stopped the
// create.

const PROJECT_PERSONA = "project/persona";

export interface CreateOptions {
  template?: string;
  /** The name a vendored `--template` source is kept under (default: from the source). */
  templateName?: string;
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

const vendoredPath = (staged: StagedVendor) => `.donn/templates/${staged.name}`;

const vendoredJson = (staged: StagedVendor) => ({
  name: staged.name,
  path: vendoredPath(staged),
  source: staged.source,
});

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

/**
 * A failure after materialising: the folder stays, and `--force` starts again. Any error the
 * user can act on says so; an unknown one (a bug) is returned as it is.
 */
export function leftForInspection(
  error: unknown,
  name: string,
  dir: string,
  shown: string,
): unknown {
  const known = errorEnvelope(error);
  if (known === undefined) return error;
  const again = `donn agent create ${name} --force`;
  const fix = known.details["fix"];
  return new CliError(
    known.code,
    `${known.message}\n${shown} is left for inspection; \`${again}\` removes it and starts again`,
    {
      ...known.details,
      dir,
      fix: typeof fix === "string" ? `${fix}; then ${again}` : again,
    },
  );
}

async function resolveAndDeclare(
  ctx: Context,
  name: string,
  options: CreateOptions,
  /** What the persona declares for `--template`: a vendor source is `./templates/<name>`. */
  declaredTemplate: string | undefined,
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
    const differ = conflicts(declared, {
      ...options,
      template: declaredTemplate,
    });
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
  if (declaredTemplate === undefined || options.target === undefined) {
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
      template: declaredTemplate,
      target: options.target,
      ...(options.path !== undefined && { path: options.path }),
    },
    {
      // Written by `create` once nothing can refuse the agent any more.
      dryRun: true,
      check: async (text) => {
        result = await resolveEdited(ctx, text);
      },
    },
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

  // A vendor source is read now (nothing is copied yet) and declared as its vendored path.
  let vendorSource: VendorSource | undefined;
  let vendorName: string | undefined;
  if (options.template !== undefined && isVendorSource(options.template)) {
    vendorSource = parseVendorSource(
      options.template,
      io.cwd,
      userHomeDir(io.env, io.passwdHome),
    );
    vendorName = options.templateName ?? defaultTemplateName(vendorSource);
    assertTemplateName(vendorName, "--template-name");
  }

  // 1. Declare if needed: resolved with the edit now, written only once nothing refuses.
  const { result, edit } = await resolveAndDeclare(
    ctx,
    name,
    options,
    vendorName === undefined ? options.template : `./templates/${vendorName}`,
  );
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

  // A vendor source is copied to a staging folder (outside the project), which then stands in
  // for the template; it moves into `.donn/templates` just before the persona is written.
  let staged: StagedVendor | undefined;
  if (edit && vendorSource !== undefined) {
    const agentPaths: string[] = [];
    for (const [other, declared] of Object.entries(result.ir.agents))
      agentPaths.push((await locateAgent(ctx, root, other, declared)).dir);
    assertNotInside(vendorSource, root, agentPaths);
    staged = await stageVendor(io, vendorSource, { name: vendorName! });
  }
  const stagedVendor = staged;
  const createFrom = async (): Promise<number> => {
    const source: TemplateSource = stagedVendor
      ? { kind: "path", dir: stagedVendor.dir }
      : templateSource(ctx, name, agent.template);

    // 2. Resolve and report. A dry run compiles without the template's files.
    if (options.dryRun) {
      const output = compile(
        await inputsFor(ctx, result.ir, name, version, []),
      );
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
              ...(stagedVendor && { vendored: vendoredJson(stagedVendor) }),
            },
            null,
            2,
          )}\n`,
        );
        return 0;
      }
      if (stagedVendor) {
        io.stdout.write(
          `would vendor ${stagedVendor.source} into ${vendoredPath(stagedVendor)}\n`,
        );
      }
      if (edit) {
        io.stdout.write(`would add to ${posixRelative(root, edit.file)}:\n`);
        for (const line of addedLines(edit.before, edit.after))
          io.stdout.write(`+ ${line}\n`);
      }
      io.stdout.write(
        `would create ${shown}: eve ${version}, template ${agent.template}, target ${agent.target}\n` +
          `  donn files: ${Object.keys(files).join(", ")}\n` +
          (stagedVendor
            ? "  (the template was staged to check it and nothing was written; its own files can change the reports)\n"
            : "  (a dry run does not fetch the template; its own files can change the reports)\n"),
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
      // The vendored copy goes in last, then the persona; a failed persona write takes a copy
      // this create added back out (a refreshed one stays, as the refresh already happened).
      let undo: (() => Promise<void>) | undefined;
      let added = false;
      if (stagedVendor) {
        added = !Object.hasOwn(
          await readVendored(ctx.projectDir!),
          stagedVendor.name,
        );
        const changes = await commitVendor(ctx.projectDir!, stagedVendor, {
          now: io.now ?? Date.now,
          io,
          sameSource: true,
          fixes: {
            otherSource: `--template-name <another-name>, or donn agent vendor ${stagedVendor.source} --name ${stagedVendor.name} to replace it`,
            nameTaken:
              "--template-name <another-name>, or move the folder away",
            localEdits: `donn agent vendor ${stagedVendor.source} --name ${stagedVendor.name} --force`,
          },
        });
        if (added)
          undo = () => removeVendored(ctx.projectDir!, stagedVendor.name);
        if (!options.json)
          io.stderr.write(
            added
              ? `vendored ${stagedVendor.source} into ${vendoredPath(stagedVendor)}\n`
              : `refreshed ${stagedVendor.name}: ${changes.added.length} added, ${changes.changed.length} changed, ${changes.removed.length} removed\n`,
          );
      }
      if (edit) {
        try {
          await writeDeclaration(edit);
        } catch (error) {
          await undo?.();
          if (stagedVendor && !added)
            io.stderr.write(
              `${vendoredPath(stagedVendor)} was refreshed from ${stagedVendor.source} and kept; the persona was not changed\n`,
            );
          throw error;
        }
        if (!options.json)
          io.stderr.write(
            `declared agents.define.${name} in ${posixRelative(root, edit.file)}\n`,
          );
      }
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
      // 6. Edit agent.ts once, and with a gateway each subagent's; write donn's files.
      const agentTs = await editAgentTs(dir);
      edits.push(
        "agent/agent.ts",
        ...(await editSubagents(dir, result.ir, [])),
      );
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
            ...(stagedVendor && { vendored: vendoredJson(stagedVendor) }),
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
  };
  try {
    return await createFrom();
  } finally {
    if (staged) await rm(staged.dir, { recursive: true, force: true });
  }
}
