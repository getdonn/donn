import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { ReleaseError } from "./errors.js";
import type { Packed } from "./pack.js";
import type { Runner } from "./run.js";

export interface SmokeOptions {
  root: string;
  source: { tarballs: Packed[] } | { registry: string };
  run: Runner;
  /** Run `donn` with this node (`<node> <donn bin> ...`) instead of its shebang's. */
  node?: string;
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
  const node = opts.node === undefined ? undefined : resolve(opts.node);
  if (node !== undefined) {
    try {
      if (!(await stat(node)).isFile()) throw new Error("not a file");
    } catch {
      return fail("node", `${opts.node} not found`);
    }
  }
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

  // Nothing of the caller's environment may steer the CLI: drop every DONN_*
  // and the config/XDG locations, so defaults land under the throwaway HOME.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("DONN_") ||
      key.startsWith("XDG_") ||
      key.startsWith("npm_config_") ||
      key.startsWith("NPM_CONFIG_")
    ) {
      delete env[key];
    }
  }
  delete env["CLAUDE_CONFIG_DIR"];
  delete env["NODE_OPTIONS"];
  env["HOME"] = home;
  env["DONN_HOME"] = donnHome;
  env["PATH"] = [stubBin, process.env["PATH"] ?? ""].join(delimiter);
  // By absolute path: a `donn` elsewhere on PATH can never stand in.
  const donnBin = join(prefix, "node_modules/.bin/donn");

  // The version the workspace is about to publish; both modes check for it.
  let expected: string;
  try {
    const manifest = JSON.parse(
      await readFile(join(opts.root, "src/apps/cli/package.json"), "utf8"),
    ) as { version: string };
    expected = manifest.version;
  } catch (err) {
    return fail(
      "version",
      `cannot read the workspace ${CLI} version: ${(err as Error).message}`,
    );
  }

  // 1. install
  const installArgs =
    "tarballs" in source
      ? [
          "install",
          "--prefix",
          prefix,
          ...source.tarballs.map((p) => p.tarball),
        ]
      : [
          "install",
          "--prefix",
          prefix,
          `${CLI}@${expected}`,
          "--registry",
          source.registry,
        ];
  const install = await run("npm", installArgs, { cwd: tmp, env });
  if (install.code !== 0) {
    fail(
      "install",
      `npm install exited ${install.code}: ${install.stderr.trim()}`,
    );
  }

  // 2. version
  const version = await donn(["--version"], "version");
  if (version.stdout.trim() !== expected) {
    fail(
      "version",
      `donn --version printed "${version.stdout.trim()}", expected "${expected}" (the workspace ${CLI} version)`,
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
    const res = node
      ? await run(node, [donnBin, ...args], { cwd: tmp, env })
      : await run(donnBin, args, { cwd: tmp, env });
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
