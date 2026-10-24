import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CompileOutput, Detection } from "@getdonn/adapter-sdk";
import { isAlive } from "@getdonn/executor";
import { writeFileAtomic } from "./fs.js";
import type { LiveState } from "./live-apply.js";

// A session folder: the folder of plugins a `donn claude` session launches with, so the
// persona plugin inside it can be swapped mid-session. See docs/planning/10-live-switching.md §1.

/** `donn claude --mode`: managed policy that detection cannot see. */
export type Mode = "partial" | "relaunch-no-mcp";

/** The detection facts a mode stands for; every compile for the session passes them. */
export const MODE_FACTS: Record<Mode, Detection["facts"]> = {
  partial: { sideloadBlocked: true },
  "relaunch-no-mcp": { managedMcp: true },
};

/** The parts of a persona a session cannot change after launch (spec 10): what `live` compares. */
export interface LaunchSnapshot {
  mcp: unknown;
  permissions: unknown;
  /** targets.claude-code: model, env, permissions.defaultMode … all in --settings. */
  settings: unknown;
}

export interface Launched {
  persona: string;
  source: string;
  pid: number;
  /** Whether the user overlay was applied at launch. */
  overlay?: boolean;
  snapshot?: LaunchSnapshot;
  /** Absent in sessions recorded before spec 14: read as claude-code. */
  harness?: "claude-code" | "codex";
  /** The project folder the session was launched for. */
  project?: string;
  startedAt?: string;
  /** `--mode`, when given: every recompile for the session passes its facts (MODE_FACTS). */
  mode?: Mode;
  /** See `buildHash`: lets the daemon tell whether a session runs the current build. */
  buildHash?: string;
}

export interface SessionInfo {
  dir: string;
  launched: Launched & { harness: "claude-code" | "codex" };
  live?: LiveState;
  running: boolean;
}

const ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;

const sessionsRoot = (home: string) => join(home, "sessions");

export const sessionPlugins = (sessionDir: string) =>
  join(sessionDir, "plugins");

/** The plugin's manifest name, which names its folder among the session's plugins. */
export async function pluginNameOf(pluginDir: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(pluginDir, ".claude-plugin/plugin.json"), "utf8"),
  ) as { name: string };
  return manifest.name;
}

export async function createSession(
  home: string,
  /** Undefined for Codex: no plugins/ folder, the session is only a registry entry. */
  pluginDir: string | undefined,
  launched: Omit<Launched, "pid">,
  pid: number,
): Promise<string> {
  const dir = join(sessionsRoot(home), randomBytes(8).toString("hex"));
  if (pluginDir === undefined) {
    await mkdir(dir, { recursive: true });
  } else {
    await mkdir(sessionPlugins(dir), { recursive: true });
    await cp(
      pluginDir,
      join(sessionPlugins(dir), await pluginNameOf(pluginDir)),
      {
        recursive: true,
        dereference: true,
      },
    );
  }
  await writeFileAtomic(
    join(dir, "launched.json"),
    `${JSON.stringify({ ...launched, pid }, null, 2)}\n`,
  );
  return dir;
}

export async function removeSession(sessionDir: string): Promise<void> {
  await rm(sessionDir, { recursive: true, force: true });
}

/** Session folders a crash left behind: older than a day, and their process is gone. */
export async function findOrphanSessions(
  home: string,
  now: number,
): Promise<string[]> {
  const root = sessionsRoot(home);
  const names = await readdir(root).catch(() => [] as string[]);
  const orphans: string[] = [];
  for (const name of names) {
    const dir = join(root, name);
    const info = await stat(dir).catch(() => undefined);
    if (!info?.isDirectory() || now - info.mtimeMs <= ORPHAN_AFTER_MS) continue;
    const launched = await readFile(join(dir, "launched.json"), "utf8")
      .then((text) => JSON.parse(text) as Partial<Launched>)
      .catch(() => ({}) as Partial<Launched>);
    if (typeof launched.pid === "number" && isAlive(launched.pid)) continue;
    orphans.push(dir);
  }
  return orphans;
}

/** Every registered session, oldest first; folders without a readable launch record are skipped. */
export async function listSessions(home: string): Promise<SessionInfo[]> {
  const root = sessionsRoot(home);
  const names = await readdir(root).catch(() => [] as string[]);
  const sessions: SessionInfo[] = [];
  for (const name of names) {
    const dir = join(root, name);
    const launched = await readFile(join(dir, "launched.json"), "utf8")
      .then((text) => JSON.parse(text) as Launched)
      .catch(() => undefined);
    if (!launched || typeof launched.pid !== "number") continue;
    const live = await readFile(join(dir, "live.json"), "utf8")
      .then((text) => JSON.parse(text) as LiveState)
      .catch(() => undefined);
    sessions.push({
      dir,
      launched: { ...launched, harness: launched.harness ?? "claude-code" },
      ...(live && { live }),
      running: isAlive(launched.pid),
    });
  }
  return sessions.sort(
    (a, b) =>
      (a.launched.startedAt ?? "").localeCompare(b.launched.startedAt ?? "") ||
      a.dir.localeCompare(b.dir),
  );
}

/**
 * A hash of the compiled build: every output file's path, mode and content (or copy source),
 * sorted by path. Output files hold `${NAME}` placeholders, never secret values (spec 14 §2).
 */
export function buildHash(output: CompileOutput): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(output.files).sort()) {
    const file = output.files[path]!;
    hash.update(
      JSON.stringify([
        path,
        file.mode ?? null,
        "content" in file
          ? { content: file.content }
          : { copyFrom: file.copyFrom },
      ]) + "\n",
    );
  }
  return hash.digest("hex");
}
