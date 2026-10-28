import { realpathSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { AgentTemplate, Id } from "@getdonn/spec";
import { z } from "zod";
import type { CliIo } from "../cli.js";
import { CliError } from "../errors.js";
import { fsStep } from "../fs.js";
import { templateDigest } from "./digest.js";
import { listFiles, notTemplate, sha256 } from "./files.js";
import type { TarFile } from "./tar.js";

// `donn agent vendor`: read a template source (a folder or a git URL), stage the copy in a
// temporary folder, check it is an eve template and digest it; then move it into
// `.donn/templates/<name>` and record where it came from in `.donn/templates/sources.json`.
// See docs/planning/25-agent-runner.md, "Amendment: vendoring a template".

export type VendorSource =
  | { kind: "dir"; dir: string; given: string }
  | { kind: "git"; url: string; ref?: string; given: string };

const GIT_URL = /^(https?|ssh|file):\/\/|^[^/@\s]+@[^:\s]+:/;

/** A folder or a git URL with an optional `#<ref>`; `~/` expands with `home`. Pure. */
export function parseVendorSource(
  given: string,
  cwd: string,
  home: string,
): VendorSource {
  if (GIT_URL.test(given)) {
    const hash = given.indexOf("#");
    if (hash === -1) return { kind: "git", url: given, given };
    const ref = given.slice(hash + 1);
    const url = given.slice(0, hash);
    return ref === ""
      ? { kind: "git", url, given }
      : { kind: "git", url, ref, given };
  }
  const path =
    given === "~" || given.startsWith("~/")
      ? join(home, given.slice(1))
      : given;
  return { kind: "dir", dir: resolve(cwd, path), given };
}

/** The source's last path segment, without `.git`. */
export function defaultTemplateName(source: VendorSource): string {
  const path = source.kind === "dir" ? source.dir : source.url;
  const last = path.replace(/\/+$/, "").split(/[/:]/).at(-1) ?? "";
  return last.replace(/\.git$/, "");
}

/** A URL without its `user[:pass]@`. */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/i, "$1");
}

export interface StagedVendor {
  name: string;
  /** The staged copy; the caller removes it. */
  dir: string;
  /** The source as given, without a URL's credentials. */
  source: string;
  ref?: string;
  /** A git source, or a folder that is a git checkout. */
  commit?: string;
  /** A folder checkout with uncommitted changes. */
  dirty?: boolean;
  digest: string;
  /** Sorted POSIX paths. */
  files: string[];
}

/** A vendored template's name: lowercase letters, digits and single dashes. */
export function assertTemplateName(name: string, flag = "--name"): void {
  if (!Id.safeParse(name).success) {
    throw new CliError(
      "invalid-template-name",
      `${JSON.stringify(name)} is not a template name: use lowercase letters, digits and single dashes`,
      { name, fix: `${flag} <lowercase-kebab-case>` },
    );
  }
}

/**
 * Whether `create --template` names something to vendor: not `eve:...` and not a relative path
 * inside the persona folder, so an absolute, `~/` or `..` path, or a git URL.
 */
export function isVendorSource(template: string): boolean {
  if (template.startsWith("eve:")) return false;
  if (template === "~" || template.startsWith("~/")) return true;
  if (parseVendorSource(template, "/", "/").kind === "git") return true;
  return !AgentTemplate.safeParse(template).success;
}

const executable = (mode: number) => (mode & 0o111 ? 0o755 : 0o644);

async function digestOf(dir: string, files: string[]): Promise<string> {
  const map = new Map<string, TarFile>();
  for (const path of files) {
    const file = join(dir, path);
    map.set(path, {
      data: await readFile(file),
      mode: executable((await stat(file)).mode),
    });
  }
  return templateDigest(map);
}

/** The files `stageVendor` keeps, digested: for comparing a vendored folder with its record. */
export async function vendorDigest(dir: string): Promise<string> {
  const files = (await listFiles(dir, notTemplate)).filter(
    (path) => !notTemplate(path),
  );
  return digestOf(dir, files);
}

