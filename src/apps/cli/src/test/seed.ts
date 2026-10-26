import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Probe } from "@getdonn/adapter-sdk";
import { createCli } from "../cli.js";
import type { ManagedEnv } from "../managed/env.js";

// Test-only: resolver fixture 002 laid out across the three mounts, plus the files it
// references, and an in-process way to run the CLI against it.

const FIXTURE = join(
  import.meta.dirname,
  "../../../../packages/resolver/fixtures/002-full-stack/personas",
);

export interface Seeded {
  root: string;
  home: string;
  personas: string;
  repo: string;
  cleanup(): void;
}

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function seed(): Seeded {
  const root = mkdtempSync(join(tmpdir(), "donn-cli-"));
  const home = join(root, "home");
  const personas = join(root, "personas");
  const repo = join(root, "repo");
  for (const layer of ["org", "area", "team"]) {
    cpSync(join(FIXTURE, layer), join(personas, layer), { recursive: true });
  }
  cpSync(
    join(FIXTURE, "project/checkout-api.yaml"),
    join(repo, ".donn/persona.yaml"),
  );
  cpSync(join(FIXTURE, "user/overrides.yaml"), join(home, "overrides.yaml"));
  put(join(home, "config.yaml"), `personas: ${personas}\n`);
  put(join(personas, "org/instructions/conduct.md"), "Review kindly.");
  put(join(personas, "org/hooks/block-prod-db.sh"), "#!/bin/sh\nexit 0\n");
  put(
    join(personas, "team/skills/run-payment-sim/SKILL.md"),
    "---\nname: run-payment-sim\ndescription: Runs the payment simulator.\n---\nRun pnpm sim.\n",
  );
  put(
    join(repo, ".donn/instructions/checkout-overview.md"),
    "Checkout overview text.",
  );
  put(join(repo, ".donn/hooks/format.sh"), "#!/bin/sh\nexit 0\n");
  return {
    root,
    home,
    personas,
    repo,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export const installedProbe: Probe = {
  platform: process.platform,
  run: async () => ({
    exitCode: 0,
    stdout: "2.1.306 (Claude Code)\n",
    stderr: "",
  }),
  readFile: async () => undefined,
  listDir: async () => undefined,
};

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The user's home folder for tests that do not set one: it does not exist. */
export const NO_USER_HOME = join(tmpdir(), "donn-no-user-home");

/** Where tests that do not exercise managed settings keep `managed install|check` pointed. */
export const NO_MANAGED_ROOT = join(
  tmpdir(),
  "donn-no-managed-root",
  "ClaudeCode",
);

/**
 * The `CliIo.managed` seam for tests: never the real system folder, MDM profile, registry or
 * ~/.claude (`doctor` and `status` read them). The root does not exist, so nothing is installed.
 * Every CliIo a test builds by hand must carry it.
 */
export function safeManaged(): Partial<ManagedEnv> {
  return {
    root: NO_MANAGED_ROOT,
    isAdmin: () => false,
    strict: () => false,
    mdmPolicy: async () => undefined,
    remoteSettingsFile: join(dirname(NO_MANAGED_ROOT), "remote.json"),
    confirm: async () => undefined,
  };
}

/** Run `donn <argv>` in-process. */
export async function zz(
  argv: string[],
  options: {
    cwd: string;
    home?: string;
    env?: NodeJS.ProcessEnv;
    probe?: Probe;
    /** Managed-settings paths and readers; defaults point nowhere real (see below). */
    managed?: Partial<ManagedEnv>;
  } & Partial<
    Pick<
      Parameters<typeof createCli>[0],
      | "runPlan"
      | "now"
      | "spawnDaemon"
      | "service"
      | "runInput"
      | "stdin"
      | "readSecret"
      | "secretProbe"
      | "openBrowser"
      | "sleep"
      | "signal"
      | "passwdHome"
      | "spawn"
      | "fetch"
      | "ask"
    >
  >,
): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const cli = createCli({
    env: {
      // Launches must not start real daemons; a test that wants auto-start sets this to "".
      DONN_NO_DAEMON: "1",
      // Never the developer's own home: doctor looks for an old home under it.
      HOME: NO_USER_HOME,
      ...(options.home && { DONN_HOME: options.home }),
      ...options.env,
    },
    cwd: options.cwd,
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    probe: options.probe ?? installedProbe,
    managed: { ...safeManaged(), ...options.managed },
    ...(options.runPlan && { runPlan: options.runPlan }),
    ...(options.now && { now: options.now }),
    ...(options.spawnDaemon && { spawnDaemon: options.spawnDaemon }),
    ...(options.service && { service: options.service }),
    ...(options.runInput && { runInput: options.runInput }),
    ...(options.stdin && { stdin: options.stdin }),
    ...(options.readSecret && { readSecret: options.readSecret }),
    ...(options.secretProbe && { secretProbe: options.secretProbe }),
    ...(options.openBrowser && { openBrowser: options.openBrowser }),
    ...(options.sleep && { sleep: options.sleep }),
    ...(options.signal && { signal: options.signal }),
    ...(options.spawn && { spawn: options.spawn }),
    ...(options.fetch && { fetch: options.fetch }),
    // No terminal unless a test gives one: never the developer's own.
    ask: options.ask ?? (async () => undefined),
    // No test reaches the real passwd entry unless it opts in.
    passwdHome: options.passwdHome ?? (() => NO_USER_HOME),
  });
  const code = await cli.run(argv);
  return { code, stdout, stderr };
}

/** A CliIo whose output is discarded, for calling CLI internals directly. */
export function quietIo(options: {
  cwd: string;
  home: string;
  env?: NodeJS.ProcessEnv;
}) {
  return {
    env: { DONN_HOME: options.home, ...options.env },
    cwd: options.cwd,
    stdout: { write: () => true },
    stderr: { write: () => true },
    probe: installedProbe,
    managed: safeManaged(),
    passwdHome: () => NO_USER_HOME,
  };
}
