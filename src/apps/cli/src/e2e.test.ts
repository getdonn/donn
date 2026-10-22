import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "./session.js";

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

  it("sets up with init, switches, and passes doctor", () => {
    const steps = [
      ["init", "--personas", personas],
      ["init", "--extends", "team/e2e"],
      ["switch", "team/e2e"],
      ["doctor"],
    ];
    for (const args of steps) {
      const run = zzpersona(args);
      expect(run.status, `${args.join(" ")}: ${run.stdout}${run.stderr}`).toBe(
        0,
      );
    }
    const shown = zzpersona(["switch", "--json"]);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      persona: "team/e2e",
      source: "switch",
    });
    const dry = zzpersona(["claude", "--dry-run"]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("zzp-team--e2e");
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

// Opt-in, macOS: a throwaway item in the login keychain, resolved through the built binary's
// `doctor` (which resolves every secret the build needs; `claude --dry-run` resolves none).
describe.skipIf(process.env.ZZP_E2E !== "1" || process.platform !== "darwin")(
  "e2e: keychain secrets",
  () => {
    const SERVICE = "zzp-e2e";
    let dir: string;
    const security = (args: string[]) =>
      spawnSync("security", args, { encoding: "utf8" });

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "zzp-keychain-e2e-"));
      execFileSync("pnpm", ["build"], { cwd: PACKAGE, stdio: "ignore" });
      put(
        join(dir, "home/config.yaml"),
        `personas: ${join(dir, "personas")}\n`,
      );
      put(
        join(dir, "repo/.zzpersona/persona.yaml"),
        [
          "apiVersion: zzpersona/v0",
          "kind: Persona",
          "metadata: { name: keychain-e2e }",
          "mcp:",
          "  servers:",
          "    probe:",
          "      command: node",
          `      env: { TOKEN: "secret://keychain/${SERVICE}/token" }`,
          "",
        ].join("\n"),
      );
      mkdirSync(join(dir, "personas"), { recursive: true });
      security([
        "add-generic-password",
        "-s",
        SERVICE,
        "-a",
        "token",
        "-w",
        "zzp-e2e-value",
        "-U",
      ]);
    });

    afterAll(() => {
      security(["delete-generic-password", "-s", SERVICE, "-a", "token"]);
      rmSync(dir, { recursive: true, force: true });
    });

    it("resolves a keychain secret (macOS may ask once to allow access)", () => {
      const run = spawnSync(process.execPath, [BIN, "doctor", "--json"], {
        cwd: join(dir, "repo"),
        env: { ...process.env, ZZPERSONA_HOME: join(dir, "home") },
        encoding: "utf8",
        timeout: 120_000,
      });
      const checks = (
        JSON.parse(run.stdout) as {
          checks: { id: string; status: string; message: string }[];
        }
      ).checks;
      expect(checks.find((c) => c.id === "secrets")).toMatchObject({
        status: "ok",
        message: "1 secret(s) resolve",
      });
      expect(run.stdout).not.toContain("zzp-e2e-value");
    }, 180_000);
  },
);

// Opt-in: the built mod passes Claude Code's own checks, and `zzpersona mod install|uninstall`
// work against the real `claude`, in a throwaway config folder so the user's is never touched.
describe.skipIf(process.env.ZZP_E2E !== "1")("e2e: the Claude Code mod", () => {
  let dir: string;
  const MOD = join(PACKAGE, "../../packages/mod-claude-code/dist/mod");

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "zzp-mod-e2e-"));
    execFileSync("pnpm", ["build"], { cwd: PACKAGE, stdio: "ignore" });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("passes claude plugin validate", () => {
    const run = spawnSync("claude", ["plugin", "validate", MOD], {
      encoding: "utf8",
    });
    expect(run.stdout, run.stderr).toContain("Validation passed");
  });

  it("installs and uninstalls with the real claude", () => {
    const env = {
      ...process.env,
      ZZPERSONA_HOME: join(dir, "home"),
      CLAUDE_CONFIG_DIR: join(dir, "claude-config"),
    };
    const zzp = (args: string[]) =>
      spawnSync(process.execPath, [BIN, ...args], {
        cwd: dir,
        env,
        encoding: "utf8",
        timeout: 120_000,
      });
    const installed = zzp(["mod", "install"]);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    const list = spawnSync("claude", ["plugin", "list"], {
      env,
      encoding: "utf8",
    });
    expect(list.stdout).toContain("zzpersona@zzpersona");
    const removed = zzp(["mod", "uninstall"]);
    expect(removed.status, removed.stdout + removed.stderr).toBe(0);
  }, 180_000);
});

