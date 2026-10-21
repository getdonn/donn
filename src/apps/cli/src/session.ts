import { randomBytes } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isAlive } from "@zzpersona/executor";
import { writeFileAtomic } from "./fs.js";

// A session folder: the folder of plugins a `zzpersona claude` session launches with, so the
// persona plugin inside it can be swapped mid-session. See docs/planning/10-live-switching.md §1.

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
  pluginDir: string,
  launched: Omit<Launched, "pid">,
  pid: number,
): Promise<string> {
  const dir = join(sessionsRoot(home), randomBytes(8).toString("hex"));
  await mkdir(sessionPlugins(dir), { recursive: true });
  await cp(
    pluginDir,
    join(sessionPlugins(dir), await pluginNameOf(pluginDir)),
    {
      recursive: true,
      dereference: true,
    },
  );
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
