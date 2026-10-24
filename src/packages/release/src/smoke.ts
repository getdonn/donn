import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ReleaseError } from "./errors.js";
import type { Packed } from "./pack.js";
import type { Runner } from "./run.js";

export interface SmokeOptions {
  root: string;
  source: { tarballs: Packed[] } | { registry: string };
  run: Runner;
}

const CLI = "@getdonn/cli";

function fail(step: string, detail: string): never {
  throw new ReleaseError("smoke", `${step}: ${detail}`);
}

/**
 * Installs the CLI into an empty prefix under a throwaway home and drives it
 * the way a new user would. Everything lives under one temp dir, removed after.
 */
export async function smoke(opts: SmokeOptions): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), "release-smoke-"));
  try {
    await runSteps(tmp, opts);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function runSteps(tmp: string, opts: SmokeOptions): Promise<void> {
  const { run, source } = opts;
  const prefix = join(tmp, "prefix");
  const home = join(tmp, "home");
  const donnHome = join(tmp, "donn-home");
  const stubBin = join(tmp, "stub-bin");
  const personas = join(tmp, "personas");
  await Promise.all(
    [prefix, home, donnHome, stubBin].map((d) => mkdir(d, { recursive: true })),
  );
  await writeFile(
    join(prefix, "package.json"),
    JSON.stringify({ name: "donn-smoke", version: "0.0.0", private: true }),
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    DONN_HOME: donnHome,
    PATH: [
      stubBin,
      join(prefix, "node_modules/.bin"),
      process.env["PATH"] ?? "",
    ].join(delimiter),
  };

  // 1. install
  const installArgs =
    "tarballs" in source
      ? [
          "install",
          "--prefix",
          prefix,
          ...source.tarballs.map((p) => p.tarball),
        ]
      : ["install", "--prefix", prefix, CLI, "--registry", source.registry];
  const install = await run("npm", installArgs, { cwd: tmp, env });
  if (install.code !== 0) {
    fail(
      "install",
      `npm install exited ${install.code}: ${install.stderr.trim()}`,
    );
  }

  // 2. version
  let expected: string;
  if ("tarballs" in source) {
    const cli = source.tarballs.find((p) => p.pkg.name === CLI);
    if (!cli) fail("version", `no ${CLI} tarball to smoke`);
    expected = cli.pkg.version;
  } else {
    try {
      const manifest = JSON.parse(
        await readFile(
          join(prefix, "node_modules", CLI, "package.json"),
          "utf8",
        ),
      ) as { version: string };
      expected = manifest.version;
    } catch (err) {
      fail(
        "version",
        `cannot read the installed ${CLI}: ${(err as Error).message}`,
      );
    }
  }
  const version = await donn(["--version"], "version");
  if (version.stdout.trim() !== expected) {
    fail(
      "version",
      `donn --version printed "${version.stdout.trim()}", expected "${expected}"`,
    );
  }

  // 3-5. JSON-printing commands
  await donnJson(["capabilities", "--json"], "capabilities");
  await donnJson(["init", "--personas", personas, "--json"], "init");
  await donnJson(["resolve", "org/base", "--json"], "resolve");
  await donnJson(["compile", "org/base", "--json"], "compile");
  await donnJson(["doctor", "--json"], "doctor", false);

  // 6. mod install, against a stub claude
  const claudeLog = join(tmp, "claude.log");
  const claude = join(stubBin, "claude");
  await writeFile(claude, `#!/bin/sh\necho "$@" >> '${claudeLog}'\nexit 0\n`);
  await chmod(claude, 0o755);
  await donn(["mod", "install", "--json"], "mod install");
  const plugin = join(donnHome, "mod/plugin/.claude-plugin/plugin.json");
  try {
    await stat(plugin);
  } catch {
    fail("mod install", `${plugin} was not written`);
  }

  async function donn(args: string[], step: string, mustPass = true) {
    const res = await run("donn", args, { cwd: tmp, env });
    if (mustPass && res.code !== 0) {
      fail(
        step,
        `donn ${args.join(" ")} exited ${res.code}: ${res.stderr.trim()}`,
      );
    }
    return res;
  }

  async function donnJson(args: string[], step: string, mustPass = true) {
    const res = await donn(args, step, mustPass);
    try {
      JSON.parse(res.stdout);
    } catch {
      fail(step, `donn ${args.join(" ")} did not print JSON`);
    }
  }
}
