import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseError } from "./errors.js";
import { listWorkspaces, publicPackages } from "./packages.js";
import type { RunResult, Runner } from "./run.js";

export interface ClaimOptions {
  root: string;
  /** Deprecate the `0.0.0` placeholders instead of publishing them. */
  deprecate: boolean;
  /** Without it, claim only lists what it would do and touches nothing. */
  yes: boolean;
  /** Defaults to `process.env`; only `CI` is read. */
  env?: NodeJS.ProcessEnv;
  run: Runner;
}

/**
 * On a listing run (`yes` false) the lists are what would happen: `claimed`
 * is what would be published, `deprecated` what would be deprecated.
 */
export interface ClaimResult {
  claimed: string[];
  existing: string[];
  deprecated: string[];
}

const README =
  "Reserved. Releases come from https://github.com/getdonn/donn.\n";
const DEPRECATION = "placeholder; use the latest version";

const missing = (res: RunResult): boolean =>
  res.code !== 0 && res.stderr.includes("E404");

function viewFailed(spec: string, res: RunResult): ReleaseError {
  return new ReleaseError(
    "view",
    `npm view ${spec} exited ${res.code}: ${(res.stderr.trim() || res.stdout.trim()).slice(0, 500)}`,
  );
}

/**
 * Local fallback for reserving the package names on npm: publishes a `0.0.0`
 * placeholder for each public package npm does not have, or (`deprecate`)
 * deprecates the placeholders. Always targets npm's default registry, and
 * npm prompts for the 2FA code on the terminal.
 */
export async function claim(opts: ClaimOptions): Promise<ClaimResult> {
  const { root, run, yes } = opts;
  if ((opts.env ?? process.env)["CI"]) {
    throw new ReleaseError(
      "ci",
      "claim runs only on the maintainer's machine (npm asks for a 2FA code); CI is set",
    );
  }
  const pkgs = publicPackages(await listWorkspaces(root, run));
  const result: ClaimResult = { claimed: [], existing: [], deprecated: [] };

  for (const pkg of pkgs) {
    if (opts.deprecate) {
      const spec = `${pkg.name}@0.0.0`;
      const view = await run("npm", ["view", spec, "version"], { cwd: root });
      if (view.code === 0 && view.stdout.trim() === "0.0.0") {
        if (yes) {
          const res = await run("npm", ["deprecate", spec, DEPRECATION], {
            cwd: root,
            stdio: "inherit",
          });
          if (res.code !== 0) {
            throw new ReleaseError(
              "deprecate",
              `npm deprecate ${spec} exited ${res.code}`,
            );
          }
        }
        result.deprecated.push(pkg.name);
      } else if (
        !(view.code === 0 && view.stdout.trim() === "") &&
        !missing(view)
      ) {
        throw viewFailed(spec, view);
      }
      continue;
    }

    const view = await run("npm", ["view", pkg.name, "name"], { cwd: root });
    if (view.code === 0) {
      result.existing.push(pkg.name);
      continue;
    }
    if (!missing(view)) throw viewFailed(pkg.name, view);
    if (yes) {
      const dir = await mkdtemp(join(tmpdir(), "donn-claim-"));
      try {
        const m = pkg.manifest;
        await writeFile(
          join(dir, "package.json"),
          `${JSON.stringify(
            {
              name: pkg.name,
              version: "0.0.0",
              description: m["description"],
              license: m["license"],
              repository: m["repository"],
            },
            null,
            2,
          )}\n`,
        );
        await writeFile(join(dir, "README.md"), README);
        const res = await run("npm", ["publish", dir, "--access", "public"], {
          cwd: root,
          stdio: "inherit",
        });
        if (res.code !== 0) {
          throw new ReleaseError(
            "publish",
            `npm publish ${pkg.name}@0.0.0 exited ${res.code}`,
          );
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    result.claimed.push(pkg.name);
  }
  return result;
}
