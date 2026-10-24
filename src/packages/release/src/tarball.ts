import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseError } from "./errors.js";
import type { Runner } from "./run.js";

export interface TarballContents {
  /** The extraction root; the tarball's files live under `<dir>/package/`. */
  dir: string;
  /** Files relative to `package/`, with `/` separators, sorted. */
  files: string[];
}

async function walk(base: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(base, rel), { withFileTypes: true })) {
    const path = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walk(base, path)));
    else out.push(path);
  }
  return out.sort();
}

/** Extracts a tarball into a fresh temp dir and lists what is in it. */
export async function readTarball(
  tarball: string,
  run: Runner,
): Promise<TarballContents> {
  const dir = await mkdtemp(join(tmpdir(), "release-tar-"));
  const res = await run("tar", ["-xzf", tarball, "-C", dir]);
  if (res.code !== 0) {
    throw new ReleaseError(
      "tarball",
      `tar failed on ${tarball} (${res.code}): ${res.stderr.trim()}`,
    );
  }
  return { dir, files: await walk(join(dir, "package")) };
}
