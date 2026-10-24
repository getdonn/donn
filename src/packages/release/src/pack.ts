import { copyFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ReleaseError } from "./errors.js";
import type { PublicPackage } from "./packages.js";
import type { Runner } from "./run.js";

export interface Packed {
  pkg: PublicPackage;
  tarball: string;
}

const LEGAL = ["LICENSE", "NOTICE"] as const;

/**
 * `pnpm pack` every package into `outDir`, with the root LICENSE and NOTICE
 * copied into each package folder for the pack (npm only takes them from
 * there) and removed afterwards.
 */
export async function packAll(
  root: string,
  pkgs: PublicPackage[],
  run: Runner,
  outDir = join(root, "dist-release/npm"),
): Promise<Packed[]> {
  await mkdir(outDir, { recursive: true });
  const packed: Packed[] = [];
  for (const pkg of pkgs) {
    const copies = LEGAL.map((f) => join(pkg.dir, f));
    try {
      for (const f of LEGAL) await copyFile(join(root, f), join(pkg.dir, f));
      const res = await run("pnpm", ["pack", "--pack-destination", outDir], {
        cwd: pkg.dir,
      });
      if (res.code !== 0) {
        throw new ReleaseError(
          "pack",
          `pnpm pack failed for ${pkg.name} (${res.code}): ${res.stderr.trim()}`,
        );
      }
      const last = res.stdout.trim().split("\n").at(-1)?.trim();
      if (!last) {
        throw new ReleaseError(
          "pack",
          `pnpm pack printed no tarball path for ${pkg.name}`,
        );
      }
      packed.push({ pkg, tarball: resolve(pkg.dir, last) });
    } finally {
      await Promise.all(copies.map((f) => rm(f, { force: true })));
    }
  }
  return packed;
}
