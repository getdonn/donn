import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Probe } from "@zzpersona/adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliVersion } from "./commands/daemon.js";
import { bundledMod } from "./commands/mod.js";
import { daemonPaths } from "./daemon/paths.js";
import { startDaemon, type Daemon } from "./daemon/server.js";
import { installedProbe, seed, zz, type Seeded } from "./test/seed.js";

let s: Seeded;
beforeEach(() => {
  s = seed();
});
afterEach(() => s.cleanup());

const SECRET = "doctor-secret-value";

/** Fixture 002's vault as an env provider, with its one secret set; personas tracked in git. */
function healthy() {
  const base = join(s.personas, "org/base.yaml");
  writeFileSync(
    base,
    readFileSync(base, "utf8").replace(
      "vault: { type: hashicorp-vault, address: https://vault.corp }",
      "vault: { type: env }",
    ),
  );
  mkdirSync(join(s.personas, ".git"));
  // The mod this CLI ships, as `zzpersona mod install` leaves it.
  const manifest = join(s.home, "mod/plugin/.claude-plugin/plugin.json");
  mkdirSync(join(manifest, ".."), { recursive: true });
  writeFileSync(
    manifest,
    JSON.stringify({ name: "zzpersona", version: bundledMod().version }),
  );
  // zzpersona on PATH, as the mod needs it.
  const bin = join(s.root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "zzpersona"), "#!/bin/sh\n");
  chmodSync(join(bin, "zzpersona"), 0o755);
  return { "payments/schema-token": SECRET, PATH: bin };
}

type Check = { id: string; status: string; message: string; fix?: string };
async function doctor(
  argv: string[],
  options: {
    cwd?: string;
    home?: string;
    env?: NodeJS.ProcessEnv;
    probe?: Probe;
  } = {},
) {
  const r = await zz(["doctor", "--json", ...argv], {
    cwd: options.cwd ?? s.repo,
    home: options.home ?? s.home,
    ...(options.env && { env: options.env }),
    ...(options.probe && { probe: options.probe }),
  });
  const checks = (JSON.parse(r.stdout) as { checks: Check[] }).checks;
  const status = Object.fromEntries(checks.map((c) => [c.id, c.status]));
  return { r, checks, status };
}

const IDS = [
  "home",
  "config",
  "personas",
  "state",
  "plugins",
  "persona",
  "resolve",
  "claude",
  "codex",
  "cli",
  "daemon",
  "mod",
  "secrets",
  "build",
];

