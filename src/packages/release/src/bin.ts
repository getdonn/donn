#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkTarball } from "./check.js";
import { ReleaseError } from "./errors.js";
import { packAll } from "./pack.js";
import { listWorkspaces, publicPackages } from "./packages.js";
import { realRunner } from "./run.js";
import { withTarball } from "./tarball.js";

const USAGE = `usage: donn-release <command> [options]

  pack [--check]
  smoke [--registry <url>]
  publish [--registry <url>] [--dry-run] [--json]
  claim [--deprecate]
`;

interface Flags {
  check?: boolean;
  registry?: string;
  "dry-run"?: boolean;
  json?: boolean;
  deprecate?: boolean;
}

type Command = (flags: Flags) => Promise<void>;

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

const stub =
  (name: string): Command =>
  () =>
    Promise.reject(
      new ReleaseError("not-implemented", `${name} is not implemented yet`),
    );

const commands: Record<string, Command> = {
  pack,
  smoke: stub("smoke"),
  publish: stub("publish"),
  claim: stub("claim"),
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
        "dry-run": { type: "boolean" },
        json: { type: "boolean" },
        deprecate: { type: "boolean" },
      },
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const [name] = parsed.positionals;
  const command = name === undefined ? undefined : commands[name];
  if (!command) {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    await command(parsed.values);
    return 0;
  } catch (err) {
    if (err instanceof ReleaseError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

process.exitCode = await main(process.argv.slice(2));
