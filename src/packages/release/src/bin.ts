#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ReleaseError } from "./errors.js";

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

const stub =
  (name: string): Command =>
  () =>
    Promise.reject(
      new ReleaseError("not-implemented", `${name} is not implemented yet`),
    );

const commands: Record<string, Command> = {
  pack: stub("pack"),
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
