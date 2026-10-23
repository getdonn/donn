import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CompileOutput, Detection } from "@zzpersona/adapter-sdk";
import type { ResolvedPersona } from "@zzpersona/spec";
import { afterAll, describe, expect, it } from "vitest";
import adapter from "./index.js";

// Opt-in (ZZP_E2E=1): compile a persona, write the build to disk, and launch the real
// `claude -p` with the plan's flags, as spikes/claude-code did by hand. One Haiku call.

const PROBE_SERVER = join(
  import.meta.dirname,
  "../../../../../spikes/claude-code/build/mcp-server.mjs",
);
const work = mkdtempSync(join(tmpdir(), "zzp-e2e-"));
const root = join(work, "personas");
const buildDir = join(work, "build");
const project = join(work, "project");

function writePersonasRoot() {
  const skill = join(root, "team/skills/zz-probe-skill");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: zz-probe-skill\ndescription: E2E probe skill. Use only when asked about the zz probe skill.\n---\nReply with ZZ-SKILL-CODEWORD.\n",
  );
  mkdirSync(join(root, "team/hooks"), { recursive: true });
  const hook = join(root, "team/hooks/start.sh");
  writeFileSync(
    hook,
    "#!/bin/sh\necho 'Persona hook context: the hook codeword is ZZ-HOOK-CODEWORD.'\n",
  );
  chmodSync(hook, 0o755);
  mkdirSync(project, { recursive: true });
}

/** Test-only stand-in for the CLI's plan executor (next spec): write files, perform copies. */
function materialize(output: CompileOutput) {
  for (const [path, file] of Object.entries(output.files)) {
    const target = join(buildDir, path);
    mkdirSync(dirname(target), { recursive: true });
    if ("content" in file) writeFileSync(target, file.content);
    else cpSync(join(root, file.copyFrom), target, { recursive: true });
    if (file.mode !== undefined) chmodSync(target, file.mode);
  }
}

const ir: ResolvedPersona = {
  irVersion: 0,
  layers: ["team/e2e"],
  metadata: { name: "e2e", labels: {} },
  instructions: [
    { id: "probe", inline: "The persona codeword is ZZ-PROMPT-CODEWORD." },
  ],
  skills: [{ name: "zz-probe-skill", source: "team/skills/zz-probe-skill" }],
  mcp: {
    servers: {
      "zz-probe": {
        command: "node",
        args: [PROBE_SERVER],
        env: { PROBE_TOKEN: "secret://test/probe-token" },
      },
    },
  },
  permissions: { allow: ["mcp__zz-probe__persona_ping"], deny: [], ask: [] },
  hooks: { "session-start": [{ id: "start", run: "team/hooks/start.sh" }] },
  knowledge: [],
  secrets: { providers: {} },
  locks: [],
  targets: {},
  policy: {},
};

const PROMPT = `Configuration test. Report:
1. the persona codeword from your system prompt;
2. the hook codeword from any session-start context;
3. the names of your skills that contain "zz-probe";
4. call the persona_ping tool and report its text.`;

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(process.env.ZZP_E2E !== "1")("e2e: real claude", () => {
  it("delivers instructions, hook context, a skill and an MCP tool", () => {
    writePersonasRoot();
    const detection: Detection = { installed: true, facts: {} };
    const output = adapter.compile({
      personaId: "team/e2e",
      ir,
      detection,
      texts: {},
    });
    materialize(output);
    const [launch] = adapter.activate({
      ir,
      output,
      buildDir,
      detection,
      cwd: project,
      passthrough: [
        "-p",
        "--model",
        "haiku",
        "--output-format",
        "json",
        PROMPT,
      ],
    }).steps;
    if (launch?.kind !== "launch") throw new Error("expected a launch step");

    const secrets = Object.fromEntries(
      Object.keys(output.secretEnv).map((name) => [name, "resolved-by-test"]),
    );
    const run = spawnSync(launch.command, launch.args, {
      cwd: launch.cwd,
      env: { ...process.env, ...launch.env, ...secrets },
      encoding: "utf8",
      timeout: 240_000,
    });
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
