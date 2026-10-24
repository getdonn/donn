import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { isAlive } from "@getdonn/executor";
import { API_VERSION } from "@getdonn/spec";
import { CliError } from "../errors.js";
import { writeFileAtomic } from "../fs.js";
import { isDaemonProcess } from "../daemon/process.js";
import { LEGACY } from "./legacy.js";

// The pieces `donn migrate` is made of. Each one can run again: it looks at what is on disk and
// does only what is left. See docs/planning/22-rename-donn.md §3.

/** The AGENTS.md block the agents-md adapter writes (`block: "donn"`). */
const BLOCK = "donn";

const errno = (error: unknown) => (error as NodeJS.ErrnoException).code;
const isMissing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes(errno(error) ?? "");

/** Whether anything is at `path`, a dangling symbolic link included. */
export async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** Something is at `path` other than an empty folder. */
export async function occupied(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return !info.isDirectory() || (await readdir(path)).length > 0;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** Remove `path` when it is an empty folder, so a rename can put a folder there. */
export async function clearEmpty(path: string): Promise<void> {
  if ((await present(path)) && !(await occupied(path))) await rmdir(path);
}

/** The refusal when a migration's target is in use (spec 22, Global Constraints). */
export function targetExists(target: string, hint = true): CliError {
  return new CliError(
    "migrate-target-exists",
    `${target} already exists and is not empty; move it aside${hint ? " or set DONN_HOME" : ""}`,
    { target },
  );
}

// Moving the home

/** Where a copy is made before it goes into place: next to the target, on its filesystem. */
export const stagingOf = (target: string) => `${target}.migrating`;
/** Where the source waits, once its copy is verified, until the copy is in place. */
export const setAsideOf = (src: string) => `${src}.migrated`;

export interface MoveOptions {
  /** Test seam: fs.rename. */
  rename?: (from: string, to: string) => Promise<void>;
  /** Test seam: the copy made when a rename cannot cross filesystems. */
  copy?: (from: string, to: string) => Promise<void>;
}

/** Copy a tree as it is: symbolic links as links; sockets and pipes (a daemon's) left out. */
async function copyTree(from: string, to: string): Promise<void> {
  await cp(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
    filter: async (source) => kindOf(await lstat(source)) !== undefined,
  });
}

function kindOf(info: Awaited<ReturnType<typeof lstat>>) {
  if (info.isSymbolicLink()) return "link";
  if (info.isDirectory()) return "dir";
  if (info.isFile()) return "file";
  return undefined;
}

/** One digest for a tree: every entry's path, kind and mode, a file's bytes, a link's target. */
async function digestTree(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (at: string): Promise<void> => {
    for (const name of (await readdir(at)).sort()) {
      const path = join(at, name);
      const info = await lstat(path);
      const kind = kindOf(info);
      if (kind === undefined) continue;
      hash.update(`${relative(dir, path)}\0${kind}\0`);
      if (kind === "link") hash.update(await readlink(path));
      else hash.update((Number(info.mode) & 0o777).toString(8));
      if (kind === "file") hash.update(await readFile(path));
      hash.update("\0");
      if (kind === "dir") await walk(path);
    }
  };
  await walk(dir);
  return hash.digest("hex");
}

/**
 * Move the home `src` to `target`: one rename on one filesystem. Across filesystems, a copy next
 * to the target, verified against the source; then the source is set aside, the copy put in
 * place and the source deleted. Run again after an interruption at any point, it finishes.
 */
