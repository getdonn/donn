#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkTarball } from "./check.js";
import { claim, claimLines } from "./claim.js";
import { ReleaseError } from "./errors.js";
import { packAll } from "./pack.js";
import { publish } from "./publish.js";
import { listWorkspaces, publicPackages } from "./packages.js";
import { realRunner } from "./run.js";
import { smoke } from "./smoke.js";
import { withTarball } from "./tarball.js";

const USAGE = `usage: donn-release <command> [options]

  pack [--check]
  smoke [--registry <url>] [--node <path>]
  publish --registry <url> [--dry-run] [--json]
  claim [--deprecate] [--yes]
`;

interface Flags {
  check?: boolean;
  registry?: string;
  node?: string;
  "dry-run"?: boolean;
  json?: boolean;
  deprecate?: boolean;
  yes?: boolean;
}

/** Resolves with an exit code, or nothing for success. */
type Command = (flags: Flags) => Promise<number | void>;

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

async function pack(flags: Flags): Promise<void> {
  const all = await listWorkspaces(ROOT, realRunner);
  const packed = await packAll(ROOT, publicPackages(all), realRunner);
  let failed = false;
  for (const { pkg, tarball } of packed) {
    const label = `${pkg.name}@${pkg.version}`;
    if (!flags.check) {
      process.stdout.write(`packed ${label} ${tarball}\n`);
      continue;
    }
    const problems = await withTarball(tarball, realRunner, (contents) =>
      checkTarball(contents, pkg, all),
    );
    if (problems.length === 0) process.stdout.write(`ok ${label}\n`);
    for (const p of problems) {
      failed = true;
      process.stdout.write(`FAIL ${label}: ${p}\n`);
    }
  }
  if (failed) throw new ReleaseError("check", "tarball check failed");
}

async function claimCommand(flags: Flags): Promise<number> {
  const mode = { deprecate: flags.deprecate === true, yes: flags.yes === true };
  const res = await claim({ root: ROOT, run: realRunner, ...mode });
  for (const line of claimLines(res, mode)) process.stdout.write(`${line}\n`);
  if (res.failed.length > 0) {
    process.stderr.write(
      `deprecate failed for ${res.failed.map((f) => f.name).join(", ")}\n`,
    );
    return 1;
  }
  return 0;
}

async function smokeCommand(flags: Flags): Promise<void> {
  const run = realRunner;
  if (flags.registry) {
    await smoke({
      root: ROOT,
      source: { registry: flags.registry },
      run,
      node: flags.node,
    });
    process.stdout.write("smoke ok\n");
    return;
  }
  const all = await listWorkspaces(ROOT, run);
  const tarballs = await packAll(ROOT, publicPackages(all), run);
  await smoke({ root: ROOT, source: { tarballs }, run, node: flags.node });
  process.stdout.write("smoke ok\n");
}

async function publishCommand(flags: Flags): Promise<number> {
  const summary = await publish({
    root: ROOT,
    registry: flags.registry ?? "",
    dryRun: flags["dry-run"] === true,
    env: { ...process.env },
    run: realRunner,
  });
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    for (const name of summary.published) {
      process.stdout.write(
        summary.dryRun
          ? `would publish ${name} (dry run)\n`
          : `published ${name}\n`,
      );
    }
    for (const name of summary.skipped) {
      process.stdout.write(
        summary.conflicted?.includes(name)
          ? `skipped ${name} (npm already has this version)\n`
          : `${name} skipped (already on ${summary.registry})\n`,
      );
    }
    if (summary.failed) {
      process.stdout.write(
        `failed: ${summary.failed.name}: ${summary.failed.error}\n`,
      );
    }
  }
  return summary.failed ? 1 : 0;
}

const commands: Record<string, Command> = {
  pack,
  smoke: smokeCommand,
  publish: publishCommand,
  claim: claimCommand,
};

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        check: { type: "boolean" },
        registry: { type: "string" },
        node: { type: "string" },
        "dry-run": { type: "boolean" },
        json: { type: "boolean" },
        deprecate: { type: "boolean" },
        yes: { type: "boolean" },
      },
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const [name] = parsed.positionals;
  if (name === "publish" && !parsed.values.registry) {
    process.stderr.write(`publish needs --registry <url>\n${USAGE}`);
    return 2;
  }
  const command = name === undefined ? undefined : commands[name];
  if (!command) {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    return (await command(parsed.values)) ?? 0;
  } catch (err) {
    if (err instanceof ReleaseError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

process.exitCode = await main(process.argv.slice(2));
