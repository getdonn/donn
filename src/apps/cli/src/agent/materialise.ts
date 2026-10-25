import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import type { CliIo } from "../cli.js";
import { CliError } from "../errors.js";
import { fsStep } from "../fs.js";
import { eveEnv, runTool } from "./eve.js";
import { notTemplate } from "./files.js";
import { fetchTemplate } from "./template.js";

// Step 4 of `donn agent create`, in two halves. `stageTemplate` builds the template in a fresh
// staging folder outside the project (eve init edits the nearest ancestor workspace, so it never
// runs inside the repo), where the compile reads its facts and the reports print before anything
// is written to the agent's path; `placeTemplate` then moves it into place.
// See docs/planning/25-agent-runner.md, section 2.

export type TemplateSource =
  /** `eve:<slug>`: the eve repository's tarball at TEMPLATES_AT, verified by digest. */
  | { kind: "eve"; slug: string }
  /** `eve:blank`: `eve init` into a minimal package. */
  | { kind: "blank"; name: string }
  /** A path template: a folder on disk. */
  | { kind: "path"; dir: string };

/** The nearest `pnpm-workspace.yaml` or `package.json` above `dir`, if any. */
function ancestorWorkspace(dir: string): string | undefined {
  for (let at = dirname(dir); ; at = dirname(at)) {
    for (const name of ["pnpm-workspace.yaml", "package.json"]) {
      if (existsSync(join(at, name))) return join(at, name);
    }
    if (dirname(at) === at) return undefined;
  }
}

/** Removes every `.git` (a folder, or a worktree's file) below `dir`: never a nested repository. */
async function removeGit(dir: string): Promise<void> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const gits = entries
    .filter((e) => e.name === ".git")
    .map((e) => join(e.parentPath, e.name))
    .sort((a, b) => a.length - b.length);
  for (const git of gits) {
    // Only inside the staging folder, and only `.git` entries.
    if (!git.startsWith(dir + sep) || basename(git) !== ".git") continue;
    await rm(git, { recursive: true, force: true });
  }
}

async function runInit(
  io: CliIo,
  staging: string,
  name: string,
  version: string,
  onProgress?: (line: string) => void,
): Promise<void> {
  const found = ancestorWorkspace(staging);
  if (found !== undefined) {
    throw new CliError(
      "ancestor-workspace",
      `eve init would edit ${found}, a package above the staging folder ${staging}`,
      {
        file: found,
        fix: "set TMPDIR to a folder with no package.json or pnpm-workspace.yaml above it",
      },
    );
  }
  await writeFile(
    join(staging, "package.json"),
    `${JSON.stringify({ name, private: true, type: "module" }, null, 2)}\n`,
  );
  // The pinned eve, run once from pnpm's store: the agent has no eve of its own yet.
  const args = [
    `--package=eve@${version}`,
    "dlx",
    "eve",
    "init",
    staging,
    "--non-interactive",
  ];
  const result = await runTool(io, staging, "pnpm", args, {
    env: eveEnv(io.env, {}),
    ...(onProgress && { onProgress }),
  });
  if (result.exitCode !== 0) {
    throw new CliError(
      "eve-failed",
      `eve init exited ${result.exitCode}: ${result.tail.at(-1) ?? "no output"}`,
      {
        command: `pnpm ${args.join(" ")}`,
        exitCode: result.exitCode,
        tail: result.tail,
      },
    );
  }
}

/**
 * Builds the template in a new staging folder (under `stagingBase`, the system's temporary
 * folder by default) and returns it; the caller removes it. No `.git` survives.
 */
export async function stageTemplate(
  io: CliIo,
  source: TemplateSource,
  version: string,
  options: { stagingBase?: string; onProgress?: (line: string) => void } = {},
): Promise<string> {
  const base = options.stagingBase ?? tmpdir();
  await mkdir(base, { recursive: true });
  const staging = await mkdtemp(join(base, "donn-agent-"));
  try {
    if (source.kind === "eve") {
      const files = await fetchTemplate(io, source.slug);
      for (const [path, file] of files) {
        const target = join(staging, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.data, { mode: file.mode });
      }
    } else if (source.kind === "blank") {
      await runInit(io, staging, source.name, version, options.onProgress);
    } else {
      await fsStep(source.dir, () =>
        cp(source.dir, staging, {
          recursive: true,
          verbatimSymlinks: true,
          filter: (path) =>
            !notTemplate(relative(source.dir, path).split(sep).join("/")),
        }),
      );
    }
    await removeGit(staging);
    return staging;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Copies the staged template into `dir` (missing or empty), without the staged install. */
export async function placeTemplate(
  staging: string,
  dir: string,
): Promise<void> {
  await fsStep(dir, async () => {
    await mkdir(dir, { recursive: true });
    await cp(staging, dir, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (path) =>
        relative(staging, path).split(sep)[0] !== "node_modules",
    });
  });
}
