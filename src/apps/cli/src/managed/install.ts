import { randomBytes } from "node:crypto";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ManagedManifest } from "@getdonn/adapter-sdk";
import { CliError } from "../errors.js";
import { checkedPath, MANIFEST_PATH, readBundle } from "./bundle-io.js";
import { asObject, earlierReplaced, SETTINGS_PATH } from "./drop-ins.js";
import type { ManagedEnv } from "./env.js";

// Put a bundle into the policy folder, or take it out again. Only files donn owns (listed
// in the installed manifest, or in pending.json after an interrupted install) are ever replaced
// or removed; anything else that is in the way is refused, by name, before the first write.
// See docs/planning/21-managed-settings.md, section 3.

/**
 * Where donn's files go under the root: its folder (which holds the manifest, pending.json and
 * hooks, and names the manifest's version field) and its settings drop-in. The only other layout
 * is the old name's, which `donn migrate --managed` removes with these same rules.
 */
export interface ManagedLayout {
  folder: string;
  dropIn: string;
}

export const LAYOUT: ManagedLayout = {
  folder: "donn",
  dropIn: "managed-settings.d/50-donn.json",
};

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A layout's bookkeeping paths and the only paths it ever writes or removes under the root. */
function layoutPaths(layout: ManagedLayout) {
  const { folder, dropIn } = layout;
  const hooks = `${folder}/hooks`;
  return {
    manifest: `${folder}/manifest.json`,
    pending: `${folder}/pending.json`,
    hooks,
    /** Every folder an own path lives in, below the root. */
    folders: ["managed-settings.d", folder, hooks],
    own: new RegExp(
      `^(?:${escapeRegExp(dropIn)}|managed-mcp\\.json|${escapeRegExp(folder)}/manifest\\.json|${escapeRegExp(hooks)}/[^/]+)$`,
    ),
  };
}

const OWN = layoutPaths(LAYOUT);
const HOOKS_DIR = OWN.hooks;
/** Written before an install's first write, removed after its manifest: what it may have written. */
export const PENDING_PATH = OWN.pending;
const OWN_PATH = OWN.own;

const isMissing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/** A root-relative path, `/`-separated, as an absolute path under `root`. */
export const under = (root: string, path: string) =>
  join(root, ...path.split("/"));

function isOwnPath(path: string, own = OWN_PATH): boolean {
  try {
    checkedPath(path);
  } catch {
    return false;
  }
  return own.test(path);
}

function ownPath(path: string, listedIn: string): string {
  checkedPath(path);
  if (!OWN_PATH.test(path)) {
    throw new CliError(
      "managed-foreign-path",
      `${listedIn} lists ${path}, which is not a file donn installs`,
      { path },
    );
  }
  return path;
}

/** Thrown when an installed manifest comes from a newer donn: touch nothing. */
function newerFormat(
  manifest: Record<string, unknown>,
  path: string,
  field: string,
) {
  const version =
    typeof manifest[field] === "string"
      ? manifest[field]
      : "an unknown version";
  return new CliError(
    "managed-newer-format",
    `installed by a newer donn (${version}); upgrade donn`,
    { path, format: manifest.format },
  );
}

/**
 * The manifest a previous install left in `root`, or undefined when there is none. Throws
 * `managed-newer-format` for a newer format and `managed-bad-installed` when it cannot be read,
 * since then nobody can tell which files donn owns.
 */
