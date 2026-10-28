import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Id } from "@getdonn/spec";
import type { CliIo } from "../cli.js";
import { CliError } from "../errors.js";
import { fsStep } from "../fs.js";
import { templateDigest } from "./digest.js";
import { listFiles, notTemplate } from "./files.js";
import type { TarFile } from "./tar.js";

// `donn agent vendor`, first half: read a template source (a folder or a git URL), stage the
// copy in a temporary folder, check it is an eve template and digest it. Moving it into
// `.donn/templates/<name>` and the record come later. See docs/planning/25-agent-runner.md,
// "Amendment: vendoring a template".

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

const git = async (io: CliIo, dir: string, args: string[]) => {
  const result = await io.probe.run("git", ["-C", dir, ...args]);
  if (result.exitCode === 127) {
    throw new CliError("git-not-installed", "git is not installed", {
      fix: "install git",
    });
  }
  return result;
};

/** The files to copy from `dir`: its own ignore rules when it is a git checkout. */
async function sourceFiles(io: CliIo, dir: string): Promise<string[]> {
  const top = await git(io, dir, ["rev-parse", "--show-toplevel"]);
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
  if (!Id.safeParse(name).success) {
    throw new CliError(
      "invalid-template-name",
      `${JSON.stringify(name)} is not a template name: use lowercase letters, digits and single dashes`,
      { name, fix: "--name <lowercase-kebab-case>" },
    );
  }
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
    const head = await git(io, from, ["rev-parse", "HEAD"]);
    if (head.exitCode === 0) commit = head.stdout.trim();
    if (source.kind === "dir" && commit !== undefined) {
      const status = await git(io, from, ["status", "--porcelain", "--", "."]);
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