// Opt-in: the agents-md block reaches a real tool. Codex reads <repo>/AGENTS.md
// (spikes/agents-md); one `codex exec` call.
const hasCodex = spawnSync("codex", ["--version"]).status === 0;
describe.skipIf(process.env.ZZP_E2E !== "1" || !hasCodex)(
  "e2e: agents-md with Codex",
  () => {
    let dir: string;
    const repo = () => join(dir, "repo");
    const zzp = (args: string[]) =>
      spawnSync(process.execPath, [BIN, ...args], {
        cwd: repo(),
        env: { ...process.env, ZZPERSONA_HOME: join(dir, "home") },
        encoding: "utf8",
      });

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "zzp-agents-e2e-"));
      execFileSync("pnpm", ["build"], { cwd: PACKAGE, stdio: "ignore" });
      put(
        join(dir, "home/config.yaml"),
        `personas: ${join(dir, "personas")}\n`,
      );
      put(
        join(dir, "personas/org/base.yaml"),
        "apiVersion: zzpersona/v0\nkind: Persona\nmetadata: { name: base }\n",
      );
      put(
        join(repo(), ".zzpersona/persona.yaml"),
        [
          "apiVersion: zzpersona/v0",
          "kind: Persona",
          "metadata: { name: repo }",
          "extends: [org/base]",
          "instructions:",
          "  - id: codeword",
          '    inline: "When asked for the codeword, reply ZZ-AGENTS-CODEWORD."',
          "",
        ].join("\n"),
      );
      execFileSync("git", ["init", "-q"], { cwd: repo() });
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("writes the block, and Codex follows it", () => {
      const written = zzp(["write"]);
      expect(written.status, written.stdout + written.stderr).toBe(0);
      const codex = spawnSync(
        "codex",
        [
          "exec",
          "--skip-git-repo-check",
          "What is the codeword? Reply with just the codeword.",
        ],
        { cwd: repo(), encoding: "utf8", timeout: 240_000 },
      );
      expect(codex.stdout, codex.stderr).toContain("ZZ-AGENTS-CODEWORD");
      expect(zzp(["write", "--check"]).status).toBe(0);
    }, 300_000);
  },
);

