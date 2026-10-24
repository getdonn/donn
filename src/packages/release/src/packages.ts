import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ReleaseError } from "./errors.js";
import type { Runner } from "./run.js";

export interface Workspace {
  name: string;
  version: string;
  dir: string;
  private: boolean;
  manifest: Record<string, unknown>;
}

export interface PublicPackage extends Workspace {
  /** `@getdonn/*` names in dependencies, peerDependencies, optionalDependencies. */
  deps: string[];
}

interface LsEntry {
  name?: string;
  version?: string;
  path: string;
  private?: boolean;
}

/** Every workspace (the root included), from `pnpm ls -r` and each manifest. */
export async function listWorkspaces(
  root: string,
  run: Runner,
): Promise<Workspace[]> {
  const res = await run("pnpm", ["ls", "-r", "--json", "--depth", "-1"], {
    cwd: root,
  });
  if (res.code !== 0) {
    throw new ReleaseError(
      "workspaces",
      `pnpm ls failed (${res.code}): ${res.stderr.trim()}`,
    );
  }
  let entries: LsEntry[];
  try {
    entries = JSON.parse(res.stdout) as LsEntry[];
  } catch {
    throw new ReleaseError("workspaces", "pnpm ls printed invalid JSON");
  }
  return Promise.all(
    entries.map(async (e) => {
      const manifest = JSON.parse(
        await readFile(join(e.path, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      return {
        name: e.name ?? String(manifest["name"] ?? e.path),
        version: e.version ?? String(manifest["version"] ?? "0.0.0"),
        dir: e.path,
        private: e.private === true || manifest["private"] === true,
        manifest,
      };
    }),
  );
}

const DEP_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function donnDeps(manifest: Record<string, unknown>): string[] {
  const found = new Set<string>();
  for (const field of DEP_FIELDS) {
    const block = manifest[field];
    if (block && typeof block === "object") {
      for (const name of Object.keys(block)) {
        if (name.startsWith("@getdonn/")) found.add(name);
      }
    }
  }
  return [...found].sort();
}

/** The non-private workspaces, dependencies first, ties broken by name. */
export function publicPackages(all: Workspace[]): PublicPackage[] {
  const pkgs: PublicPackage[] = all
    .filter((w) => !w.private)
    .map((w) => ({ ...w, deps: donnDeps(w.manifest) }));
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const placed = new Set<string>();
  const ordered: PublicPackage[] = [];
  let rest = [...pkgs].sort((a, b) => a.name.localeCompare(b.name));
  while (rest.length > 0) {
    const ready = rest.find((p) =>
      p.deps.every((d) => !byName.has(d) || placed.has(d)),
    );
    if (!ready) {
      throw new ReleaseError(
        "cycle",
        `dependency cycle among ${rest.map((p) => p.name).join(", ")}`,
      );
    }
    ordered.push(ready);
    placed.add(ready.name);
    rest = rest.filter((p) => p !== ready);
  }
  return ordered;
}
