import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseError } from "./errors.js";
import { listWorkspaces, publicPackages } from "./packages.js";
import { isMissing, isNpmjs } from "./publish.js";
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
 * `alreadyDeprecated` and `noPlaceholder` (no `0.0.0` on npm) are skipped,
 * and `failed` holds the `npm deprecate` calls that failed: a deprecation
 * failure does not stop the run, so the caller must check it.
 */
export interface ClaimResult {
  claimed: string[];
  existing: string[];
  deprecated: string[];
  alreadyDeprecated: string[];
  noPlaceholder: string[];
  failed: { name: string; error: string }[];
}

const README =
  "Reserved. Releases come from https://github.com/getdonn/donn.\n";
const DEPRECATION = "placeholder; use the latest version";

function viewFailed(spec: string, res: RunResult): ReleaseError {
  return new ReleaseError(
    "view",
    `npm view ${spec} exited ${res.code}: ${(res.stderr.trim() || res.stdout.trim()).slice(0, 500)}`,
  );
}

type Placeholder = "none" | "live" | "deprecated";

/**
 * Reads `npm view <name>@0.0.0 version deprecated --json`: npm prints an
 * object when the version is deprecated and a bare JSON string (the version)
 * when it is not; a missing version is E404 or empty output.
 */
function placeholderState(spec: string, view: RunResult): Placeholder {
  if (isMissing(view)) return "none";
  if (view.code !== 0) throw viewFailed(spec, view);
  const out = view.stdout.trim();
  if (out === "") return "none";
  let json: unknown;
  try {
    json = JSON.parse(out);
  } catch {
    throw viewFailed(spec, view);
  }
  const info =
    typeof json === "string"
      ? { version: json, deprecated: undefined }
      : (json as { version?: unknown; deprecated?: unknown } | null);
  if (info?.version !== "0.0.0") return "none";
  return typeof info.deprecated === "string" && info.deprecated !== ""
    ? "deprecated"
    : "live";
}

/** The lines `claim` prints: one per package, then the closing line. */
export function claimLines(
  res: ClaimResult,
  mode: { deprecate: boolean; yes: boolean },
): string[] {
  const lines: string[] = [];
  const work = mode.deprecate ? res.deprecated : res.claimed;
  if (mode.deprecate) {
    const verb = mode.yes ? "deprecated" : "would deprecate";
    for (const n of res.deprecated) lines.push(`${verb} ${n}`);
    for (const n of res.alreadyDeprecated)
      lines.push(`already deprecated ${n}`);
    for (const n of res.noPlaceholder) lines.push(`no placeholder ${n}`);
    for (const f of res.failed) lines.push(`failed ${f.name}: ${f.error}`);
  } else {
    const verb = mode.yes ? "claimed" : "would claim";
    for (const n of res.claimed) lines.push(`${verb} ${n}`);
    for (const n of res.existing) lines.push(`exists ${n}`);
  }
  if (work.length === 0) {
    lines.push(`nothing to ${mode.deprecate ? "deprecate" : "claim"}`);
  } else if (!mode.yes) {
    lines.push("nothing changed; pass --yes to do it");
  }
  return lines;
}

/**
 * Local fallback for reserving the package names on npm: publishes a `0.0.0`
 * placeholder for each public package npm does not have, or (`deprecate`)
 * deprecates the placeholders. It targets whatever registry npm is configured
 * for and refuses unless that is npmjs (an env var or .npmrc can redirect it),
 * and npm prompts for the 2FA code on the terminal.
 */
export async function claim(opts: ClaimOptions): Promise<ClaimResult> {
  const { root, run, yes } = opts;
  if ((opts.env ?? process.env)["CI"]) {
    throw new ReleaseError(
      "ci",
      "claim runs only on the maintainer's machine (npm asks for a 2FA code); CI is set",
    );
  }
  const reg = await run("npm", ["config", "get", "registry"], { cwd: root });
  const registry = reg.stdout.trim();
  if (reg.code !== 0 || !isNpmjs(registry)) {
    throw new ReleaseError(
      "registry",
      `claim publishes to npmjs only; npm's registry is ${registry || `unknown (npm config exited ${reg.code})`}`,
    );
  }
  const pkgs = publicPackages(await listWorkspaces(root, run));
  const result: ClaimResult = {
    claimed: [],
    existing: [],
    deprecated: [],
    alreadyDeprecated: [],
    noPlaceholder: [],
    failed: [],
  };

  for (const pkg of pkgs) {
    if (opts.deprecate) {
      const spec = `${pkg.name}@0.0.0`;
      const view = await run(
        "npm",
        ["view", spec, "version", "deprecated", "--json"],
        { cwd: root },
      );
      const state = placeholderState(spec, view);
      if (state === "none") {
        result.noPlaceholder.push(pkg.name);
      } else if (state === "deprecated") {
        result.alreadyDeprecated.push(pkg.name);
      } else if (!yes) {
        result.deprecated.push(pkg.name);
      } else {
        const res = await run("npm", ["deprecate", spec, DEPRECATION], {
          cwd: root,
          stdio: "inherit",
        });
        if (res.code === 0) {
          result.deprecated.push(pkg.name);
        } else {
          result.failed.push({
            name: pkg.name,
            error: `npm deprecate ${spec} exited ${res.code}`,
          });
        }
      }
      continue;
    }

    const view = await run("npm", ["view", pkg.name, "name"], { cwd: root });
    if (view.code === 0) {
      result.existing.push(pkg.name);
      continue;
    }
    if (!isMissing(view)) throw viewFailed(pkg.name, view);
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
