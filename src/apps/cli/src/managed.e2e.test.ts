import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Opt-in (DONN_E2E_MANAGED=1; needs Docker and network): a managed bundle built on the host,
// installed as root in a Linux container, and read by a real Claude Code. The container is the
// only thing that touches a system folder; the host's /etc, ~/.claude and ~/.donn are never
// read or written. See docs/planning/21-managed-settings.md, section 5.

const ENABLED = process.env.DONN_E2E_MANAGED === "1";
const PACKAGE = join(import.meta.dirname, "..");
const REPO = join(PACKAGE, "../../..");
const BIN = join(PACKAGE, "dist/bin.js");
/** The Claude Code release this was verified against (npm view @anthropic-ai/claude-code). */
const CLAUDE_CODE = "2.1.309";
const IMAGE = "node:26-slim";
const NAME = `donn-managed-e2e-${Math.random().toString(36).slice(2, 10)}`;

const ORG = `apiVersion: donn/v0
kind: Persona
metadata: { name: acme }
mcp:
  servers:
    corp-docs:
      url: https://docs.corp.invalid/mcp
permissions:
  deny: ["Bash(rm -rf:*)"]
hooks:
  pre-tool-use:
    - id: guard
      run: ./hooks/guard.sh
locks:
  - mcp.servers.corp-docs
  - permissions.deny
  - hooks.pre-tool-use[guard]
`;

let work = "";
let bundle = "";

function docker(args: string[], timeout = 120_000) {
  return spawnSync("docker", args, { encoding: "utf8", timeout });
}

/** Run a command in the container as root with HOME=/root. */
function inside(command: string, timeout = 120_000) {
  return docker(
    [
      "exec",
      "-e",
      "HOME=/root",
      "-e",
      "DONN_HOME=/tmp/donn-home",
      NAME,
      "sh",
      "-c",
      command,
    ],
    timeout,
  );
}

const show = (r: ReturnType<typeof spawnSync>) =>
  `exit ${r.status}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;

describe.skipIf(!ENABLED)("managed policy in a real Claude Code", () => {
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "donn-managed-e2e-"));
    const personas = join(work, "personas");
    const home = join(work, "zzhome");
    bundle = join(work, "bundle");
    const put = (path: string, text: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    };
    put(join(personas, "org/acme.yaml"), ORG);
    put(join(personas, "org/hooks/guard.sh"), "#!/bin/sh\nexit 0\n");
    put(join(home, "config.yaml"), `personas: ${personas}\n`);
    chmodSync(join(personas, "org/hooks/guard.sh"), 0o755);
    const built = spawnSync(
      process.execPath,
      [
        BIN,
        "managed",
        "build",
        "--layer",
        "org/acme",
        "--os",
        "linux",
        "--out",
        bundle,
      ],
      {
        cwd: work,
        encoding: "utf8",
        env: { ...process.env, DONN_HOME: home, HOME: work },
      },
    );
    expect(built.status, show(built)).toBe(0);

    // The built workspace is mounted read-only at the same path, so its node_modules symlinks
    // resolve; the bundle is mounted read-only too.
    const run = docker(
      [
        "run",
        "-d",
        "--name",
        NAME,
        "-v",
        `${REPO}:${REPO}:ro`,
        "-v",
        `${bundle}:/bundle:ro`,
        IMAGE,
        "sleep",
        "infinity",
      ],
      600_000,
    );
    expect(run.status, show(run)).toBe(0);
    const install = inside(
      `npm i -g @anthropic-ai/claude-code@${CLAUDE_CODE} 2>&1 | tail -5`,
      600_000,
    );
    expect(install.status, show(install)).toBe(0);
  }, 900_000);

  afterAll(() => {
    // Only the container this test started, by its own random name.
    docker(["rm", "-f", NAME]);
    if (work !== "") rmSync(work, { recursive: true, force: true });
  });

  it("installs the bundle as root and Claude Code reads it", () => {
    const version = inside("claude --version");
    expect(version.stdout, show(version)).toContain(CLAUDE_CODE);

    const install = inside(`node ${BIN} managed install /bundle --yes`);
    expect(install.status, show(install)).toBe(0);

    const files = inside("find /etc/claude-code -type f | sort");
    console.log(`installed files:\n${files.stdout}`);
    for (const path of [
      "/etc/claude-code/managed-settings.d/50-donn.json",
      "/etc/claude-code/donn/manifest.json",
    ]) {
      expect(files.stdout, show(files)).toContain(path);
    }
    expect(files.stdout).toMatch(/\/etc\/claude-code\/donn\/hooks\/\S*guard/);

    const check = inside(`node ${BIN} managed check`);
    expect(check.stdout, show(check)).toContain("current");

    const settings = inside(
      "cat /etc/claude-code/managed-settings.d/50-donn.json",
    );
    const parsed = JSON.parse(settings.stdout) as {
      managedMcpServers?: Record<string, unknown>;
    };
    expect(Object.keys(parsed.managedMcpServers ?? {})).toEqual(["corp-docs"]);

    const mcp = inside("cd /tmp && claude mcp list 2>&1", 180_000);
    console.log(`claude mcp list:\n${mcp.stdout}`);
    expect(mcp.stdout, show(mcp)).toContain("corp-docs");

    const doctor = inside("cd /tmp && claude doctor 2>&1 </dev/null", 180_000);
    console.log(`claude doctor (exit ${doctor.status}):\n${doctor.stdout}`);
    expect(doctor.stdout).toContain("No installation issues found");
    expect(doctor.stdout).not.toMatch(/invalid.*managed|managed.*invalid/i);

    // Uninstall returns the machine to how it was: no files and no empty folders left behind.
    const uninstall = inside(`node ${BIN} managed uninstall --yes`);
    expect(uninstall.status, show(uninstall)).toBe(0);
    const gone = inside(
      "test -e /etc/claude-code && echo present || echo absent",
    );
    expect(gone.stdout.trim(), show(gone)).toBe("absent");
  }, 600_000);
});