export async function moveHome(
  src: string,
  target: string,
  options: MoveOptions = {},
): Promise<void> {
  const move = options.rename ?? rename;
  const copy = options.copy ?? copyTree;
  const aside = setAsideOf(src);
  const staging = stagingOf(target);
  if (await present(aside)) {
    // The copy was verified and the source set aside: put the copy in place, then delete.
    if (await present(staging)) {
      await clearEmpty(target);
      await move(staging, target);
    }
    // The old home goes only once its copy is in place.
    if (!(await occupied(target))) {
      throw new CliError(
        "migrate-copy",
        `${target} is missing but the old home waits in ${aside}; move it back to ${src} and run donn migrate again`,
        { src, target },
      );
    }
    await rm(aside, { recursive: true, force: true });
    return;
  }
  if (!(await present(src))) return;
  if (await occupied(target)) throw targetExists(target);
  // A copy that was interrupted is started again.
  await rm(staging, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await clearEmpty(target);
  try {
    await move(src, target);
    return;
  } catch (error) {
    if (errno(error) !== "EXDEV") throw error;
  }
  await copy(src, staging);
  const [want, got] = await Promise.all([digestTree(src), digestTree(staging)]);
  if (want !== got) {
    await rm(staging, { recursive: true, force: true });
    throw new CliError(
      "migrate-copy",
      `the copy of ${src} did not match it; nothing was moved, run donn migrate again`,
      { src, target },
    );
  }
  await move(src, aside);
  await move(staging, target);
  await rm(aside, { recursive: true, force: true });
}

// Regenerable state

/** What a daemon removes when it stops: its socket and its bookkeeping. The log stays. */
const DAEMON_FILES = ["sock", "where", "pid", "token", "daemon.lock"];

/** The regenerable paths in `home` that are still there. */
export async function regenerable(home: string): Promise<string[]> {
  const paths = [
    join(home, "build"),
    join(home, "sessions"),
    ...DAEMON_FILES.map((name) => join(home, "daemon", name)),
  ];
  const found: string[] = [];
  for (const path of paths) if (await present(path)) found.push(path);
  return found;
}

export async function dropState(home: string): Promise<void> {
  for (const path of await regenerable(home))
    await rm(path, { recursive: true, force: true });
}

// apiVersion

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A top-level `apiVersion:` line whose whole value is the old version, plain or quoted, with an
 * optional comment after it: only the value is replaced.
 */
const API_LINE = new RegExp(
  `^(apiVersion[ \\t]*:[ \\t]*)(["']?)${escapeRegExp(LEGACY.apiVersion)}\\2(?=(?:[ \\t]+#[^\\r\\n]*)?[ \\t]*\\r?$)`,
  "gm",
);

/** The text with the old apiVersion value replaced; every other byte as it was. */
export function rewriteApiVersion(text: string): string {
  return text.replace(API_LINE, `$1$2${API_VERSION}$2`);
}

/** Folders a persona walk never enters. */
const SKIP = new Set([".git", "node_modules"]);

/** Every .yaml and .yml file under `dir` (links not followed) whose apiVersion is the old one. */
export async function staleFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (at: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(at);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const name of names.sort()) {
      const path = join(at, name);
      const info = await lstat(path);
      if (info.isDirectory() && !SKIP.has(name)) await walk(path);
      else if (info.isFile() && /\.ya?ml$/.test(name)) {
        const text = await readFile(path, "utf8");
        if (rewriteApiVersion(text) !== text) found.push(path);
      }
    }
  };
  // The folder itself may be a link (a personas folder elsewhere); what is inside is not followed.
  const info = await stat(dir).catch(() => undefined);
  if (info?.isDirectory()) await walk(dir);
  return found;
}

/** Rewrite one file's apiVersion in place (through a link to its target). */
export async function rewriteFile(path: string): Promise<void> {
  const text = await readFile(path, "utf8");
  const next = rewriteApiVersion(text);
  if (next !== text) await writeThrough(path, next);
}

/** Write a file atomically at its real path (a linked file stays linked), keeping its mode. */
export async function writeThrough(
  path: string,
  content: string,
): Promise<void> {
  const target = await realpath(path);
  const mode = (await stat(target)).mode & 0o777;
  await writeFileAtomic(target, content, mode);
}

// config.yaml paths

/**
 * config.yaml with paths into the old home pointing into the new one: `~/<old home>…` and the
 * old home's absolute path, as a whole path or its start. `~` stays `~` when the new home is the
 * default; otherwise the new home's absolute path takes its place.
 */
export function rewriteConfigPaths(
  text: string,
  paths: { user: string; src: string; target: string },
): string {
  const tilde = `~/${LEGACY.home}`;
  const tildeTarget =
    paths.target === join(paths.user, ".donn") ? "~/.donn" : paths.target;
  const boundary = (from: string) =>
    new RegExp(
      `(?<=^|[\\s"'\\[,{])${escapeRegExp(from)}(?=$|[/\\s"',\\]}#])`,
      "gm",
    );
  return text
    .replace(boundary(paths.src), () => paths.target)
    .replace(boundary(tilde), () => tildeTarget);
}

// AGENTS.md markers

