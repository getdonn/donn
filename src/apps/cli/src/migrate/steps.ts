import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
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
  symlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { isAlive } from "@getdonn/executor";
import { API_VERSION } from "@getdonn/spec";
import { parse as parseYaml } from "yaml";
import type { CliIo } from "../cli.js";
import { MARKETPLACE } from "../commands/mod.js";
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

/** The user's home folder as the environment gives it, else the system's (an empty HOME is unset). */
export const userHome = (io: Pick<CliIo, "env">) => io.env.HOME || homedir();

/** The old home (`~/.zzpersona`): where doctor and migrate both look for one. */
export const legacyHome = (io: Pick<CliIo, "env">) =>
  join(userHome(io), LEGACY.home);

/**
 * A POSIX-shell word: as is when plainly safe (a leading `~/` stays, so the shell expands it),
 * otherwise single-quoted with embedded quotes written as '\''.
 */
export const shellWord = (value: string) =>
  /^(?:~\/)?[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The repo a state.json key (a project's `.donn` folder, or its old name) belongs to, when that
 * repo still has the old project folder: a project not migrated yet.
 */
export async function unmigratedRepo(key: string): Promise<string | undefined> {
  if (![LEGACY.home, ".donn"].includes(basename(key))) return undefined;
  const repo = dirname(key);
  // `migrate --project` needs the old folder's persona.yaml, and refuses when .donn/ holds
  // anything (a switch keyed by that folder is not waiting), whichever name the key has.
  if (!existsSync(join(repo, LEGACY.home, "persona.yaml"))) return undefined;
  if (await occupied(join(repo, ".donn"))) return undefined;
  return repo;
}

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

/**
 * What to do about a new home that donn made itself before the migration. Never done for the
 * user: the home could be in use (its daemon, a session).
 */
export async function madeByDonnAdvice(target: string): Promise<string> {
  const daemon =
    (await legacyDaemonPid(target)) === undefined
      ? ""
      : "stop its daemon (`donn daemon stop`), ";
  return `${daemon}run \`donn mod uninstall\` if the donn mod is installed, then remove ${shellWord(target)} and run \`donn migrate\` again`;
}

/** The refusal when the target holds only what donn made itself (see madeByDonn). */
export async function targetMadeByDonn(target: string): Promise<CliError> {
  return new CliError(
    "migrate-target-exists",
    `${target} was made by running donn before migrating; ${await madeByDonnAdvice(target)}`,
    { target, madeByDonn: true },
  );
}

/** What a target holding only what `donn init` and `donn login` wrote is (see madeByInitOrLogin). */
export const initOrLoginWhat = (target: string, files: string[]) =>
  `${target} holds only what donn init or donn login wrote (${files.join(", ")}); donn migrate moves the old home's settings`;

/**
 * What to do about it: remove the home, with the values that go with it (the personas folder,
 * the registry url) so they can be set again. Never done for the user: the home could be in use.
 */
export async function initOrLoginAdvice(
  target: string,
  files: string[],
): Promise<string> {
  const daemon =
    (await legacyDaemonPid(target)) === undefined
      ? ""
      : "stop its daemon (`donn daemon stop`), ";
  const mod = (await present(join(target, "mod")))
    ? "run `donn mod uninstall` if the donn mod is installed, "
    : "";
  const config = parsed(
    await readFile(join(target, "config.yaml"), "utf8").catch(() => ""),
    parseYaml,
  )?.value as
    { personas?: string; registry?: { url?: string } } | null | undefined;
  const sets = [
    ...(config?.personas === undefined
      ? []
      : [`personas: ${shellWord(config.personas)}`]),
    ...(config?.registry?.url === undefined
      ? []
      : [`registry: ${config.registry.url}`]),
  ];
  const login = files.some((file) => file.includes("registry"))
    ? `, then run \`donn login${config?.registry?.url === undefined ? "" : ` ${shellWord(config.registry.url)}`}\` again`
    : "";
  return `${daemon}${mod}remove ${shellWord(target)}${sets.length > 0 ? ` (it sets ${sets.join(", ")})` : ""}, run \`donn migrate\`${login}`;
}

/** The refusal when the target holds only what `donn init` and `donn login` wrote. */
export async function targetMadeByInitOrLogin(
  target: string,
  files: string[],
): Promise<CliError> {
  return new CliError(
    "migrate-target-exists",
    `${initOrLoginWhat(target, files)}; ${await initOrLoginAdvice(target, files)}`,
    { target, files },
  );
}

const isDir = async (path: string) => (await lstat(path)).isDirectory();
const isFile = async (path: string) => (await lstat(path)).isFile();

/** Parsed JSON or YAML text, or undefined when it does not parse. */
const parsed = (text: string, parse: (text: string) => unknown) => {
  try {
    return { value: parse(text) };
  } catch {
    return undefined;
  }
};

/**
 * Whether the home `dir` holds only what donn makes on its own, nothing the user wrote or chose:
 * the daemon's folder, sessions/, build/, an empty personas/, a mod/ whose marketplace is donn's,
 * a state.json with no default and no project switch, an empty config.yaml, state.lock and
 * Finder's .DS_Store. Anything else (a link among them, a registry token or cache, overrides,
 * a persona, a switch, a config value) is the user's, and so is anything this cannot read.
 */
export async function madeByDonn(dir: string): Promise<boolean> {
  try {
    if (!(await isDir(dir))) return false;
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      if (!(await madeEntry(name, path))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * What `donn init --personas` and `donn login` write into a home: config.yaml with a `personas`
 * folder and/or a `registry` url, and the `registry-token` file (a login without a keychain).
 * Returns those files, described, when the home holds nothing else but what donn makes on its
 * own (see madeByDonn); undefined when it holds anything else, or none of them.
 */
export async function madeByInitOrLogin(
  dir: string,
): Promise<string[] | undefined> {
  try {
    if (!(await isDir(dir))) return undefined;
    const files: string[] = [];
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const written = await writtenEntry(name, path);
      if (written !== undefined) files.push(written);
      else if (!(await madeEntry(name, path))) return undefined;
    }
    return files.length > 0 ? files : undefined;
  } catch {
    return undefined;
  }
}

async function writtenEntry(
  name: string,
  path: string,
): Promise<string | undefined> {
  if (name === "registry-token") return (await isFile(path)) ? name : undefined;
  if (name !== "config.yaml" || !(await isFile(path))) return undefined;
  const config = parsed(await readFile(path, "utf8"), parseYaml)?.value as
    Record<string, unknown> | null | undefined;
  if (config === null || typeof config !== "object" || Array.isArray(config))
    return undefined;
  const keys = Object.keys(config);
  if (
    keys.length === 0 ||
    !keys.every((k) => ["personas", "registry"].includes(k))
  )
    return undefined;
  const registry = config.registry as Record<string, unknown> | undefined;
  if (
    ("personas" in config && typeof config.personas !== "string") ||
    ("registry" in config &&
      (registry === null ||
        typeof registry !== "object" ||
        Object.keys(registry).join() !== "url" ||
        typeof registry.url !== "string"))
  )
    return undefined;
  return `${name} (${keys.sort().join(", ")})`;
}

async function madeEntry(name: string, path: string): Promise<boolean> {
  switch (name) {
    case "daemon":
    case "sessions":
    case "build":
      return isDir(path);
    case "personas":
      return (await isDir(path)) && (await readdir(path)).length === 0;
    case "mod":
      return (await isDir(path)) && (await modName(path)) === MARKETPLACE;
    case "state.json": {
      if (!(await isFile(path))) return false;
      const state = parsed(await readFile(path, "utf8"), JSON.parse)?.value as
        Record<string, unknown> | undefined;
      return (
        state !== undefined &&
        state !== null &&
        typeof state === "object" &&
        Object.keys(state).every((key) =>
          ["version", "projects"].includes(key),
        ) &&
        state.version === 1 &&
        typeof state.projects === "object" &&
        state.projects !== null &&
        Object.keys(state.projects).length === 0
      );
    }
    case "config.yaml": {
      if (!(await isFile(path))) return false;
      const config = parsed(await readFile(path, "utf8"), parseYaml);
      return config !== undefined && config.value == null;
    }
    case "state.lock":
    case ".DS_Store":
      return isFile(path);
    default:
      return false;
  }
}

/** The name in `<mod>/.claude-plugin/marketplace.json`, if it has one. */
async function modName(mod: string): Promise<unknown> {
  const text = await readFile(
    join(mod, ".claude-plugin/marketplace.json"),
    "utf8",
  ).catch(() => "");
  const marketplace = parsed(text, JSON.parse)?.value as
    { name?: unknown } | null | undefined;
  return marketplace?.name;
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

/** `realpath`, for a path that may not exist yet: its nearest existing folder, resolved. */
async function realpathLoose(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const parent = dirname(path);
    if (!isMissing(error) || parent === path) throw error;
    return join(await realpathLoose(parent), basename(path));
  }
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
  // A link with a relative target points somewhere else from another folder. In the same folder
  // the plain rename is right; otherwise the new link is absolute, built from where the old
  // one physically lives (the kernel reads a relative link from there, not from the path it was
  // reached by), made next to the target and put in place the way a copy is. Whether that can
  // be done is settled before anything is changed: no new folder, no folder cleared.
  const relink =
    (await lstat(src)).isSymbolicLink() &&
    !isAbsolute(await readlink(src)) &&
    (await realpath(dirname(src)).catch(() => dirname(src))) !==
      (await realpathLoose(dirname(target)));
  const reach = relink ? await realpath(src).catch(() => undefined) : undefined;
  const notReproduced = () =>
    new CliError(
      "migrate-copy",
      `${src} is a link that could not be reproduced at ${target}; nothing was moved: point ${src} at its folder by an absolute path, then run donn migrate again`,
      { src, target },
    );
  if (relink && reach === undefined) throw notReproduced();
  // A copy that was interrupted is started again.
  await rm(staging, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await clearEmpty(target);
  if (relink && reach !== undefined) {
    await symlink(reach, staging);
    if ((await realpath(staging).catch(() => "")) !== reach) {
      await rm(staging, { recursive: true, force: true });
      throw notReproduced();
    }
    await move(src, aside);
    await move(staging, target);
    await rm(aside, { recursive: true, force: true });
    return;
  }
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

/**
 * Every .yaml and .yml file under `dir`, links not followed, leaving out the folders named in
 * `skipTop` directly under `dir`.
 */
export async function yamlFiles(
  dir: string,
  skipTop: readonly string[] = [],
): Promise<string[]> {
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
      if (info.isDirectory()) {
        if (!SKIP.has(name) && !(at === dir && skipTop.includes(name)))
          await walk(path);
      } else if (info.isFile() && /\.ya?ml$/.test(name)) found.push(path);
    }
  };
  // The folder itself may be a link (a personas folder elsewhere); what is inside is not followed.
  const info = await stat(dir).catch(() => undefined);
  if (info?.isDirectory()) await walk(dir);
  return found;
}

/** Every .yaml and .yml file under `dir` (links not followed) whose apiVersion is the old one. */
export async function staleFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const path of await yamlFiles(dir)) {
    const text = await readFile(path, "utf8");
    if (rewriteApiVersion(text) !== text) found.push(path);
  }
  return found;
}

/** A YAML file's string values that name the old home, each with its field (`a.b[0].c`). */
export function oldHomeValues(
  text: string,
  src: string,
): { field: string; value: string }[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return []; // not readable YAML: nothing to point at
  }
  const names = [
    `~/${LEGACY.home}`,
    `$HOME/${LEGACY.home}`,
    `\${HOME}/${LEGACY.home}`,
    src,
  ];
  const named = new RegExp(
    `(?<=^|[\\s"'=:(,;])(?:${names.map(escapeRegExp).join("|")})(?=$|[/\\s"'),;:])`,
  );
  const hits: { field: string; value: string }[] = [];
  const walk = (value: unknown, field: string): void => {
    if (typeof value === "string") {
      if (named.test(value)) hits.push({ field, value });
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${field}[${i}]`));
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value))
        walk(item, field === "" ? key : `${field}.${key}`);
    }
  };
  walk(doc, "");
  return hits;
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

export const PROGRESS = "migrating.json";

/** A folder holding nothing but a migration's progress note: a migration under way, not a home. */
export async function onlyProgress(dir: string): Promise<boolean> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.length === 1 && names[0] === PROGRESS;
}

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
  return (await modName(join(home, "mod"))) === LEGACY.marketplace;
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
