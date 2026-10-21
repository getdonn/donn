import { execFileSync, spawnSync } from "node:child_process";
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

// Opt-in (ZZP_E2E=1): the built `zzpersona` binary, against real `claude`, from personas on
// disk. One Haiku call. The Phase 1 core loop, end to end.

const PACKAGE = join(import.meta.dirname, "..");
const BIN = join(PACKAGE, "dist/bin.js");
const PROBE_SERVER = join(
  PACKAGE,
  "../../../spikes/claude-code/build/mcp-server.mjs",
);

// Created in beforeAll, so a skipped run leaves nothing behind.
let work = "";
let home = "";
let personas = "";
let project = "";

function put(path: string, content: string, mode?: number) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

const PROMPT = `Configuration test. Report:
1. the persona codeword from your system prompt;
2. the hook codeword from any session-start context;
3. the names of your skills that contain "zz-probe";
4. call the persona_ping tool and report its text.`;

const zzpersona = (args: string[]) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd: project,
    env: { ...process.env, ZZPERSONA_HOME: home, ZZ_E2E_TOKEN: "e2e-token" },
    encoding: "utf8",
    timeout: 240_000,
  });

describe.skipIf(process.env.ZZP_E2E !== "1")("e2e: zzpersona claude", () => {
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "zzp-cli-e2e-"));
    home = join(work, "home");
    personas = join(work, "personas");
    project = join(work, "project");
    execFileSync("pnpm", ["build"], { cwd: PACKAGE, stdio: "ignore" });
    put(join(home, "config.yaml"), `personas: ${personas}\n`);
    put(
      join(personas, "team/e2e.yaml"),
      [
        "apiVersion: zzpersona/v0",
        "kind: Persona",
        "metadata: { name: e2e }",
        "instructions:",
        "  - id: probe",
        "    inline: The persona codeword is ZZ-PROMPT-CODEWORD.",
        "skills:",
        "  include: [./skills/zz-probe-skill]",
        "mcp:",
        "  servers:",
        "    zz-probe:",
        "      command: node",
        `      args: [${JSON.stringify(PROBE_SERVER)}]`,
        '      env: { PROBE_TOKEN: "secret://env/ZZ_E2E_TOKEN" }',
        "permissions:",
        '  allow: ["mcp__zz-probe__persona_ping"]',
        "hooks:",
        "  session-start:",
        "    - id: start",
        "      run: ./hooks/start.sh",
        "",
      ].join("\n"),
    );
    put(
      join(personas, "team/skills/zz-probe-skill/SKILL.md"),
      "---\nname: zz-probe-skill\ndescription: E2E probe skill. Use only when asked about the zz probe skill.\n---\nReply with ZZ-SKILL-CODEWORD.\n",
    );
    put(
      join(personas, "team/hooks/start.sh"),
      "#!/bin/sh\necho 'Persona hook context: the hook codeword is ZZ-HOOK-CODEWORD.'\n",
      0o755,
    );
    mkdirSync(project, { recursive: true });
  });

  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("dry-runs", () => {
    const run = zzpersona(["claude", "team/e2e", "--dry-run"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("launch claude");
  });

  it("launches claude with the persona", () => {
    const run = zzpersona([
      "claude",
      "team/e2e",
      "--",
      "-p",
      "--model",
      "haiku",
      "--output-format",
      "json",
      PROMPT,
    ]);
    expect(run.status, run.stderr).toBe(0);
    const result = (JSON.parse(run.stdout) as { result: string }).result;
    for (const codeword of [
      "ZZ-PROMPT-CODEWORD",
      "ZZ-HOOK-CODEWORD",
      "zz-probe-skill",
      "ZZ-MCP-CODEWORD",
    ]) {
      expect(result, codeword).toContain(codeword);
    }
  }, 300_000);
});