/** Runs git in `dir`; an exit code of 127 (no git) is the caller's to read. */
const gitProbe = (io: CliIo, dir: string, args: string[]) =>
  io.probe.run("git", ["-C", dir, ...args]);

/** Runs git in `dir`, refusing when it is not installed. */
const git = async (io: CliIo, dir: string, args: string[]) => {
  const result = await gitProbe(io, dir, args);
  if (result.exitCode === 127) {
    throw new CliError("git-not-installed", "git is not installed", {
      fix: "install git",
    });
  }
  return result;
};

/** The files to copy from `dir`: its own ignore rules when it is a git checkout. */
async function sourceFiles(io: CliIo, dir: string): Promise<string[]> {
  // Without git installed a folder is just a folder, not a checkout.
  const top = await gitProbe(io, dir, ["rev-parse", "--show-toplevel"]);
  if (top.exitCode === 0) {
    const listed = await git(io, dir, [
      "ls-files",
      "-co",
      "--exclude-standard",
      "-z",
    ]);
    if (listed.exitCode !== 0) {
      throw new CliError(
        "vendor-fetch-failed",
        `git ls-files exited ${listed.exitCode} in ${dir}`,
        { exitCode: listed.exitCode },
      );
    }
    const files: string[] = [];
    for (const path of new Set(listed.stdout.split("\0"))) {
      if (path === "" || notTemplate(path)) continue;
      // Tracked but deleted, a submodule, or a linked folder: not a file to copy.
      const target = await stat(join(dir, path)).catch(() => undefined);
      if (target?.isFile()) files.push(path);
    }
    return files.sort();
  }
  return (await listFiles(dir, notTemplate)).filter((p) => !notTemplate(p));
}

/** The first line of git's stderr, with every URL's credentials removed. */
const firstLine = (stderr: string) =>
  (stderr.split("\n").find((l) => l.trim() !== "") ?? "no output")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s'"]*@/gi, "$1")
    .trim();

async function checkEve(dir: string, given: string): Promise<void> {
  const refuse = (why: string) =>
    new CliError(
      "vendor-not-eve-template",
      `${given} is not an eve template: ${why}`,
      {
        source: given,
        fix: "point at a folder with eve in package.json and an agent/ folder",
      },
    );
  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  } catch {
    throw refuse("no readable package.json");
  }
  const lists = (key: string) => {
    const section = pkg[key];
    return typeof section === "object" && section !== null && "eve" in section;
  };
  if (!lists("dependencies") && !lists("devDependencies"))
    throw refuse("package.json does not list eve");
  if (!(await stat(join(dir, "agent")).catch(() => undefined))?.isDirectory())
    throw refuse("no agent/ folder");
}

/**
 * Copies a template source into a new staging folder (under `stagingBase`, the system's
 * temporary folder by default), checks it is an eve template and digests it. The caller removes
 * `dir`; a failure removes it first.
 */
