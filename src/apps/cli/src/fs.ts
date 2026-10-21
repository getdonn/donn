import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CliError } from "./errors.js";

/** Write via a temporary sibling and rename, so readers never see a partial file. */
export async function writeFileAtomic(
  path: string,
  content: string,
  mode?: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, content, mode === undefined ? undefined : { mode });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** Run a filesystem step; an OS error becomes a `filesystem` error naming the path. */
export async function fsStep<T>(
  path: string,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === undefined) throw error;
    throw new CliError("filesystem", `could not write ${path}: ${errno}`, {
      path,
      errno,
    });
  }
}

const LOCK_POLL_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
/** Holders write a small file and let go in milliseconds; an older lock was abandoned. */
const LOCK_STALE_MS = 10_000;

/** Serialize `body` across processes with a directory lock (mkdir is atomic). */
export async function withFileLock<T>(
  lock: string,
  body: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  await mkdir(dirname(lock), { recursive: true });
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new CliError(
          "locked",
          `${lock} is held by another zzpersona command; retry, or remove it if none is running`,
          { lock },
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
