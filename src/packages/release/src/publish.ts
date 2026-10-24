import { ReleaseError } from "./errors.js";
import { packAll } from "./pack.js";
import { listWorkspaces, publicPackages } from "./packages.js";
import type { Runner } from "./run.js";

export interface PublishOptions {
  root: string;
  registry: string;
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
  run: Runner;
}

/** Entries are `name@version`. */
export interface PublishSummary {
  registry: string;
  dryRun: boolean;
  published: string[];
  skipped: string[];
  failed?: { name: string; error: string };
}

const MIN_NPM = [11, 5, 1] as const;
const NPMJS = "https://registry.npmjs.org";

/** True when `version` (major.minor.patch, numerically) is at least `min`. */
function atLeast(version: string, min: readonly number[]): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!parts) return false;
  for (let i = 0; i < min.length; i++) {
    const have = Number(parts[i + 1]);
    const need = min[i] ?? 0;
    if (have !== need) return have > need;
  }
  return true;
}

async function guards(opts: PublishOptions): Promise<void> {
  const { root, registry, env, run } = opts;
  const status = await run("git", ["status", "--porcelain"], { cwd: root });
  if (status.code !== 0 || status.stdout.trim() !== "") {
    throw new ReleaseError(
      "dirty",
      status.code !== 0
        ? `git status failed (${status.code}): ${status.stderr.trim()}`
        : `the working tree is not clean:\n${status.stdout.trimEnd()}`,
    );
  }
  if (!env["CI"]) return;

  const npm = await run("npm", ["--version"], { cwd: root, env });
  if (npm.code !== 0 || !atLeast(npm.stdout, MIN_NPM)) {
    throw new ReleaseError(
      "npm-too-old",
      `npm ${MIN_NPM.join(".")} or newer is needed for trusted publishing, found "${npm.stdout.trim()}"`,
    );
  }
  if (registry.replace(/\/$/, "") === NPMJS && "NODE_AUTH_TOKEN" in env) {
    throw new ReleaseError(
      "token-set",
      "NODE_AUTH_TOKEN is set (even empty, it blocks OIDC trusted publishing); unset it",
    );
  }
}

/**
 * Publishes every public package the registry does not have yet, dependencies
 * first. A re-run skips what is already there; the first failure stops it.
 */
export async function publish(opts: PublishOptions): Promise<PublishSummary> {
  const { root, registry, dryRun, env, run } = opts;
  await guards(opts);

  const summary: PublishSummary = {
    registry,
    dryRun,
    published: [],
    skipped: [],
  };
  const pkgs = publicPackages(await listWorkspaces(root, run));
  for (const pkg of pkgs) {
    const label = `${pkg.name}@${pkg.version}`;
    const stop = (error: string): PublishSummary => {
      summary.failed = { name: label, error };
      return summary;
    };

    const view = await run(
      "npm",
      ["view", label, "version", "--registry", registry],
      { cwd: root, env },
    );
    const seen = view.stdout.trim();
    if (view.code === 0 && seen === pkg.version) {
      summary.skipped.push(label);
      continue;
    }
    // Exit 0 with no output: the package exists, this version does not.
    const missing =
      (view.code === 0 && seen === "") ||
      (view.code !== 0 && view.stderr.includes("E404"));
    if (!missing) {
      return stop(
        `npm view exited ${view.code}: ${(view.stderr.trim() || seen).slice(0, 500)}`,
      );
    }

    let tarball: string;
    try {
      const [packed] = await packAll(root, [pkg], run);
      if (!packed) return stop("pack produced no tarball");
      tarball = packed.tarball;
    } catch (err) {
      return stop((err as Error).message);
    }
    const res = await run(
      "npm",
      [
        "publish",
        tarball,
        "--access",
        "public",
        "--registry",
        registry,
        ...(dryRun ? ["--dry-run"] : []),
      ],
      { cwd: root, env },
    );
    if (res.code !== 0) {
      return stop(`npm publish exited ${res.code}: ${res.stderr.trim()}`);
    }
    summary.published.push(label);
  }
  return summary;
}