export async function stageVendor(
  io: CliIo,
  source: VendorSource,
  options: { name?: string; stagingBase?: string } = {},
): Promise<StagedVendor> {
  const name = options.name ?? defaultTemplateName(source);
  assertTemplateName(name);
  const given = redactUrl(source.given);
  const base = options.stagingBase ?? tmpdir();
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "donn-vendor-"));
  const fetched =
    source.kind === "git"
      ? await mkdtemp(join(base, "donn-fetch-"))
      : undefined;
  try {
    let from: string;
    let commit: string | undefined;
    let dirty: boolean | undefined;
    if (source.kind === "dir") {
      from = source.dir;
      const found = await stat(from).catch(() => undefined);
      if (!found?.isDirectory()) {
        throw new CliError(
          "vendor-source-not-found",
          `${source.given} is not a folder (looked for ${from})`,
          { source: source.given, path: from },
        );
      }
    } else {
      from = fetched!;
      const url = source.url;
      const step = async (args: string[]) => {
        const result = await git(io, from, args);
        if (result.exitCode !== 0) {
          const line = firstLine(result.stderr);
          throw new CliError(
            "vendor-fetch-failed",
            `git ${args[0]} exited ${result.exitCode} for ${redactUrl(url)}: ${line}`,
            {
              source: given,
              exitCode: result.exitCode,
              line,
              fix: "check the URL, the ref and your git credentials",
            },
          );
        }
        return result;
      };
      await step(["init", "--quiet"]);
      await step([
        "fetch",
        "--quiet",
        "--depth",
        "1",
        "--",
        url,
        ...(source.ref === undefined ? [] : [source.ref]),
      ]);
      await step([
        "-c",
        "advice.detachedHead=false",
        "checkout",
        "--quiet",
        "FETCH_HEAD",
      ]);
    }
    const files = await sourceFiles(io, from);
    for (const path of files) {
      const to = join(dir, path);
      await fsStep(to, async () => {
        await mkdir(dirname(to), { recursive: true });
        await cp(join(from, path), to, { verbatimSymlinks: true });
      });
    }
    const head = await gitProbe(io, from, ["rev-parse", "HEAD"]);
    if (head.exitCode === 0) commit = head.stdout.trim();
    if (source.kind === "dir" && commit !== undefined) {
      const status = await gitProbe(io, from, [
        "status",
        "--porcelain",
        "--",
        ".",
      ]);
      dirty = status.exitCode === 0 && status.stdout.trim() !== "";
    }
    await checkEve(dir, given);
    return {
      name,
      dir,
      source: given,
      ...(source.kind === "git" &&
        source.ref !== undefined && { ref: source.ref }),
      ...(commit !== undefined && { commit }),
      ...(dirty !== undefined && { dirty }),
      digest: await digestOf(dir, files),
      files,
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  } finally {
    if (fetched !== undefined)
      await rm(fetched, { recursive: true, force: true });
  }
}

export const VendorRecord = z.object({
  source: z.string(),
  ref: z.string().optional(),
  commit: z.string().optional(),
  dirty: z.boolean().optional(),
  digest: z.string(),
  vendoredAt: z.string(),
});
export type VendorRecord = z.infer<typeof VendorRecord>;

const SourcesFile = z.object({
  version: z.literal(1),
  templates: z.record(z.string(), VendorRecord),
});

const TEMPLATES = "templates";
const SOURCES = "sources.json";

/** The vendored templates' records; an absent file is no records. */
export async function readVendored(
  donnDir: string,
): Promise<Record<string, VendorRecord>> {
  const file = join(donnDir, TEMPLATES, SOURCES);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const invalid = (why: string) =>
    new CliError(
      "invalid-vendor-record",
      `${file} is not a vendor record file: ${why}`,
      {
        path: file,
        fix: "fix or delete the file; a template without a record is not refreshed",
      },
    );
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw invalid("it is not JSON");
  }
  const parsed = SourcesFile.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalid(
      `${issue?.path.join(".") || "the file"}: ${issue?.message ?? "invalid"}`,
    );
  }
  return parsed.data.templates;
}

/** `sha256:<hex>` by path, for the files a template keeps. */
async function hashesOf(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const files = (await listFiles(dir, notTemplate)).filter(
    (path) => !notTemplate(path),
  );
  for (const path of files)
    out.set(path, sha256(await readFile(join(dir, path))));
  return out;
}

const exists = async (path: string) =>
  (await stat(path).catch(() => undefined)) !== undefined;

