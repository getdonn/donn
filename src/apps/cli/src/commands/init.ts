import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createLocalStore } from "@zzpersona/store-local";
import { isMap, parseDocument, stringify } from "yaml";
import type { CliIo } from "../cli.js";
import { expandPath, loadConfig } from "../config.js";
import { createContext, homeOf, resolvePersona } from "../context.js";
import { CliError } from "../errors.js";
import { fsStep, writeFileAtomic } from "../fs.js";
import { selectPersona } from "../select.js";

// zzpersona init, flags only: --personas sets up this machine, --extends sets up a project.
// See docs/planning/07-cli-daily-use.md, section 2.

export interface InitOptions {
  personas?: string;
  extends?: string;
  force?: boolean;
  json?: boolean;
}

const STARTER = `# A starter persona. Every persona in this folder can extend it with \`extends: [org/base]\`.
# The persona format and how layers merge: docs/planning/02-persona-spec.md in zzpersona.
apiVersion: zzpersona/v0
kind: Persona
metadata:
  name: base
  description: Baseline for every persona
instructions:
  - id: conduct
    inline: |
      Explain what you are about to change before changing it.
permissions:
  deny:
    - "Bash(rm -rf:*)"
`;

/**
 * config.yaml with `personas` set, editing the existing document so its other keys and its
 * comments survive; a config that does not parse is replaced (`--force` got us here).
 */
async function configWithPersonas(
  file: string,
  personas: string,
): Promise<string> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text !== undefined) {
    const doc = parseDocument(text);
    if (
      doc.errors.length === 0 &&
      (doc.contents === null || isMap(doc.contents))
    ) {
      doc.set("personas", personas);
      return doc.toString();
    }
  }
  return stringify({ personas });
}

interface Changes {
  created: string[];
  updated: string[];
  tips: string[];
}

async function initPersonas(
  io: CliIo,
  dir: string,
  force: boolean,
  out: Changes,
) {
  const home = homeOf(io);
  const target = expandPath(dir, io.cwd, io.env);
  const configFile = join(home, "config.yaml");
  const hadConfig = existsSync(configFile);
  let current: string | undefined;
  try {
    current = (await loadConfig(home, io.env)).personas;
  } catch (error) {
    // --force replaces a config that does not parse; without it, report the config.
    if (!(
      force &&
      error instanceof CliError &&
      error.code === "invalid-config"
    ))
      throw error;
  }
  if (current !== undefined && current !== target && !force) {
    throw new CliError(
      "config-exists",
      `${configFile} already sets personas: ${current}; pass --force to replace it`,
      { file: configFile, current },
    );
  }
  // The folder first: a folder that cannot be created leaves the config as it was.
  await fsStep(target, () => mkdir(target, { recursive: true }));
  if (current !== target) {
    const content = await configWithPersonas(configFile, target);
    await fsStep(configFile, () => writeFileAtomic(configFile, content));
    (hadConfig ? out.updated : out.created).push(configFile);
  }
  const existing = await createLocalStore({
    personas: target,
    user: home,
  }).list();
  const starter = join(target, "org/base.yaml");
  if (
    !existing.some((ref) => !ref.startsWith("user/")) &&
    !existsSync(starter)
  ) {
    await fsStep(starter, () => writeFileAtomic(starter, STARTER));
    out.created.push(starter);
  }
  if (!existsSync(join(target, ".git"))) {
    out.tips.push(`tip: run \`git init\` in ${target} to track your personas`);
  }
}

async function initProject(
  io: CliIo,
  persona: string,
  force: boolean,
  out: Changes,
) {
  const ctx = await createContext(io);
  const selection = await selectPersona(persona, ctx);
  if (selection.ref.startsWith("project/")) {
    throw new CliError(
      "invalid-extends",
      "a project persona cannot extend a project persona",
      { ref: selection.ref },
    );
  }
  await resolvePersona(ctx, selection, false);
  const file = join(io.cwd, ".zzpersona/persona.yaml");
  const existed = existsSync(file);
  if (existed && !force) {
    throw new CliError(
      "persona-exists",
      `${file} already exists; pass --force to replace it`,
      { file },
    );
  }
  await fsStep(file, () =>
    writeFileAtomic(
      file,
      stringify({
        apiVersion: "zzpersona/v0",
        kind: "Persona",
        metadata: { name: basename(io.cwd) },
        extends: [selection.ref],
      }),
    ),
  );
  (existed ? out.updated : out.created).push(file);
}

export async function initCommand(
  io: CliIo,
  options: InitOptions,
): Promise<number> {
  if (options.personas === undefined && options.extends === undefined) {
    throw new CliError(
      "init-needs-flags",
      [
        "init needs --personas and/or --extends:",
        "  zzpersona init --personas ~/personas     set up this machine's personas folder",
        "  zzpersona init --extends team/payments   make this directory a project",
      ].join("\n"),
    );
  }
  const out: Changes = { created: [], updated: [], tips: [] };
  if (options.personas !== undefined) {
    await initPersonas(io, options.personas, options.force === true, out);
  }
  if (options.extends !== undefined) {
    try {
      await initProject(io, options.extends, options.force === true, out);
    } catch (error) {
      // Report what --personas already did, so a half-finished init is visible.
      const done = [...out.created, ...out.updated];
      if (done.length > 0 && error instanceof CliError) {
        throw new CliError(
          error.code,
          `${error.message}\n(--personas had already written ${done.join(", ")})`,
          {
            ...error.details,
            created: out.created,
            updated: out.updated,
          },
        );
      }
      if (done.length > 0) {
        io.stderr.write(
          `${[...out.created.map((p) => `created ${p}`), ...out.updated.map((p) => `updated ${p}`)].join("\n")}\n`,
        );
      }
      throw error;
    }
  }
  if (options.json) {
    io.stdout.write(
      `${JSON.stringify({ created: out.created, updated: out.updated }, null, 2)}\n`,
    );
  } else {
    const lines = [
      ...out.created.map((p) => `created ${p}`),
      ...out.updated.map((p) => `updated ${p}`),
      ...out.tips,
    ];
    io.stdout.write(
      `${(lines.length > 0 ? lines : ["nothing to do"]).join("\n")}\n`,
    );
  }
  return 0;
}