describe("zzpersona doctor", () => {
  it("is all ok for a healthy setup", async () => {
    const { r, checks } = await doctor([], { env: healthy() });
    expect(checks.map((c) => c.id)).toEqual(IDS);
    expect(checks.filter((c) => c.status !== "ok")).toEqual([]);
    expect(r.code).toBe(0);
  });

  it("never prints a secret value", async () => {
    const env = healthy();
    const json = await doctor([], { env });
    expect(json.r.stdout).not.toContain(SECRET);
    const text = await zz(["doctor"], { cwd: s.repo, home: s.home, env });
    expect(text.stdout + text.stderr).not.toContain(SECRET);
    expect(text.stdout).toMatch(/^ok      config    /m);
  });

  it("warns, without failing, on a fresh machine", async () => {
    const { r, status } = await doctor([], {
      cwd: s.root,
      home: join(s.root, "fresh"),
    });
    expect(status).toEqual({
      home: "ok",
      config: "warn",
      personas: "skipped",
      state: "ok",
      plugins: "ok",
      persona: "warn",
      resolve: "skipped",
      claude: "ok",
      codex: "ok",
      cli: "warn",
      daemon: "ok",
      mod: "warn",
      secrets: "skipped",
      build: "ok",
    });
    expect(r.code).toBe(0);
  });

  it("errors on a broken config and skips what depends on it", async () => {
    writeFileSync(join(s.home, "config.yaml"), "personas: [oops\n");
    const { r, status } = await doctor([]);
    expect(status).toMatchObject({
      config: "error",
      personas: "skipped",
      persona: "skipped",
      resolve: "skipped",
      secrets: "skipped",
    });
    expect(r.code).toBe(1);
  });

  it("warns when the personas folder is not a git repository", async () => {
    const { checks } = await doctor([]);
    const personas = checks.find((c) => c.id === "personas")!;
    expect(personas.status).toBe("warn");
    expect(personas.fix).toContain("git init");
  });

  it("accepts a personas folder inside a larger git repository", async () => {
    mkdirSync(join(s.personas, "..", ".git"));
    const { checks } = await doctor([]);
    const personas = checks.find((c) => c.id === "personas")!;
    expect(personas.message).not.toContain("not a git repository");
  });

  it("finds orphaned switch entries and removes them with --fix", async () => {
    const env = healthy();
    writeFileSync(
      join(s.home, "state.json"),
      JSON.stringify({
        version: 1,
        projects: { [join(s.root, "gone/.zzpersona")]: "team/payments" },
      }),
    );
    expect((await doctor([], { env })).status.state).toBe("warn");
    expect((await doctor(["--fix"], { env })).status.state).toBe("ok");
    expect(
      JSON.parse(readFileSync(join(s.home, "state.json"), "utf8")).projects,
    ).toEqual({});
  });

  it("checks claude is installed and recent enough", async () => {
    const missing: Probe = {
      ...installedProbe,
      run: async () => ({ exitCode: 127, stdout: "", stderr: "" }),
    };
    expect((await doctor([], { probe: missing })).status.claude).toBe("error");
    const old: Probe = {
      ...installedProbe,
      run: async () => ({
        exitCode: 0,
        stdout: "2.1.100 (Claude Code)\n",
        stderr: "",
      }),
    };
    expect((await doctor([], { probe: old })).status.claude).toBe("warn");
  });

  it("checks codex: optional, and recent enough when installed", async () => {
    const codex = (stdout: string, exitCode = 0): Probe => ({
      ...installedProbe,
      run: async (command) =>
        command === "codex"
          ? { exitCode, stdout, stderr: "" }
          : installedProbe.run(command, []),
    });
    const absent = (await doctor([], { probe: codex("", 127) })).checks.find(
      (c) => c.id === "codex",
    )!;
    expect(absent).toMatchObject({
      status: "ok",
      message: "codex not installed (optional)",
    });
    const old = await doctor([], { probe: codex("codex-cli 0.100.0\n") });
    expect(old.status.codex).toBe("warn");
    const current = await doctor([], { probe: codex("codex-cli 0.163.0\n") });
    expect(current.checks.find((c) => c.id === "codex")!.message).toBe(
      "codex 0.163.0",
    );
  });

  it("names each secret that cannot be resolved", async () => {
    mkdirSync(join(s.personas, ".git"));
    const { r, checks } = await doctor([]);
    const secrets = checks.find((c) => c.id === "secrets")!;
    expect(secrets.status).toBe("error");
    expect(secrets.message).toContain("secret://vault/payments/schema-token");
    expect(r.code).toBe(1);
  });

  it("finds build leftovers and removes them with --fix", async () => {
    const env = healthy();
    const lock = join(s.home, "build/x/claude-code.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), "999999");
    expect((await doctor([], { env })).status.build).toBe("warn");
    expect((await doctor(["--fix"], { env })).status.build).toBe("ok");
    expect(existsSync(lock)).toBe(false);
  });
});

describe("doctor text output", () => {
  it("keeps a space between every status and its check name", async () => {
    const r = await zz(["doctor"], {
      cwd: s.root,
      home: join(s.root, "fresh"),
    });
    expect(r.stdout).toMatch(/^skipped personas  /m);
    expect(r.stdout).toMatch(/^ok      home      /m);
    expect(r.stdout).toMatch(/^ {8}fix: /m);
  });
});

describe("zzpersona doctor (daemon)", () => {
  const daemonCheck = async () => {
    const { checks } = await doctor([], { env: healthy() });
    return checks.find((c) => c.id === "daemon")!;
  };
  let daemon: Daemon | undefined;
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  it("is ok when no daemon runs", async () => {
    expect(await daemonCheck()).toMatchObject({
      status: "ok",
      message: "daemon not running (optional)",
    });
  });

  it("reports a running daemon", async () => {
    daemon = await startDaemon({
      home: s.home,
      env: {},
      version: cliVersion(),
    });
    expect(await daemonCheck()).toMatchObject({
      status: "ok",
      message: `daemon ${cliVersion()} running (pid ${process.pid})`,
    });
  });

  it("warns on a version mismatch", async () => {
    daemon = await startDaemon({ home: s.home, env: {}, version: "0.0.1" });
    expect(await daemonCheck()).toMatchObject({
      status: "warn",
      message: `daemon runs 0.0.1, CLI is ${cliVersion()}; zzpersona daemon stop && zzpersona daemon start`,
    });
  });

  it("warns on a stale socket or pid file", async () => {
    const paths = daemonPaths(s.home);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.sock, "");
    const check = await daemonCheck();
    expect(check.status).toBe("warn");
    expect(check.message).toContain("stale");
    expect(check.fix).toBe("zzpersona daemon start");
  });
});

