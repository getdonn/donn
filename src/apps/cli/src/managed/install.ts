import { randomBytes } from "node:crypto";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ManagedManifest } from "@zzpersona/adapter-sdk";
import { CliError } from "../errors.js";
import { fsStep } from "../fs.js";
import { checkedPath, MANIFEST_PATH, readBundle } from "./bundle-io.js";
import type { ManagedEnv } from "./env.js";

// Put a bundle into the policy folder, or take it out again. Only files zzpersona owns (listed
// in the installed manifest) are ever replaced or removed; anything else that is in the way is
// refused, by name, before the first write. See docs/planning/21-managed-settings.md, section 3.

export const SETTINGS_PATH = "managed-settings.d/50-zzpersona.json";
const HOOKS_DIR = "zzpersona/hooks";

/** The only paths zzpersona ever writes or removes under the root. */
const OWN_PATH =
  /^(?:managed-settings\.d\/50-zzpersona\.json|managed-mcp\.json|zzpersona\/manifest\.json|zzpersona\/hooks\/[^/]+)$/;

const isMissing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/** A root-relative path, `/`-separated, as an absolute path under `root`. */
export const under = (root: string, path: string) =>
  join(root, ...path.split("/"));

function ownPath(path: string, listedIn: string): string {
  checkedPath(path);
  if (!OWN_PATH.test(path)) {
    throw new CliError(
      "managed-foreign-path",
      `${listedIn} lists ${path}, which is not a file zzpersona installs`,
      { path },
    );
  }
  return path;
}

/** Thrown when an installed manifest comes from a newer zzpersona: touch nothing. */
function newerFormat(manifest: Record<string, unknown>, path: string) {
  const version =
    typeof manifest.zzpersona === "string"
      ? manifest.zzpersona
      : "an unknown version";
  return new CliError(
    "managed-newer-format",
    `installed by a newer zzpersona (${version}); upgrade zzpersona`,
    { path, format: manifest.format },
  );
}

/**
 * The manifest a previous install left in `root`, or undefined when there is none. Throws
 * `managed-newer-format` for a newer format and `managed-bad-installed` when it cannot be read,
 * since then nobody can tell which files zzpersona owns.
 */