// Opt-in: `zzpersona codex` against real Codex. One `codex exec` call checks the instruction, the
// MCP server and that its secret arrived by name (spikes/codex).
describe.skipIf(process.env.ZZP_E2E !== "1" || !hasCodex)(
  "e2e: zzpersona codex",
  () => {
    let dir: string;
    const repo = () => join(dir, "repo");

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "zzp-codex-e2e-"));
      execFileSync("pnpm", ["build"], { cwd: PACKAGE, stdio: "ignore" });
      put(
        join(dir, "home/config.yaml"),
        `personas: ${join(dir, "personas")}\n`,
      );
      put(
        join(dir, "personas/team/codex-e2e.yaml"),
        [
          "apiVersion: zzpersona/v0",
          "kind: Persona",
          "metadata: { name: codex-e2e }",
          "instructions:",
          "  - id: codeword",
          '    inline: "When asked for the codeword, reply ZZ-CODEX-CODEWORD."',
          "mcp:",
          "  servers:",
          "    zz-probe:",
          "      command: node",
          `      args: [${JSON.stringify(join(import.meta.dirname, "test/mcp-probe.mjs"))}]`,
          '      env: { ZZ_TOKEN: "secret://env/ZZ_E2E_TOKEN" }',
          "permissions:",
          '  allow: ["mcp__zz-probe__persona_ping"]',
          "",
        ].join("\n"),
      );
      mkdirSync(repo(), { recursive: true });
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("launches Codex with the persona's instructions, MCP server and secret", () => {
      const run = spawnSync(
        process.execPath,
        [
          BIN,
          "codex",
          "team/codex-e2e",
          "--",
          "exec",
          "--skip-git-repo-check",
          "Reply with the codeword, then call the persona_ping tool of the zz-probe MCP server and reply with exactly what it returned.",
        ],
        {
          cwd: repo(),
          env: {
            ...process.env,
            ZZPERSONA_HOME: join(dir, "home"),
            ZZ_E2E_TOKEN: "e2e-secret",
          },
          encoding: "utf8",
          timeout: 240_000,
        },
      );
      const out = run.stdout + run.stderr;
      // `codex exec` prints its transcript to stderr and only the last message to stdout.
      expect(out).toContain("ZZ-CODEX-CODEWORD");
      expect(out).toContain("ZZ-MCP-CODEWORD");
      expect(out).toContain("token-set-10");
      expect(out).not.toContain("e2e-secret");
    }, 300_000);
  },
);

// Opt-in: the daemon keeps a live session current from the built binary. The session is owned by a
// real child process so the registry sees it running.
describe.skipIf(process.env.ZZP_E2E !== "1")("e2e: the daemon", () => {
  let dir = "";
  let zzhome = "";
  let proj = "";
  let persona = "";
  let child: ReturnType<typeof spawn> | undefined;
  const zzp = (args: string[]) =>
    spawnSync(process.execPath, [BIN, ...args], {
      cwd: proj,
      env: { ...process.env, ZZPERSONA_HOME: zzhome },
      encoding: "utf8",
      timeout: 60_000,
    });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "zzp-daemon-e2e-"));
    zzhome = join(dir, "home");
    proj = join(dir, "project");
    persona = join(dir, "personas/team/d.yaml");
    execFileSync("pnpm", ["build"], { cwd: PACKAGE, stdio: "ignore" });
    put(join(zzhome, "config.yaml"), `personas: ${join(dir, "personas")}\n`);
    put(
      persona,
      "apiVersion: zzpersona/v0\nkind: Persona\nmetadata: { name: d }\ninstructions:\n  - id: a\n    inline: Codeword ONE.\n",
    );
    mkdirSync(proj, { recursive: true });
  });

  afterAll(() => {
    if (dir) zzp(["daemon", "stop"]);
    child?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refreshes a live session from the built binary", async () => {
    const compiled = zzp(["compile", "team/d", "--json"]);
    expect(compiled.status, compiled.stderr).toBe(0);
    const { buildDir } = JSON.parse(compiled.stdout) as { buildDir: string };
    child = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"], {
      stdio: "ignore",
    });
    const session = await createSession(
      zzhome,
      join(buildDir, "plugin"),
      {
        persona: "team/d",
        source: "argument",
        overlay: false,
        harness: "claude-code",
        startedAt: new Date().toISOString(),
        buildHash: "e2e-launch",
      },
      child.pid!,
    );
    const started = zzp(["daemon", "start"]);
    expect(started.status, started.stdout + started.stderr).toBe(0);

    writeFileSync(
      persona,
      `${readFileSync(persona, "utf8")}`.replace("ONE", "TWO"),
    );
    let state: string | undefined;
    for (let i = 0; i < 100 && state !== "refreshed"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const status = zzp(["status", "--json"]);
      state = (JSON.parse(status.stdout) as { sessions: { state: string }[] })
        .sessions[0]?.state;
    }
    expect(state).toBe("refreshed");
    expect(readFileSync(join(session, "live.json"), "utf8")).toContain("TWO");

    const stopped = zzp(["daemon", "stop"]);
    expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0);
    expect(existsSync(join(zzhome, "daemon/sock"))).toBe(false);
  }, 60_000);
});