/** The text with the old block's two marker lines renamed; the block's body and the rest kept. */
export function rewriteMarkers(text: string): string {
  const begin = `<!-- ${LEGACY.marker}:begin`;
  const end = `<!-- ${LEGACY.marker}:end -->`;
  return (text.match(/[^\n]*\n|[^\n]+$/g) ?? [])
    .map((raw) => {
      const line = raw.replace(/\r?\n$/, "").trim();
      if (line.startsWith(begin) && line.endsWith("-->"))
        return raw.replace(begin, `<!-- ${BLOCK}:begin`);
      if (line === end) return raw.replace(end, `<!-- ${BLOCK}:end -->`);
      return raw;
    })
    .join("");
}

/** Rewrite a project's AGENTS.md markers in place; a link must stay inside the project. */
export async function rewriteMarkersIn(
  path: string,
  root: string,
): Promise<void> {
  const text = await readFile(path, "utf8");
  const next = rewriteMarkers(text);
  if (next === text) return;
  const target = await realpath(path);
  const realRoot = await realpath(root);
  if (!target.startsWith(realRoot + sep)) {
    throw new CliError(
      "migrate-outside",
      `${path} links to ${target}, outside the project; change its markers by hand`,
      { path, target },
    );
  }
  await writeThrough(path, next);
}

// Progress kept across runs

/** What a run has started and not finished, for steps whose effect alone cannot tell. */
export interface Progress {
  /** The old home's build/, sessions/ and daemon files are still to go (step 3). */
  state?: boolean;
  /** The old service was installed: the new one is to be installed (step 7). */
  service?: boolean;
  /** The old mod is being replaced (step 6). */
  mod?: boolean;
}

const PROGRESS = "migrating.json";

export async function readProgress(home: string): Promise<Progress> {
  try {
    return JSON.parse(await readFile(join(home, PROGRESS), "utf8")) as Progress;
  } catch {
    return {};
  }
}

/** Merge `patch`; the file goes once nothing is left in it. */
export async function updateProgress(
  home: string,
  patch: Progress,
): Promise<void> {
  const next = { ...(await readProgress(home)), ...patch };
  const left = Object.fromEntries(
    Object.entries(next).filter(([, value]) => value === true),
  );
  const file = join(home, PROGRESS);
  if (Object.keys(left).length === 0) await rm(file, { force: true });
  else await writeFileAtomic(file, `${JSON.stringify(left, null, 2)}\n`, 0o600);
}

// The old daemon

/** The pid of a daemon still running for the old home, if one is. */
export async function legacyDaemonPid(
  home: string,
): Promise<number | undefined> {
  const pid = Number.parseInt(
    await readFile(join(home, "daemon", "pid"), "utf8").catch(() => ""),
    10,
  );
  return pid > 0 && pid !== process.pid && isDaemonProcess(pid)
    ? pid
    : undefined;
}

const STOP_WAIT_MS = 5_000;

/** Stop the old home's daemon, if one runs (started outside the service, or still stopping). */
export async function stopLegacyDaemon(home: string): Promise<void> {
  const pid = await legacyDaemonPid(home);
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already gone
  }
  const deadline = Date.now() + STOP_WAIT_MS;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new CliError(
        "daemon-stop",
        `the old daemon (pid ${pid}) did not stop; kill ${pid}, then run donn migrate again`,
        { pid },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// The old mod

/** Whether `<home>/mod` is the old name's mod (its marketplace has the old name). */
export async function legacyMod(home: string): Promise<boolean> {
  try {
    const marketplace = JSON.parse(
      await readFile(join(home, "mod/.claude-plugin/marketplace.json"), "utf8"),
    ) as { name?: unknown };
    return marketplace.name === LEGACY.marketplace;
  } catch {
    return false;
  }
}

// A project

/**
 * The project root at or above `start` that has a `persona.yaml` in the old project folder, or
 * a `.donn/persona.yaml` (a project migrated already, or partly). The user's home is never one:
 * its old folder is the old home, not a project.
 */
export async function findProjectRoot(
  start: string,
  userHome: string,
): Promise<string | undefined> {
  for (let dir = start; ; dir = dirname(dir)) {
    if (
      dir !== userHome &&
      ((await present(join(dir, LEGACY.home, "persona.yaml"))) ||
        (await present(join(dir, ".donn", "persona.yaml"))))
    )
      return dir;
    if (dirname(dir) === dir) return undefined;
  }
}