export async function readInstalled(
  root: string,
): Promise<ManagedManifest | undefined> {
  const path = under(root, MANIFEST_PATH);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const bad = (why: string) =>
    new CliError(
      "managed-bad-installed",
      `${path} ${why}; zzpersona cannot tell which files it installed`,
      { path },
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw bad("is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw bad("is not a manifest");
  }
  const manifest = parsed as Record<string, unknown>;
  if (typeof manifest.format === "number" && manifest.format > 1) {
    throw newerFormat(manifest, path);
  }
  const files = manifest.files;
  if (
    manifest.format !== 1 ||
    files === null ||
    typeof files !== "object" ||
    Array.isArray(files) ||
    Object.values(files).some((v) => typeof v !== "string")
  ) {
    throw bad("is not a format 1 manifest");
  }
  for (const key of Object.keys(files)) ownPath(key, path);
  return manifest as unknown as ManagedManifest;
}

type OnDisk =
  { kind: "missing" } | { kind: "file"; bytes: Buffer } | { kind: "other" };

async function onDisk(path: string): Promise<OnDisk> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return { kind: "other" };
    return { kind: "file", bytes: await readFile(path) };
  } catch (error) {
    if (isMissing(error)) return { kind: "missing" };
    throw error;
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && Buffer.compare(a, b) === 0;

export interface InstallPlan {
  root: string;
  /** Paths in write order; the manifest, when it changes, is last. */
  written: string[];
  replaced: string[];
  removed: string[];
  unchanged: string[];
}

export interface PlannedInstall {
  plan: InstallPlan;
  files: Record<string, Uint8Array>;
}

/** Read and verify the bundle, compare it with the root and refuse what is in the way. Writes nothing. */
export async function planInstall(
  env: ManagedEnv,
  dir: string,
): Promise<PlannedInstall> {
  const { files, manifest } = await readBundle(dir);
  const listedIn = join(dir, ...MANIFEST_PATH.split("/"));
  for (const path of Object.keys(files)) ownPath(path, listedIn);
  if (manifest.os !== env.os) {
    throw new CliError(
      "managed-wrong-os",
      `${dir} is a bundle for ${manifest.os}; this machine runs ${env.os}`,
      { bundle: manifest.os, machine: env.os },
    );
  }
  const installed = await readInstalled(env.root);
  const owned = new Set(
    installed ? [...Object.keys(installed.files), MANIFEST_PATH] : [],
  );
  const plan: InstallPlan = {
    root: env.root,
    written: [],
    replaced: [],
    removed: [],
    unchanged: [],
  };
  const refused: string[] = [];
  const order = [
    ...Object.keys(files).filter((p) => p !== MANIFEST_PATH),
    MANIFEST_PATH,
  ];
  for (const path of order) {
    const current = await onDisk(under(env.root, path));
    if (current.kind === "missing") plan.written.push(path);
    else if (!owned.has(path)) refused.push(under(env.root, path));
    else if (current.kind === "file" && sameBytes(current.bytes, files[path]!))
      plan.unchanged.push(path);
    else plan.replaced.push(path);
  }
  if (refused.length > 0) {
    throw new CliError(
      "managed-not-owned",
      refused.length === 1
        ? `${refused[0]} exists and zzpersona did not install it; refusing to replace it (nothing was written)`
        : `${refused.join(", ")} exist and zzpersona did not install them; refusing to replace them (nothing was written)`,
      { paths: refused },
    );
  }
  for (const path of Object.keys(installed?.files ?? {}).sort()) {
    if (path in files) continue;
    if ((await onDisk(under(env.root, path))).kind !== "missing")
      plan.removed.push(path);
  }
  return { plan, files };
}

export const planIsEmpty = (plan: InstallPlan) =>
  plan.written.length + plan.replaced.length + plan.removed.length === 0;

/** Chown to root only when running as root on POSIX; elsewhere the folder's defaults apply. */
const asRoot = () => process.platform !== "win32" && process.getuid?.() === 0;

/** Create `dir` and any missing parents, each 0755 (and root's when running as root). */
async function ensureDir(dir: string): Promise<void> {
  const missing: string[] = [];
  for (let at = dir; ; at = dirname(at)) {
    try {
      const info = await stat(at);
      if (!info.isDirectory()) {
        throw new CliError("managed-not-a-folder", `${at} is not a folder`, {
          path: at,
        });
      }
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      missing.unshift(at);
      if (dirname(at) === at) break;
    }
  }
  for (const at of missing) {
    await fsStep(at, async () => {
      await mkdir(at, { mode: 0o755 });
      await chmod(at, 0o755);
      if (asRoot()) await chown(at, 0, 0);
    });
  }
}

/** Temp file in the same folder, mode and owner set, then renamed over the target. */
async function writeAtomic(
  root: string,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const file = under(root, path);
  await ensureDir(dirname(file));
  const mode = path.startsWith(`${HOOKS_DIR}/`) ? 0o755 : 0o644;
  // Hidden and not ending in .json: Claude Code never reads it as a drop-in.
  const tmp = join(
    dirname(file),
    `.${basename(file)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  await fsStep(file, async () => {
    try {
      await writeFile(tmp, bytes, { mode, flag: "wx" });
      await chmod(tmp, mode);
      if (asRoot()) await chown(tmp, 0, 0);
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  });
}

async function remove(root: string, path: string): Promise<void> {
  const file = under(root, path);
  await fsStep(file, () => rm(file, { force: true }));
}

/** Remove our own folders once they are empty; anyone else's file keeps them. */
async function prune(root: string, dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    await rmdir(under(root, dir)).catch(() => undefined);
  }
}

/** Write the planned files, remove the old ones, and write the manifest last. */
export async function applyInstall({
  plan,
  files,
}: PlannedInstall): Promise<void> {
  const changed = new Set([...plan.written, ...plan.replaced]);
  for (const path of [...plan.written, ...plan.replaced]) {
    if (path !== MANIFEST_PATH)
      await writeAtomic(plan.root, path, files[path]!);
  }
  for (const path of plan.removed) await remove(plan.root, path);
  if (plan.removed.some((p) => p.startsWith(`${HOOKS_DIR}/`)))
    await prune(plan.root, [HOOKS_DIR]);
  // Last: an interrupted install never claims files it did not write.
  if (changed.has(MANIFEST_PATH))
    await writeAtomic(plan.root, MANIFEST_PATH, files[MANIFEST_PATH]!);
}

/** The files `uninstall` removes: every listed file still there, then the manifest. */
export async function planUninstall(
  env: ManagedEnv,
): Promise<string[] | undefined> {
  const installed = await readInstalled(env.root);
  if (installed === undefined) return undefined;
  const removed: string[] = [];
  for (const path of Object.keys(installed.files).sort()) {
    if ((await onDisk(under(env.root, path))).kind !== "missing")
      removed.push(path);
  }
  return [...removed, MANIFEST_PATH];
}

/** Remove the files, the manifest last (an interrupted uninstall can be run again). */
export async function applyUninstall(
  root: string,
  removed: string[],
): Promise<void> {
  for (const path of removed) {
    if (path !== MANIFEST_PATH) await remove(root, path);
  }
  await remove(root, MANIFEST_PATH);
  await prune(root, [HOOKS_DIR, "zzpersona"]);
}
