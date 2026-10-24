import { lstat, readdir, readFile, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { isAlive } from "./process.js";

// Leftovers writeBuild can leave behind: locks from a process that died mid-build, version
// directories no build symlink points to, and temporary links from an interrupted swap.
// `donn doctor --fix` removes them. Anything changed in the last ten minutes is left
// alone: a running build writes its version and link, and creates its lock before writing
// the pid. See docs/planning/07-cli-daily-use.md, section 3.

export interface BuildLeftovers {
  staleLocks: string[];
  orphanVersions: string[];
  tempLinks: string[];
}

const VERSION = /^(.+)\.v-[0-9a-f]+$/;
const TEMP_LINK = /\.link-[0-9a-f]+$/;
const MIN_AGE_MS = 10 * 60 * 1000;

async function entries(dir: string) {
  return readdir(dir, { withFileTypes: true }).catch(() => []);
}

async function isOld(path: string) {
  const stat = await lstat(path).catch(() => undefined);
  return stat !== undefined && Date.now() - stat.mtimeMs > MIN_AGE_MS;
}

export async function findBuildLeftovers(
  home: string,
): Promise<BuildLeftovers> {
  const found: BuildLeftovers = {
    staleLocks: [],
    orphanVersions: [],
    tempLinks: [],
  };
  for (const persona of await entries(join(home, "build"))) {
    if (!persona.isDirectory()) continue;
    const dir = join(home, "build", persona.name);
    for (const entry of await entries(dir)) {
      const path = join(dir, entry.name);
      if (entry.name.endsWith(".lock") && entry.isDirectory()) {
        const pid = Number(
          await readFile(join(path, "pid"), "utf8").catch(() => ""),
        );
        const stale = pid > 0 ? !isAlive(pid) : await isOld(path);
        if (stale) found.staleLocks.push(path);
        continue;
      }
      const version = VERSION.exec(entry.name);
      if (version && entry.isDirectory()) {
        const target = await readlink(join(dir, version[1]!)).catch(
          () => undefined,
        );
        if (target !== entry.name && (await isOld(path)))
          found.orphanVersions.push(path);
        continue;
      }
      if (TEMP_LINK.test(entry.name) && (await isOld(path)))
        found.tempLinks.push(path);
    }
  }
  return found;
}

export async function removeBuildLeftovers(
  leftovers: BuildLeftovers,
): Promise<void> {
  for (const path of [
    ...leftovers.staleLocks,
    ...leftovers.orphanVersions,
    ...leftovers.tempLinks,
  ]) {
    await rm(path, { recursive: true, force: true });
  }
}