export async function readInstalled(
  root: string,
  layout: ManagedLayout = LAYOUT,
): Promise<ManagedManifest | undefined> {
  const { manifest: manifestPath, own } = layoutPaths(layout);
  const path = under(root, manifestPath);
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
      `${path} ${why}; donn cannot tell which files it installed`,
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
    throw newerFormat(manifest, path, layout.folder);
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
  for (const key of Object.keys(files)) {
    if (!isOwnPath(key, own))
      throw bad(`lists ${key}, which donn never installs`);
  }
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

/**
 * The paths an interrupted install may have written (its pending.json), or undefined when no
 * install is pending. Throws `managed-bad-installed` when the file cannot be read.
 */
export async function readPending(
  root: string,
  layout: ManagedLayout = LAYOUT,
): Promise<string[] | undefined> {
  const { pending, own } = layoutPaths(layout);
  const path = under(root, pending);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let paths: unknown;
  try {
    paths = (JSON.parse(text) as { paths?: unknown }).paths;
  } catch {
    paths = undefined;
  }
  if (
    !Array.isArray(paths) ||
    paths.some((p) => typeof p !== "string" || !isOwnPath(p, own))
  ) {
    throw new CliError(
      "managed-bad-installed",
      `${path} cannot be read; donn cannot tell which files an interrupted install wrote`,
      { path },
    );
  }
  return paths as string[];
}

const unsafe = (path: string, reason: string) =>
  new CliError("managed-unsafe", `${path} ${reason}; nothing was changed`, {
    path,
    reason,
  });

/**
 * Before any write or removal: the root and donn's folders must be real folders (never a
 * symbolic link, so nothing is written or removed through one), and its bookkeeping files real
 * files. Running as root, each must also be root's and not writable by group or others, or
 * someone else could change what root installs.
 */
async function checkFolders(
  env: ManagedEnv,
  layout: ManagedLayout = LAYOUT,
): Promise<void> {
  const paths = layoutPaths(layout);
  const items: [string, "dir" | "file"][] = [
    [env.root, "dir"],
    ...paths.folders.map((d): [string, "dir"] => [under(env.root, d), "dir"]),
    [under(env.root, paths.manifest), "file"],
    [under(env.root, paths.pending), "file"],
  ];
  for (const [path, want] of items) {
    const info = await env.inspect(path);
    if (info === undefined) continue;
    if (info.kind === "symlink") {
      throw unsafe(path, "is a symbolic link; donn never writes through one");
    }
    if (info.kind !== want) {
      throw unsafe(path, want === "dir" ? "is not a folder" : "is not a file");
    }
    if (!env.strict()) continue;
    if (info.uid !== 0) {
      throw unsafe(path, `is owned by uid ${info.uid}, not root`);
    }
    if ((info.mode & 0o022) !== 0) {
      throw unsafe(
        path,
        `is writable by group or others (mode ${info.mode.toString(8).padStart(4, "0")})`,
      );
    }
  }
}

export interface InstallPlan {
  root: string;
  /** Paths in write order; the manifest, when it changes, is last. */
  written: string[];
  replaced: string[];
  removed: string[];
  unchanged: string[];
  /** What pending.json lists while this install runs: every path it may own. */
  pending: string[];
  /** An earlier install was interrupted; its pending.json goes once this one finishes. */
  hadPending: boolean;
  /** Single values in policy files read before ours that ours will replace. */
  replaces: { key: string; file: string }[];
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
  await checkFolders(env);
  const installed = await readInstalled(env.root);
  const pending = await readPending(env.root);
  const owned = new Set([
    ...(installed ? [...Object.keys(installed.files), MANIFEST_PATH] : []),
    ...(pending ?? []),
  ]);
  const plan: InstallPlan = {
    root: env.root,
    written: [],
    replaced: [],
    removed: [],
    unchanged: [],
    pending: [...new Set([...owned, ...Object.keys(files)])].sort(),
    hadPending: pending !== undefined,
    replaces: [],
  };
  const settings = files[SETTINGS_PATH];
  if (settings !== undefined) {
    let ours: Record<string, unknown> | undefined;
    try {
      ours = asObject(JSON.parse(new TextDecoder().decode(settings)));
    } catch {
      ours = undefined;
    }
    if (ours !== undefined)
      plan.replaces = await earlierReplaced(env.root, ours);
  }
  const refused: string[] = [];
  const order = [
    ...Object.keys(files).filter((p) => p !== MANIFEST_PATH),
    MANIFEST_PATH,
  ];
  for (const path of order) {
    const current = await onDisk(under(env.root, path));
    if (current.kind === "missing") plan.written.push(path);
    // Already the bundle's bytes: nothing to write, whoever wrote it (an interrupted install).
    else if (current.kind === "file" && sameBytes(current.bytes, files[path]!))
      plan.unchanged.push(path);
    else if (!owned.has(path)) refused.push(under(env.root, path));
    else plan.replaced.push(path);
  }
  if (refused.length > 0) {
    throw new CliError(
      "managed-not-owned",
      refused.length === 1
        ? `${refused[0]} exists and donn did not install it; refusing to replace it (nothing was written)`
        : `${refused.join(", ")} exist and donn did not install them; refusing to replace them (nothing was written)`,
      { paths: refused },
    );
  }
  for (const path of [...owned].sort()) {
    if (path in files || path === MANIFEST_PATH) continue;
    if ((await onDisk(under(env.root, path))).kind !== "missing")
      plan.removed.push(path);
  }
  return { plan, files };
}

export const planIsEmpty = (plan: InstallPlan) =>
  plan.written.length + plan.replaced.length + plan.removed.length === 0;

/** Chown to root only when running as root on POSIX; elsewhere the folder's defaults apply. */
const asRoot = () => process.platform !== "win32" && process.getuid?.() === 0;

/** Run a filesystem step; an OS error becomes a `filesystem` error saying what failed. */
async function step<T>(
  verb: "write" | "remove",
  path: string,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === undefined) throw error;
    throw new CliError("filesystem", `could not ${verb} ${path}: ${errno}`, {
      path,
      errno,
    });
  }
}

