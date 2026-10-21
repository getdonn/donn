import { randomBytes } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { CompileOutput } from "@zzpersona/adapter-sdk";
import type { LocalStore } from "@zzpersona/store-local";
import { ExecutorError } from "./errors.js";

// Writes a compile output to its build directory: into a temporary sibling, then swapped in, so a
// failed build never replaces a good one. copyFrom sources, and everything inside a copied
// directory, must resolve (symlinks followed) inside their mount. See 06 §3.

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

export async function writeBuild(
  output: CompileOutput,
  options: { buildDir: string; store: LocalStore },
): Promise<void> {
  const { buildDir, store } = options;
  const buildRoot = dirname(dirname(buildDir));
  await mkdir(buildRoot, { recursive: true, mode: 0o700 });
  await chmod(buildRoot, 0o700);
  await mkdir(dirname(buildDir), { recursive: true });

  const tmp = `${buildDir}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    for (const [path, file] of Object.entries(output.files)) {
      const target = join(tmp, path);
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
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ExecutorError(
            `${file.copyFrom} not found at ${location.path}`,
          );
        }
        throw error;
      }
      await cp(location.path, target, { recursive: true, dereference: true });
      if (file.mode !== undefined) await chmod(target, file.mode);
    }
    const old = `${buildDir}.old-${process.pid}`;
    const hadBuild = await lstat(buildDir).then(
      () => true,
      () => false,
    );
    if (hadBuild) await rename(buildDir, old);
    await rename(tmp, buildDir);
    if (hadBuild) await rm(old, { recursive: true, force: true });
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    throw error;
  }
}
