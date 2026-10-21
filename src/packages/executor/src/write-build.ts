import { randomBytes } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import type { CompileOutput } from "@zzpersona/adapter-sdk";
import type { LocalStore } from "@zzpersona/store-local";
import { ExecutorError } from "./errors.js";
import { isAlive } from "./process.js";

// Writes a compile output as a new version directory, then atomically repoints the build
// directory (a symlink) at it, so the build directory is never missing or half-written, even
// with several builds of the same persona at once. A lock serializes the swap across
// processes. copyFrom sources, and everything inside a copied directory, must resolve (symlinks
// followed) inside their mount. See docs/planning/06-cli-core-loop.md, section 3.

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 20;

const errnoOf = (error: unknown) => (error as NodeJS.ErrnoException).code;
const suffix = () => randomBytes(4).toString("hex");

/** An ExecutorError as is; any other filesystem error as an ExecutorError naming `what`. */
function wrap(error: unknown, what: string): unknown {
  if (error instanceof ExecutorError) return error;
  const code = errnoOf(error);
  if (code === undefined) return error;
  const path = (error as NodeJS.ErrnoException).path;
  return new ExecutorError(`${what}: ${code}${path ? ` (${path})` : ""}`);
}

async function assertContained(
  path: string,
  root: string,
  source: string,
): Promise<void> {
  const realRoot = await realpath(root);
  const check = async (entry: string) => {
    const real = await realpath(entry);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new ExecutorError(
        `${source} resolves outside its location (${real} is outside ${realRoot})`,
      );
    }
  };
  await check(path);
  if (!(await lstat(path)).isDirectory()) return;
  for (const entry of await readdir(path, { recursive: true }))
    await check(join(path, entry));
}

async function writeFiles(
  output: CompileOutput,
  dir: string,
  store: LocalStore,
) {
  for (const [path, file] of Object.entries(output.files)) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    if ("content" in file) {
      await writeFile(target, file.content, { mode: file.mode ?? 0o644 });
      await chmod(target, file.mode ?? 0o644);
      continue;
    }
    const location = store.locate(file.copyFrom);
    if (!location) {
      throw new ExecutorError(
        `${file.copyFrom} is not inside any configured location`,
      );
    }
    try {
      await assertContained(location.path, location.root, file.copyFrom);
      await cp(location.path, target, { recursive: true, dereference: true });
      if (file.mode !== undefined) await chmod(target, file.mode);
    } catch (error) {
      if (errnoOf(error) === "ENOENT" && !(error instanceof ExecutorError)) {
        throw new ExecutorError(
          `${file.copyFrom} not found at ${location.path}`,
        );
      }
      throw wrap(error, `could not copy ${file.copyFrom}`);
    }
  }
}

/** A directory lock: mkdir is atomic. A lock whose owner process is gone is taken over. */
async function withLock<T>(lock: string, body: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, "pid"), String(process.pid));
      break;
    } catch (error) {
      if (errnoOf(error) !== "EEXIST") throw error;
      const owner = Number(
        await readFile(join(lock, "pid"), "utf8").catch(() => ""),
      );
      if (owner > 0 && !isAlive(owner)) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new ExecutorError(
          `another build of this persona is still running (lock ${lock}); retry, or remove the lock if it is stale`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
  try {
    return await body();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** Point `buildDir` at `version` atomically and remove the version it pointed at before. */
async function swap(buildDir: string, version: string): Promise<void> {
  const parent = dirname(buildDir);
  const stat = await lstat(buildDir).catch(() => undefined);
  const previous = stat?.isSymbolicLink()
    ? await readlink(buildDir)
    : undefined;
  if (stat?.isDirectory()) await rm(buildDir, { recursive: true, force: true }); // pre-symlink layout
  const link = join(parent, `${basename(buildDir)}.link-${suffix()}`);
  await symlink(basename(version), link);
  await rename(link, buildDir);
  if (previous !== undefined && previous !== basename(version)) {
    await rm(join(parent, previous), { recursive: true, force: true });
  }
}

export async function writeBuild(
  output: CompileOutput,
  options: { buildDir: string; store: LocalStore },
): Promise<void> {
  const { buildDir, store } = options;
  const buildRoot = dirname(dirname(buildDir));
  try {
    await mkdir(buildRoot, { recursive: true, mode: 0o700 });
    await chmod(buildRoot, 0o700);
    await mkdir(dirname(buildDir), { recursive: true });
  } catch (error) {
    throw wrap(error, `could not create ${buildRoot}`);
  }

  const version = `${buildDir}.v-${suffix()}`;
  try {
    await writeFiles(output, version, store);
    await withLock(`${buildDir}.lock`, () => swap(buildDir, version));
  } catch (error) {
    await rm(version, { recursive: true, force: true });
    throw wrap(error, `could not write the build at ${buildDir}`);
  }
}