const suffix = () => `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Moves the staged copy to `.donn/templates/<name>` (a recorded folder is replaced) and records
 * it. A folder without a record is never touched, and a recorded one that was edited by hand
 * only with `force`. The copy is made beside its destination first, so a failure leaves the old
 * folder in place.
 */
export async function commitVendor(
  donnDir: string,
  staged: StagedVendor,
  options: {
    force?: boolean;
    now: () => number;
    /** A test seam for the final move of the record into place. */
    rename?: typeof rename;
  },
): Promise<{ added: string[]; changed: string[]; removed: string[] }> {
  const templates = join(donnDir, TEMPLATES);
  const target = join(templates, staged.name);
  const shown = `.donn/${TEMPLATES}/${staged.name}`;
  const records = await readVendored(donnDir);
  const record = records[staged.name];
  const present = await exists(target);
  if (present && record === undefined) {
    throw new CliError(
      "vendor-name-taken",
      `${shown} exists and was not vendored by donn; vendor refreshes only its own copies`,
      {
        name: staged.name,
        path: target,
        fix: "--name <another-name>, or move the folder away",
      },
    );
  }
  if (
    present &&
    record !== undefined &&
    !options.force &&
    (await vendorDigest(target)) !== record.digest
  ) {
    throw new CliError(
      "vendor-local-edits",
      `${shown} was edited since it was vendored; refreshing it would lose the edits`,
      { name: staged.name, path: target, fix: "--force" },
    );
  }

  const before = present ? await hashesOf(target) : new Map<string, string>();
  const after = await hashesOf(staged.dir);
  const added = [...after.keys()].filter((p) => !before.has(p));
  const changed = [...after.keys()].filter(
    (p) => before.has(p) && before.get(p) !== after.get(p),
  );
  const removed = [...before.keys()].filter((p) => !after.has(p));

  const next: Record<string, VendorRecord> = {
    ...records,
    [staged.name]: {
      source: staged.source,
      ...(staged.ref !== undefined && { ref: staged.ref }),
      ...(staged.commit !== undefined && { commit: staged.commit }),
      ...(staged.dirty !== undefined && { dirty: staged.dirty }),
      digest: staged.digest,
      vendoredAt: new Date(options.now()).toISOString(),
    },
  };
  const sorted = Object.fromEntries(
    Object.entries(next).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const file = join(templates, SOURCES);
  const temp = `${file}.${suffix()}`;
  const move = options.rename ?? rename;

  // Everything is made ready first; the record is the last thing to change, and a failure
  // before it puts the old folder back.
  await mkdir(templates, { recursive: true });
  const incoming = join(templates, `.${staged.name}.new-${suffix()}`);
  const aside = join(templates, `.${staged.name}.old-${suffix()}`);
  let moved = false;
  try {
    await cp(staged.dir, incoming, { recursive: true, verbatimSymlinks: true });
    await writeFile(
      temp,
      `${JSON.stringify({ version: 1, templates: sorted }, null, 2)}\n`,
    );
    if (present) await rename(target, aside);
    try {
      await rename(incoming, target);
      moved = true;
      await move(temp, file);
    } catch (error) {
      if (moved) await rename(target, incoming);
      if (present) await rename(aside, target);
      throw error;
    }
  } finally {
    await rm(incoming, { recursive: true, force: true });
    await rm(temp, { force: true });
  }
  await rm(aside, { recursive: true, force: true });
  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
  };
}

/**
 * Takes a template `commitVendor` just added back out: its folder and its record (and the
 * record file and folder when nothing else is left). For undoing a create that failed after.
 */
export async function removeVendored(
  donnDir: string,
  name: string,
): Promise<void> {
  const templates = join(donnDir, TEMPLATES);
  await rm(join(templates, name), { recursive: true, force: true });
  const { [name]: _gone, ...rest } = await readVendored(donnDir);
  const file = join(templates, SOURCES);
  if (Object.keys(rest).length > 0) {
    await writeFile(
      file,
      `${JSON.stringify({ version: 1, templates: rest }, null, 2)}\n`,
    );
    return;
  }
  await rm(file, { force: true });
  await rmdir(templates).catch(() => undefined);
}

const realOrSelf = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const within = (inner: string, outer: string) => {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * A folder source under the project's `.donn/templates` or in an agent's folder would copy a
 * template into itself (or an agent's files into a template); a git source is never inside.
 */
export function assertNotInside(
  source: VendorSource,
  projectRoot: string,
  agentPaths: string[],
): void {
  if (source.kind !== "dir") return;
  const dir = realOrSelf(source.dir);
  const places = [
    {
      path: join(projectRoot, ".donn", TEMPLATES),
      what: "the project's templates",
    },
    ...agentPaths.map((path) => ({ path, what: "an agent's folder" })),
  ];
  for (const { path, what } of places) {
    if (within(dir, realOrSelf(path))) {
      throw new CliError(
        "vendor-source-inside",
        `${source.given} is inside ${what} (${path}); vendor a template from outside the project's own copies`,
        {
          source: source.given,
          path,
          fix: "vendor from the template's own folder or git URL",
        },
      );
    }
  }
}