describe("zzpersona doctor (spec 08 hardening)", () => {
  it("keeps a switch whose repo still exists, removing only gone repos", async () => {
    const env = healthy();
    mkdirSync(join(s.root, "branch-without-zzp"));
    const kept = join(s.root, "branch-without-zzp/.zzpersona");
    const gone = join(s.root, "gone/.zzpersona");
    writeFileSync(
      join(s.home, "state.json"),
      JSON.stringify({
        version: 1,
        projects: { [kept]: "team/payments", [gone]: "team/payments" },
      }),
    );
    const fixed = await doctor(["--fix"], { env });
    expect(fixed.status.state).toBe("warn");
    expect(
      JSON.parse(readFileSync(join(s.home, "state.json"), "utf8")).projects,
    ).toEqual({ [kept]: "team/payments" });
  });

  it("keeps a switch on an unmounted volume", async () => {
    const env = healthy();
    const unmounted = join(s.root, "Volumes/Ext/repo/.zzpersona");
    writeFileSync(
      join(s.home, "state.json"),
      JSON.stringify({
        version: 1,
        projects: { [unmounted]: "team/payments" },
      }),
    );
    const fixed = await doctor(["--fix"], { env });
    expect(fixed.status.state).toBe("warn");
    expect(
      JSON.parse(readFileSync(join(s.home, "state.json"), "utf8")).projects,
    ).toEqual({ [unmounted]: "team/payments" });
  });

  it("checks the fallback home when ZZPERSONA_HOME is empty", async () => {
    const fakeHome = join(s.root, "fake-user");
    mkdirSync(join(fakeHome, ".zzpersona"), { recursive: true });
    chmodSync(join(fakeHome, ".zzpersona"), 0o500);
    try {
      const { checks } = await doctor([], {
        env: { ZZPERSONA_HOME: "", HOME: fakeHome },
      });
      expect(checks.find((c) => c.id === "home")).toMatchObject({
        status: "error",
      });
    } finally {
      chmodSync(join(fakeHome, ".zzpersona"), 0o700);
    }
  });

  it("reports an old claude and a degraded mode together", async () => {
    const probe: Probe = {
      ...installedProbe,
      run: async () => ({
        exitCode: 0,
        stdout: "2.1.0 (Claude Code)\n",
        stderr: "",
      }),
      readFile: async (path) =>
        path.endsWith("managed-settings.json")
          ? '{"disableSideloadFlags": true}'
          : undefined,
    };
    const { checks } = await doctor([], { probe });
    const claude = checks.find((c) => c.id === "claude")!;
    expect(claude.status).toBe("warn");
    expect(claude.message).toContain("2.1.0");
    expect(claude.message).toContain("partial mode");
  });
});