/** Flush a folder's entries (a rename or removal) to disk; not possible on Windows. */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // The change itself is done; a folder that cannot be flushed is not worth failing over.
  }
}

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
    await step("write", at, async () => {
      await mkdir(at, { mode: 0o755 });
      await chmod(at, 0o755);
      if (asRoot()) await chown(at, 0, 0);
    });
  }
}

/** Temp file in the same folder, flushed, mode and owner set, then renamed over the target. */
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
  await step("write", file, async () => {
    try {
      const handle = await open(tmp, "wx", mode);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(tmp, mode);
      if (asRoot()) await chown(tmp, 0, 0);
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  });
  await syncDir(dirname(file));
}

async function remove(root: string, path: string): Promise<void> {
  const file = under(root, path);
  await step("remove", file, () => rm(file, { force: true }));
  await syncDir(dirname(file));
}

/** Remove folders once they are empty (never recursively); anyone else's file keeps them. */
async function prune(root: string, dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    // ENOTEMPTY (someone else's file) or ENOENT: leave it as it is.
    await rmdir(dir === "." ? root : under(root, dir)).catch(() => undefined);
  }
}

const pendingBytes = (paths: string[]) =>
  new TextEncoder().encode(
    `${JSON.stringify({ format: 1, paths }, null, 2)}\n`,
  );

/**
 * pending.json first, then the planned files, the removals and the manifest; pending.json goes
 * last. An install interrupted anywhere leaves pending.json naming everything it may have
 * written, so the next install or uninstall owns those files.
 */
export async function applyInstall(
  env: ManagedEnv,
  { plan, files }: PlannedInstall,
): Promise<void> {
  if (!planIsEmpty(plan)) {
    await writeAtomic(plan.root, PENDING_PATH, pendingBytes(plan.pending));
    for (const path of [...plan.written, ...plan.replaced]) {
      if (path === MANIFEST_PATH) continue;
      env.onWrite?.(path);
      await writeAtomic(plan.root, path, files[path]!);
    }
    for (const path of plan.removed) await remove(plan.root, path);
    if (plan.removed.some((p) => p.startsWith(`${HOOKS_DIR}/`)))
      await prune(plan.root, [HOOKS_DIR]);
    if ([...plan.written, ...plan.replaced].includes(MANIFEST_PATH)) {
      env.onWrite?.(MANIFEST_PATH);
      await writeAtomic(plan.root, MANIFEST_PATH, files[MANIFEST_PATH]!);
    }
  }
  if (!planIsEmpty(plan) || plan.hadPending)
    await remove(plan.root, PENDING_PATH);
}

/**
 * What `uninstall` removes: every file the manifest or a pending install lists that is still
 * there, then the manifest and pending.json. Undefined when neither exists.
 */
export async function planUninstall(
  env: ManagedEnv,
  layout: ManagedLayout = LAYOUT,
): Promise<string[] | undefined> {
  const paths = layoutPaths(layout);
  await checkFolders(env, layout);
  const installed = await readInstalled(env.root, layout);
  const pending = await readPending(env.root, layout);
  if (installed === undefined && pending === undefined) return undefined;
  const listed = new Set([
    ...Object.keys(installed?.files ?? {}),
    ...(pending ?? []),
  ]);
  listed.delete(paths.manifest);
  const removed: string[] = [];
  for (const path of [...listed].sort()) {
    if ((await onDisk(under(env.root, path))).kind !== "missing")
      removed.push(path);
  }
  return [
    ...removed,
    ...(installed ? [paths.manifest] : []),
    ...(pending ? [paths.pending] : []),
  ];
}

/** Remove the files, then the manifest, then pending.json (an interrupted uninstall can run again). */
export async function applyUninstall(
  root: string,
  removed: string[],
  layout: ManagedLayout = LAYOUT,
): Promise<void> {
  const paths = layoutPaths(layout);
  const bookkeeping = [paths.manifest, paths.pending];
  for (const path of removed) {
    if (!bookkeeping.includes(path)) await remove(root, path);
  }
  for (const path of bookkeeping) await remove(root, path);
  // Back to how the machine was before: empty folders go, the root too; others' files keep them.
  await prune(root, [paths.hooks, layout.folder, "managed-settings.d", "."]);
}