describe("zzpersona doctor: plugins and keychain (spec 08)", () => {
  const configure = (lines: string) =>
    writeFileSync(
      join(s.home, "config.yaml"),
      `personas: ${s.personas}\n${lines}\n`,
    );

  it("lists each plugin with what it resolved to", async () => {
    const env = healthy();
    const adapter = join(import.meta.dirname, "test/plugins/class-adapter");
    configure(`adapters: [${adapter}]`);
    const { checks } = await doctor([], { env });
    const plugins = checks.find((c) => c.id === "plugins")!;
    expect(plugins.status).toBe("ok");
    expect(plugins.message).toContain(
      `${adapter} → ${join(adapter, "index.js")}`,
    );
    expect(plugins.message).toContain("fake");
  });

  it("is ok with no plugins, and an error naming the install command for a missing one", async () => {
    const env = healthy();
    expect((await doctor([], { env })).checks).toContainEqual(
      expect.objectContaining({ id: "plugins", status: "ok" }),
    );
    configure("secretProviders: [acme-missing]");
    const { checks } = await doctor([], { env });
    const plugins = checks.find((c) => c.id === "plugins")!;
    expect(plugins.status).toBe("error");
    expect(plugins.fix).toContain(
      `npm install --prefix ${join(s.home, "adapters")} acme-missing`,
    );
  });

  /** Fixture 002's vault as the keychain, with the item missing. */
  function keychainVault(platform: "darwin" | "linux"): Probe {
    const base = join(s.personas, "org/base.yaml");
    writeFileSync(
      base,
      readFileSync(base, "utf8").replace(
        "vault: { type: hashicorp-vault, address: https://vault.corp }",
        "vault: { type: keychain }",
      ),
    );
    return {
      ...installedProbe,
      platform,
      run: async (command) =>
        command === "claude"
          ? { exitCode: 0, stdout: "2.1.306 (Claude Code)\n", stderr: "" }
          : {
              exitCode: platform === "darwin" ? 44 : 1,
              stdout: "",
              stderr: "",
            },
    };
  }

  it("gives the command that stores a missing macOS keychain secret", async () => {
    const { checks } = await doctor([], { probe: keychainVault("darwin") });
    const secrets = checks.find((c) => c.id === "secrets")!;
    expect(secrets.status).toBe("error");
    expect(secrets.fix).toContain(
      "security add-generic-password -s payments -a schema-token -w",
    );
    expect(secrets.fix).toContain("Always Allow");
  });

  it("gives the secret-tool command on Linux", async () => {
    const { checks } = await doctor([], { probe: keychainVault("linux") });
    expect(checks.find((c) => c.id === "secrets")!.fix).toContain(
      "secret-tool store --label=payments service payments account schema-token",
    );
  });

  it("quotes service and account names in the commands it suggests", async () => {
    const probe = keychainVault("darwin");
    const team = join(s.personas, "team/payments.yaml");
    writeFileSync(
      team,
      readFileSync(team, "utf8").replace(
        "secret://vault/payments/schema-token",
        "secret://vault/My App/$(touch pwned)",
      ),
    );
    const { checks } = await doctor([], { probe });
    expect(checks.find((c) => c.id === "secrets")!.fix).toContain(
      "security add-generic-password -s 'My App' -a '$(touch pwned)' -w",
    );
  });

  it("removes orphaned session folders with --fix", async () => {
    const env = healthy();
    const orphan = join(s.home, "sessions/0123456789abcdef");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(
      join(orphan, "launched.json"),
      JSON.stringify({ persona: "x", source: "argument", pid: 999999 }),
    );
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(orphan, old, old);
    expect((await doctor([], { env })).status.build).toBe("warn");
    expect((await doctor(["--fix"], { env })).status.build).toBe("ok");
    expect(existsSync(orphan)).toBe(false);
  });
});

describe("zzpersona doctor (0.3.1)", () => {
  it("checks zzpersona is on PATH for the mod", async () => {
    const env = healthy();
    const ok = (await doctor([], { env })).checks.find((c) => c.id === "cli")!;
    expect(ok).toMatchObject({
      status: "ok",
      message: `zzpersona on PATH: ${join(env.PATH, "zzpersona")}`,
    });
    const missing = (
      await doctor([], { env: { ...env, PATH: join(s.root, "nowhere") } })
    ).checks.find((c) => c.id === "cli")!;
    expect(missing.status).toBe("warn");
    expect(missing.message).toContain("zzpersona is not on PATH");
    expect(missing.fix).toContain('pnpm add --global "link:');
  });

  it("names the claude binary it checked", async () => {
    const env = healthy();
    writeFileSync(join(env.PATH, "claude"), "#!/bin/sh\n");
    chmodSync(join(env.PATH, "claude"), 0o755);
    const claude = (await doctor([], { env })).checks.find(
      (c) => c.id === "claude",
    )!;
    expect(claude.message).toContain(join(env.PATH, "claude"));
  });

  it("says what --fix removed, and its hint covers session folders", async () => {
    const env = healthy();
    mkdirSync(join(s.home, "build/x/claude-code.lock"), { recursive: true });
    writeFileSync(join(s.home, "build/x/claude-code.lock/pid"), "999999");
    const warned = (await doctor([], { env })).checks.find(
      (c) => c.id === "build",
    )!;
    expect(warned.fix).toContain("session folders");
    const fixed = (await doctor(["--fix"], { env })).checks.find(
      (c) => c.id === "build",
    )!;
    expect(fixed.message).toBe(
      "removed 1 stale lock(s), 0 orphaned version(s), 0 temporary link(s), 0 orphaned session folder(s)",
    );
  });
});

describe("zzpersona doctor and AGENTS.md", () => {
  it("notes when Claude Code also reads the generated AGENTS.md", async () => {
    const env = healthy();
    writeFileSync(
      join(s.repo, "AGENTS.md"),
      "<!-- zzpersona:begin — generated; edit the source, not this block -->\nx\n<!-- zzpersona:end -->\n",
    );
    const persona = (await doctor([], { env })).checks.find(
      (c) => c.id === "persona",
    )!;
    expect(persona.message).toContain(
      "AGENTS.md also carries it for Claude Code",
    );
    writeFileSync(join(s.repo, "CLAUDE.md"), "# Claude\n");
    const again = (await doctor([], { env })).checks.find(
      (c) => c.id === "persona",
    )!;
    expect(again.message).not.toContain("AGENTS.md");
  });
});
