import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { cp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Platform, Probe } from "@getdonn/adapter-sdk";
import { isAlive, nodeProbe } from "@getdonn/executor";
import { findProject } from "@getdonn/store-local";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliIo } from "./cli.js";
import { cliVersion } from "./commands/daemon.js";
import { startDaemon, type Daemon } from "./daemon/server.js";
import { serviceManager } from "./daemon/service.js";
import type { ManagedEnv } from "./managed/env.js";
import { planMigration, runMigration } from "./migrate/plan.js";
import { moveHome, rewriteApiVersion } from "./migrate/steps.js";
import { projectKey } from "./state.js";
import { installedProbe, safeManaged, seed, zz } from "./test/seed.js";

// donn migrate: an old zzpersona install moved to donn (spec 22 §3). Every test runs against a
// temp HOME; launchctl, systemctl, claude and the keychain are fakes that record each call, and
// the managed root is a temp folder. Nothing here touches the real home, keychain or services.

const STEPS = [
  "service-stop",
  "mod-remove",
  "move-home",
  "drop-state",
  "api-version",
  "state",
  "keychain",
  "mod-install",
  "service-start",
];
const REGISTRY = "http://127.0.0.1:9";
const ACCOUNT = `${REGISTRY}/`;
const OLD_TOKEN = "zzp_old-token-for-migrate-3c9e";
const uid = process.getuid!();

let root: string;
let daemons: Daemon[];
let children: ChildProcess[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "donn-migrate-"));
  daemons = [];
  children = [];
});
afterEach(async () => {
  await Promise.all(daemons.map((d) => d.close()));
  for (const child of children)
    if (child.pid && isAlive(child.pid)) child.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

const user = () => join(root, "user");
const oldHome = () => join(user(), ".zzpersona");
const newHome = () => join(user(), ".donn");
const oldPlist = () =>
  join(user(), "Library/LaunchAgents/zzpersona.daemon.plist");
const newPlist = () =>
  join(user(), "Library/LaunchAgents/dev.getdonn.daemon.plist");
const read = (path: string) => readFileSync(path, "utf8");

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const ACME = `# Org layer.
apiVersion: zzpersona/v0
kind: Persona
metadata:
  name: acme
instructions:
  - id: acme-note
    inline: Be kind.
`;
const ME = `# Your personal persona. \`zzpersona claude\` sessions pick up changes.
apiVersion: zzpersona/v0
kind: Persona
metadata:
  name: me
extends:
  - org/acme
instructions:
  - id: style
    inline: Be concise; the text zzpersona/v0 stays as it is.
`;
const OVERRIDES = "apiVersion: zzpersona/v0\nkind: PersonaOverlay\n";
/** state.json with one project switch, keyed by the project's folder (old or new name). */
const stateText = (folder: ".zzpersona" | ".donn") =>
  `${JSON.stringify({ version: 1, default: "user/me", projects: { [join(root, "gone", folder)]: "user/me" } }, null, 2)}\n`;
const migrated = (text: string) =>
  text.replace(/^apiVersion: zzpersona\/v0$/m, "apiVersion: donn/v0");

interface Machine {
  probe: Probe;
  runInput: NonNullable<CliIo["runInput"]>;
  /** Every launchctl, systemctl, claude plugin and keychain call, in order. */
  log: string[];
  keychain: Map<string, string>;
  loaded: Set<string>;
  plugins: Set<string>;
  marketplaces: Map<string, string>;
  /** When set, every keychain call fails with this message (a locked keychain). */
  keychainError?: string;
  /** When set, `claude plugin uninstall` exits 1 with this and keeps the plugin. */
  uninstallError?: string;
  /** claude is not on PATH: every call exits 127. */
  noClaude?: boolean;
  /** What `claude plugin list --json` answers instead of the plugins. */
  listReply?: { exitCode: number; stdout: string; stderr: string };
  /** What the user's shell (/bin/zsh) answers to `type claude`. */
  shellSays?: string;
}

/**
 * A fake machine: launchctl/systemctl keep a set of loaded jobs (loading the new one starts an
 * in-process daemon for `serviceHome`, as launchd would), claude keeps its plugins and
 * marketplaces, and `security` keeps a keychain. git is real (temp repos only).
 */
function machine(
  platform: Platform = "darwin",
  serviceHome: () => string = newHome,
): Machine {
  const log: string[] = [];
  const keychain = new Map<string, string>();
  const loaded = new Set<string>();
  const plugins = new Set<string>();
  const marketplaces = new Map<string, string>();
  const git = nodeProbe();
  const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
  const no = (exitCode: number, stderr = "") => ({
    exitCode,
    stdout: "",
    stderr,
  });
  const serviceDaemon = async () => {
    daemons.push(
      await startDaemon({
        home: serviceHome(),
        env: { DONN_SERVICE: "1" },
        version: cliVersion(),
      }),
    );
  };
  const m: Machine = {
    log,
    keychain,
    loaded,
    plugins,
    marketplaces,
    probe: undefined as unknown as Probe,
    runInput: undefined as unknown as Machine["runInput"],
  };
  m.probe = {
    platform,
    readFile: installedProbe.readFile,
    listDir: installedProbe.listDir,
    run: async (command, args) => {
      if (command === "git") return git.run(command, args);
      if (command === "launchctl") {
        log.push([command, ...args].join(" "));
        const label =
          args[0] === "bootstrap"
            ? basename(args[2]!, ".plist")
            : args[1]!.split("/").pop()!;
        if (args[0] === "bootout") {
          loaded.delete(label);
          return ok();
        }
        if (args[0] === "print") return loaded.has(label) ? ok() : no(113);
        if (args[0] === "bootstrap") {
          loaded.add(label);
          if (label === "dev.getdonn.daemon") await serviceDaemon();
        }
        return ok();
      }
      if (command === "systemctl") {
        log.push([command, ...args].join(" "));
        const [, verb] = args;
        const unit = args.at(-1)!;
        if (verb === "disable") loaded.delete(unit);
        if (verb === "is-enabled") return loaded.has(unit) ? ok() : no(1);
        if (verb === "enable") {
          loaded.add(unit);
          if (unit === "donn-daemon.service") await serviceDaemon();
        }
        return ok();
      }
      if (command === "/bin/zsh" && m.shellSays !== undefined)
        return ok(m.shellSays);
      if (command === "claude" && m.noClaude) return no(127);
      if (command === "claude" && args[0] === "plugin") {
        log.push([command, ...args].join(" "));
        const [, a, b, c] = args;
        if (a === "list")
          return (
            m.listReply ??
            ok(JSON.stringify([...plugins].map((id) => ({ id }))))
          );
        if (a === "marketplace" && b === "list")
          return ok(
            JSON.stringify(
              [...marketplaces].map(([name, path]) => ({ name, path })),
            ),
          );
        if (a === "uninstall") {
          if (m.uninstallError) return no(1, m.uninstallError);
          return plugins.delete(b!)
            ? ok()
            : no(1, `Plugin "${b}" is not installed\n`);
        }
        if (a === "install") {
          plugins.add(b!);
          return ok();
        }
        if (a === "marketplace" && b === "remove")
          return marketplaces.delete(c!)
            ? ok()
            : no(1, `Marketplace '${c}' not found\n`);
        if (a === "marketplace" && b === "add") {
          const { name } = JSON.parse(
            read(join(c!, ".claude-plugin/marketplace.json")),
          ) as { name: string };
          marketplaces.set(name, c!);
          return ok();
        }
        return no(1, "unexpected claude call");
      }
      return installedProbe.run(command, args);
    },
  };
  m.runInput = async (command, args, input) => {
    if (command !== "security") return no(127);
    if (m.keychainError) {
      log.push(`security failed ${args[0]}`);
      return no(51, m.keychainError);
    }
    if (args[0] === "-i") {
      const [service, account, value] = [...input!.matchAll(/"([^"]*)"/g)].map(
        (match) => match[1]!,
      );
      log.push(`security add ${service} ${account}`);
      keychain.set(`${service} ${account}`, value!);
      return ok();
    }
    const flag = (name: string) => args[args.indexOf(name) + 1]!;
    const key = `${flag("-s")} ${flag("-a")}`;
    if (args[0] === "find-generic-password") {
      // With -w the secret is read (and could prompt); without, only the attributes.
      const secret = args.includes("-w");
      log.push(`security ${secret ? "read" : "find"} ${key}`);
      const value = keychain.get(key);
      if (value === undefined) return no(44, "could not be found");
      return ok(secret ? `${value}\n` : 'keychain: "login.keychain-db"\n');
    }
    if (args[0] === "delete-generic-password") {
      log.push(`security delete ${key}`);
      return keychain.delete(key) ? ok() : no(44, "could not be found");
    }
    return no(1, "unexpected security call");
  };
  return m;
}

/** The calls that change something: not launchctl print, keychain lookups or claude lists. */
const changes = (m: Machine) =>
  m.log.filter(
    (call) =>
      !call.startsWith("launchctl print") &&
      !call.startsWith("security find") &&
      !call.startsWith("security read") &&
      !/^claude plugin (marketplace )?list/.test(call) &&
      !call.includes(" is-enabled "),
  );

/** A folder holding an executable `donn`, for PATH (the service and mod run it). */
function bin(): string {
  const dir = join(root, "bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "donn"), "#!/bin/sh\n");
  chmodSync(join(dir, "donn"), 0o755);
  return dir;
}

/** What the developer's Mac has: a home, a loaded service, a keychain token and the mod. */
function oldInstall(m: Machine) {
  const old = oldHome();
  put(
    join(old, "config.yaml"),
    `personas: ~/.zzpersona/layers\nregistry:\n  url: ${REGISTRY}\n`,
  );
  put(join(old, "layers/org/acme.yaml"), ACME);
  put(join(old, "personas/me.yaml"), ME);
  put(join(old, "overrides.yaml"), OVERRIDES);
  put(join(old, "state.json"), stateText(".zzpersona"));
  put(join(old, "build/claude-code/user-me/settings.json"), "{}\n");
  put(join(old, "sessions/s1/session.json"), "{}\n");
  for (const file of ["sock", "pid", "token", "daemon.lock", "where"])
    put(join(old, "daemon", file), "");
  put(join(old, "daemon/daemon.log"), "old log\n");
  put(
    join(old, "mod/.claude-plugin/marketplace.json"),
    `${JSON.stringify({ name: "zzpersona", owner: { name: "zzpersona" }, plugins: [{ name: "zzpersona", source: "./plugin" }] }, null, 2)}\n`,
  );
  put(
    join(old, "mod/plugin/.claude-plugin/plugin.json"),
    `${JSON.stringify({ name: "zzpersona", version: "0.12.0" })}\n`,
  );
  put(oldPlist(), "<plist><string>zzpersona.daemon</string></plist>\n");
  m.loaded.add("zzpersona.daemon");
  m.keychain.set(`zzpersona-registry ${ACCOUNT}`, OLD_TOKEN);
  m.plugins.add("zzpersona@zzpersona");
  m.marketplaces.set("zzpersona", join(old, "mod"));
}

type ZzOptions = Parameters<typeof zz>[1];

/** `donn <argv>` as this machine's user: HOME is the temp user, PATH holds a fake donn. */
function donn(
  m: Machine,
  argv: string[],
  extra: Partial<ZzOptions> & { env?: NodeJS.ProcessEnv } = {},
) {
  const { env, managed, ...rest } = extra;
  return zz(argv, {
    cwd: root,
    env: { HOME: user(), PATH: `${bin()}:/usr/bin:/bin`, ...env },
    probe: m.probe,
    runInput: m.runInput,
    managed: { ...managed },
    ...rest,
  });
}

/** The same user's CliIo, for calling planMigration and runMigration directly. */
function ioFor(m: Machine, managed: Partial<ManagedEnv> = {}): CliIo {
  return {
    env: {
      DONN_NO_DAEMON: "1",
      HOME: user(),
      PATH: `${bin()}:/usr/bin:/bin`,
    },
    cwd: root,
    stdout: { write: () => true },
    stderr: { write: () => true },
    probe: m.probe,
    runInput: m.runInput,
    managed: { ...safeManaged(), ...managed },
  };
}

function expectMigrated(m: Machine) {
  const home = newHome();
  expect(existsSync(oldHome())).toBe(false);
  expect(read(join(home, "config.yaml"))).toBe(
    `personas: ~/.donn/layers\nregistry:\n  url: ${REGISTRY}\n`,
  );
  expect(read(join(home, "layers/org/acme.yaml"))).toBe(migrated(ACME));
  expect(read(join(home, "personas/me.yaml"))).toBe(migrated(ME));
  expect(read(join(home, "overrides.yaml"))).toBe(migrated(OVERRIDES));
  expect(read(join(home, "state.json"))).toBe(stateText(".donn"));
  expect(existsSync(join(home, "build"))).toBe(false);
  // The new daemon makes sessions/ again; the old session is gone.
  expect(existsSync(join(home, "sessions/s1"))).toBe(false);
  expect(read(join(home, "daemon/daemon.log"))).toMatch(/^old log\n/);
  expect(existsSync(join(home, "migrating.json"))).toBe(false);
  // The old service is gone; the new one is installed, loaded and serving.
  expect(existsSync(oldPlist())).toBe(false);
  expect(m.loaded.has("zzpersona.daemon")).toBe(false);
  expect(existsSync(newPlist())).toBe(true);
  expect(m.loaded.has("dev.getdonn.daemon")).toBe(true);
  // The token moved; the old item is gone.
  expect([...m.keychain]).toEqual([[`donn-registry ${ACCOUNT}`, OLD_TOKEN]]);
  // The old mod is unregistered; the new one installed from the new home.
  expect([...m.plugins]).toEqual(["donn@donn"]);
  expect([...m.marketplaces]).toEqual([["donn", join(home, "mod")]]);
  expect(
    JSON.parse(read(join(home, "mod/.claude-plugin/marketplace.json"))).name,
  ).toBe("donn");
}

const json = (r: { stdout: string }) => JSON.parse(r.stdout);

describe("donn migrate", () => {
  it("performs spec 22 §3's steps in order, the mod removed before the move, and ends with doctor", async () => {
    const m = machine();
    oldInstall(m);
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json(r)).toEqual({
      steps: STEPS.map((id) => ({ id, status: "ran" })),
      env: [],
      doctor: { checks: expect.any(Array) },
    });
    const checks = json(r).doctor.checks as { id: string; status: string }[];
    expect(checks.filter((c) => c.status === "error")).toEqual([]);
    // The old home is gone: doctor has nothing to say about migrating.
    expect(checks.find((c) => c.id === "migrate")).toBeUndefined();
    expect(checks.find((c) => c.id === "mod")?.status).toBe("ok");
    expect(changes(m)).toEqual([
      `launchctl bootout gui/${uid}/zzpersona.daemon`,
      "claude plugin uninstall zzpersona@zzpersona",
      "claude plugin marketplace remove zzpersona",
      `security add donn-registry ${ACCOUNT}`,
      `security delete zzpersona-registry ${ACCOUNT}`,
      `claude plugin marketplace add ${join(newHome(), "mod")}`,
      "claude plugin install donn@donn --scope user",
      `launchctl bootout gui/${uid}/dev.getdonn.daemon`,
      `launchctl bootstrap gui/${uid} ${newPlist()}`,
    ]);
    expectMigrated(m);
    // The plan went to stderr under --json, with the header from the spec.
    expect(r.stderr).toContain(`migrate ~/.zzpersona to ${newHome()}:`);
  });

  it("runs the steps one after another, each leaving its effect", async () => {
    const m = machine();
    oldInstall(m);
    const io = ioFor(m);
    /** For each step, whether its "before" still holds: true until the step has run. */
    const before = () => {
      const home = existsSync(oldHome()) ? oldHome() : newHome();
      return [
        existsSync(oldPlist()),
        m.plugins.has("zzpersona@zzpersona"),
        existsSync(oldHome()),
        existsSync(join(home, "build")),
        read(join(home, "layers/org/acme.yaml")) === ACME,
        read(join(home, "state.json")).includes("/.zzpersona"),
        m.keychain.has(`zzpersona-registry ${ACCOUNT}`),
        !m.plugins.has("donn@donn"),
        !existsSync(newPlist()),
      ];
    };
    const seen: Record<string, boolean[]> = {};
    const result = await runMigration(io, await planMigration(io), {
      yes: true,
      afterStep: (id) => {
        seen[id] = before();
      },
    });
    expect(result?.map((s) => s.id)).toEqual(STEPS);
    // After step i, exactly the first i + 1 effects are in place.
    expect(seen).toEqual(
      Object.fromEntries(
        STEPS.map((id, i) => [id, STEPS.map((_, j) => j > i)]),
      ),
    );
  });

  it("prints the plan as text and the doctor's lines", async () => {
    const m = machine();
    oldInstall(m);
    const r = await donn(m, ["migrate", "--yes"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe(`migrate ~/.zzpersona to ${newHome()}:`);
    for (const id of STEPS)
      expect(r.stdout).toMatch(new RegExp(`pending +${id} `));
    expect(r.stdout).toMatch(/^  ran +service-start$/m);
    expect(r.stdout).toMatch(/^ok +mod /m);
  });

  it("a re-run is a no-op", async () => {
    const m = machine();
    oldInstall(m);
    expect((await donn(m, ["migrate", "--yes", "--json"])).code).toBe(0);
    m.log.length = 0;
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json(r)).toMatchObject({
      steps: STEPS.map((id) => ({ id, status: "done" })),
      message: "nothing to migrate: no zzpersona install found",
    });
    expect(changes(m)).toEqual([]);
    expectMigrated(m);
  });

  it.each(STEPS)(
    "an interruption after %s, then a re-run, completes",
    async (stop) => {
      const m = machine();
      oldInstall(m);
      const io = ioFor(m);
      await expect(
        runMigration(io, await planMigration(io), {
          yes: true,
          afterStep: (id) => {
            if (id === stop) throw new Error("interrupted");
          },
        }),
      ).rejects.toThrow("interrupted");
      const r = await donn(m, ["migrate", "--yes", "--json"]);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const at = STEPS.indexOf(stop);
      const statuses = (json(r).steps as { id: string; status: string }[]).map(
        (s) => s.status,
      );
      // Everything up to the interruption is recognised as done; the rest runs now.
      expect(statuses.slice(0, at + 1).every((s) => s === "done")).toBe(true);
      expect(statuses.slice(at + 1).every((s) => s === "ran")).toBe(true);
      expectMigrated(m);
    },
  );

  it("an existing non-empty target is refused, nothing moved, with --yes too", async () => {
    const message = `${newHome()} already exists and is not empty; move it aside or set DONN_HOME`;
    for (const yes of [true, false]) {
      const m = machine();
      oldInstall(m);
      put(join(newHome(), "config.yaml"), "personas: /elsewhere\n");
      let asked = false;
      const r = await donn(
        m,
        ["migrate", "--json", ...(yes ? ["--yes"] : [])],
        {
          managed: {
            confirm: async () => {
              asked = true;
              return true;
            },
          },
        },
      );
      expect(r.code).toBe(1);
      expect(json(r).error).toMatchObject({
        code: "migrate-target-exists",
        message,
      });
      expect(asked).toBe(false);
      expect(changes(m)).toEqual([]);
      expect(read(join(oldHome(), "layers/org/acme.yaml"))).toBe(ACME);
      expect(existsSync(oldPlist())).toBe(true);
      expect(readdirSync(newHome())).toEqual(["config.yaml"]);
      rmSync(user(), { recursive: true, force: true });
    }
    const m = machine();
    oldInstall(m);
    put(join(newHome(), "x"), "");
    const text = await donn(m, ["migrate", "--yes"]);
    expect(text.stderr).toContain(message);
  });

  it("moves into DONN_HOME when it is set", async () => {
    const target = join(root, "elsewhere/donn-home");
    const m = machine("darwin", () => target);
    oldInstall(m);
    const r = await donn(m, ["migrate", "--yes", "--json"], {
      env: { DONN_HOME: target },
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(existsSync(oldHome())).toBe(false);
    // ~/.zzpersona paths in config.yaml now name the new home itself.
    expect(read(join(target, "config.yaml"))).toBe(
      `personas: ${target}/layers\nregistry:\n  url: ${REGISTRY}\n`,
    );
    expect(read(join(target, "layers/org/acme.yaml"))).toBe(migrated(ACME));
  });

  it("says nothing to migrate without an old install", async () => {
    const m = machine();
    mkdirSync(user(), { recursive: true });
    const r = await donn(m, ["migrate"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "nothing to migrate: no zzpersona install found",
    );
    expect(changes(m)).toEqual([]);
    expect(existsSync(newHome())).toBe(false);
    const j = await donn(m, ["migrate", "--json"]);
    expect(json(j)).toEqual({
      steps: STEPS.map((id) => ({ id, status: "done" })),
      env: [],
      message: "nothing to migrate: no zzpersona install found",
    });
  });

  it("names old environment variables and an old managed policy, changing neither", async () => {
    const m = machine();
    mkdirSync(user(), { recursive: true });
    const managedRoot = join(root, "ClaudeCode");
    put(join(managedRoot, "zzpersona/manifest.json"), "{}");
    const env = { ZZPERSONA_PERSONA: "x", ZZP_E2E: "1", DONN_E2E: "" };
    const r = await donn(m, ["migrate", "--json"], {
      env,
      managed: { root: managedRoot },
    });
    expect(r.code, r.stderr).toBe(0);
    expect(json(r)).toMatchObject({
      env: [
        { name: "ZZPERSONA_PERSONA", rename: "DONN_PERSONA" },
        { name: "ZZP_E2E", rename: "DONN_E2E" },
      ],
      managed: {
        root: managedRoot,
        next: [
          "sudo donn migrate --managed",
          "donn managed build",
          "sudo donn managed install donn-managed",
        ],
      },
    });
    const text = await donn(m, ["migrate"], {
      env,
      managed: { root: managedRoot },
    });
    expect(text.stdout).toContain("ZZPERSONA_PERSONA");
    expect(text.stdout).toContain("ZZP_E2E");
    expect(text.stdout).toContain("sudo donn migrate --managed");
    expect(existsSync(join(managedRoot, "zzpersona/manifest.json"))).toBe(true);
  });

  it("runs no step before the confirmation unless --yes", async () => {
    const m = machine();
    oldInstall(m);
    let asked = 0;
    const r = await donn(m, ["migrate"], {
      managed: {
        confirm: async () => {
          asked++;
          // Nothing has happened yet when the question is asked.
          expect(changes(m)).toEqual([]);
          expect(existsSync(oldPlist())).toBe(true);
          expect(read(join(oldHome(), "layers/org/acme.yaml"))).toBe(ACME);
          // The plan looked for the old token without reading its secret.
          expect(m.log).toContain(
            `security find zzpersona-registry ${ACCOUNT}`,
          );
          expect(m.log.filter((c) => c.startsWith("security read"))).toEqual(
            [],
          );
          return false;
        },
      },
    });
    expect(asked).toBe(1);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cancelled; nothing changed");
    expect(changes(m)).toEqual([]);
    expect(existsSync(newHome())).toBe(false);
    // Without a terminal to ask on, it refuses.
    const quiet = await donn(m, ["migrate", "--json"]);
    expect(quiet.code).toBe(1);
    expect(json(quiet).error).toMatchObject({
      code: "migrate-confirm",
      message: "no terminal to confirm on; re-run with --yes",
    });
    expect(changes(m)).toEqual([]);
  });

  it("refuses before any change when donn is not on PATH for the new service", async () => {
    const m = machine();
    oldInstall(m);
    const r = await donn(m, ["migrate", "--yes", "--json"], {
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(r.code).toBe(1);
    expect(json(r).error.code).toBe("cli-not-on-path");
    expect(changes(m)).toEqual([]);
    expect(existsSync(oldPlist())).toBe(true);
    expect(existsSync(newHome())).toBe(false);
  });

  it("stops an old daemon that runs outside the service before moving its home", async () => {
    const m = machine();
    oldInstall(m);
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "daemon", "run"],
      { stdio: "ignore" },
    );
    children.push(child);
    await new Promise((resolve) => child.once("spawn", resolve));
    put(join(oldHome(), "daemon/pid"), String(child.pid));
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(isAlive(child.pid!)).toBe(false);
  });

  it("removes the old systemd unit on Linux and installs the new one", async () => {
    const m = machine("linux");
    const unit = join(user(), ".config/systemd/user/zzpersona-daemon.service");
    put(unit, "[Service]\n");
    m.loaded.add("zzpersona-daemon.service");
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(existsSync(unit)).toBe(false);
    expect(
      existsSync(join(user(), ".config/systemd/user/donn-daemon.service")),
    ).toBe(true);
    expect(changes(m)).toEqual(
      expect.arrayContaining([
        "systemctl --user disable --now zzpersona-daemon.service",
        "systemctl --user enable --now donn-daemon.service",
      ]),
    );
  });
});

type Step = { id: string; status: string; notes?: string[] };
const stepOf = (r: { stdout: string }, id: string) =>
  (json(r).steps as Step[]).find((step) => step.id === id);

describe("donn migrate: resuming and safety", () => {
  it("resumes a cross-filesystem move interrupted after the old home was set aside", async () => {
    const m = machine();
    oldInstall(m);
    const io = ioFor(m);
    const src = oldHome();
    const target = newHome();
    const steps = await planMigration(io, {
      move: {
        rename: async (from, to) => {
          if (from === src && to === target)
            throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
          if (from === `${target}.migrating` && to === target)
            throw new Error("interrupted");
          await rename(from, to);
        },
      },
    });
    await expect(runMigration(io, steps, { yes: true })).rejects.toThrow(
      "interrupted",
    );
    // The window: neither home is in place; the verified copy waits next to the target.
    expect(existsSync(src)).toBe(false);
    expect(existsSync(target)).toBe(false);
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json(r).steps).toEqual(
      STEPS.map((id) => ({
        id,
        status: ["service-stop", "mod-remove"].includes(id) ? "done" : "ran",
      })),
    );
    expectMigrated(m);
  });

  it("checks each step again just before it runs", async () => {
    const m = machine();
    oldInstall(m);
    const io = ioFor(m);
    const steps = await planMigration(io);
    expect(steps.find((step) => step.id === "keychain")?.status).toBe(
      "pending",
    );
    // Done by someone else between the plan and the run.
    m.keychain.delete(`zzpersona-registry ${ACCOUNT}`);
    const result = await runMigration(io, steps, { yes: true });
    expect(result?.find((step) => step.id === "keychain")?.status).toBe("done");
    expect(changes(m)).not.toContain(
      `security delete zzpersona-registry ${ACCOUNT}`,
    );
  });

  it("leaves the old mod's removal pending with claude's message while claude still lists it", async () => {
    for (const said of [
      "Error: settings.json is read-only\n",
      // Exit 1 and a not-found message, yet still listed: not taken for success.
      'Plugin "zzpersona@zzpersona" is not installed\n',
    ]) {
      await Promise.all(daemons.splice(0).map((d) => d.close()));
      rmSync(user(), { recursive: true, force: true });
      const m = machine();
      oldInstall(m);
      m.uninstallError = said;
      const r = await donn(m, ["migrate", "--yes", "--json"]);
      expect(r.code).toBe(1);
      expect(json(r).error).toMatchObject({
        code: "mod-uninstall",
        message: expect.stringContaining(said.trim()),
      });
      // Stopped before the move: the old mod still reads from the old home.
      expect(existsSync(oldHome())).toBe(true);
      m.uninstallError = undefined;
      const again = await donn(m, ["migrate", "--yes", "--json"]);
      expect(again.code, again.stdout + again.stderr).toBe(0);
      expect(stepOf(again, "mod-remove")).toEqual({
        id: "mod-remove",
        status: "ran",
      });
      expectMigrated(m);
    }
  });

  it("refuses before any change when the bundled mod is not built", async () => {
    const m = machine();
    oldInstall(m);
    const unbuilt = join(root, "unbuilt");
    mkdirSync(unbuilt);
    await expect(
      planMigration(ioFor(m), { modDir: unbuilt }),
    ).rejects.toMatchObject({
      code: "mod-install",
      message: expect.stringContaining("the mod is not built"),
    });
    expect(changes(m)).toEqual([]);
  });

  it("refuses before any change when claude is not on PATH but the old mod is installed", async () => {
    const m = machine();
    oldInstall(m);
    m.noClaude = true;
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code).toBe(1);
    expect(json(r).error).toMatchObject({
      code: "claude-not-on-path",
      message: expect.stringContaining("the old mod cannot be unregistered"),
    });
    expect(changes(m)).toEqual([]);
    expect(existsSync(oldPlist())).toBe(true);
  });

  it("refuses a claude plugin list of an unexpected shape rather than taking it for done", async () => {
    for (const stdout of [
      JSON.stringify(["zzpersona@zzpersona"]),
      JSON.stringify([{ pluginId: "zzpersona@zzpersona" }]),
      JSON.stringify([null]),
      JSON.stringify({ plugins: [] }),
    ]) {
      rmSync(user(), { recursive: true, force: true });
      const m = machine();
      oldInstall(m);
      m.listReply = { exitCode: 0, stdout, stderr: "" };
      const r = await donn(m, ["migrate", "--yes", "--json"]);
      expect(r.code, stdout).toBe(1);
      expect(json(r).error).toMatchObject({
        code: "mod-uninstall",
        message: expect.stringContaining("unexpected shape"),
      });
      expect(changes(m)).toEqual([]);
      expect(m.plugins.has("zzpersona@zzpersona")).toBe(true);
    }
  });

  it("names the shell's claude alias and its PATH fix when claude is not on PATH", async () => {
    const m = machine();
    oldInstall(m);
    m.noClaude = true;
    m.shellSays = "claude is an alias for /opt/claude/claude\n";
    const r = await donn(m, ["migrate", "--yes", "--json"], {
      env: { SHELL: "/bin/zsh" },
    });
    expect(r.code).toBe(1);
    expect(json(r).error.message).toBe(
      `claude is not on PATH, so the old mod cannot be unregistered; your shell has claude as an alias for /opt/claude/claude; donn runs the claude on PATH, which aliases don't change: export PATH="/opt/claude:$PATH" in your shell's startup file; or, if Claude Code is gone, remove ${join(oldHome(), "mod")}; then run donn migrate again`,
    );
    // Once the old mod is unregistered, removing its folder would not help: not suggested.
    put(
      join(oldHome(), "migrating.json"),
      `${JSON.stringify({ mod: true })}\n`,
    );
    m.plugins.clear();
    m.marketplaces.clear();
    const later = await donn(m, ["migrate", "--yes", "--json"], {
      env: { SHELL: "/bin/zsh" },
    });
    expect(later.code).toBe(1);
    expect(json(later).error.message).toBe(
      `claude is not on PATH, so the donn mod cannot be installed (the old one is already unregistered); your shell has claude as an alias for /opt/claude/claude; donn runs the claude on PATH, which aliases don't change: export PATH="/opt/claude:$PATH" in your shell's startup file; then run donn migrate again`,
    );
    expect(changes(m)).toEqual([]);
  });

  it("does not ask claude when there is no old mod to remove", async () => {
    const m = machine();
    mkdirSync(user(), { recursive: true });
    m.listReply = { exitCode: 1, stdout: "", stderr: "boom\n" };
    const r = await donn(m, ["migrate", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json(r).message).toBe(
      "nothing to migrate: no zzpersona install found",
    );
    expect(m.log.filter((call) => call.startsWith("claude"))).toEqual([]);
  });

  it("leaves the keychain step pending with a note when the keychain does not answer", async () => {
    const m = machine();
    oldInstall(m);
    m.keychainError = "User interaction is not allowed.";
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(stepOf(r, "keychain")).toEqual({
      id: "keychain",
      status: "pending",
      notes: [expect.stringContaining("User interaction is not allowed.")],
    });
    // Every other step finished.
    expect(
      (json(r).steps as Step[])
        .filter((step) => step.id !== "keychain")
        .every((step) => step.status === "ran"),
    ).toBe(true);
    m.keychainError = undefined;
    const again = await donn(m, ["migrate", "--yes", "--json"]);
    expect(stepOf(again, "keychain")).toEqual({
      id: "keychain",
      status: "ran",
    });
    expectMigrated(m);
  });

  it("keeps a newer sign-in under the new name and deletes the old item", async () => {
    const m = machine();
    oldInstall(m);
    m.keychain.set(`donn-registry ${ACCOUNT}`, "donn_newer-sign-in");
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(stepOf(r, "keychain")).toEqual({
      id: "keychain",
      status: "ran",
      notes: [expect.stringContaining("kept the newer sign-in")],
    });
    expect([...m.keychain]).toEqual([
      [`donn-registry ${ACCOUNT}`, "donn_newer-sign-in"],
    ]);
  });

  it("warns in the plan about sessions the old CLI started", async () => {
    const m = machine();
    oldInstall(m);
    put(
      join(oldHome(), "sessions/abc/launched.json"),
      JSON.stringify({
        persona: "user/me",
        source: "default",
        pid: process.pid,
      }),
    );
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const warning = `1 session started by zzpersona is still running (pid ${process.pid}); it loses its plugin and build folders: restart it after the migration`;
    expect(r.stderr).toContain(`warning: ${warning}`);
    expect(json(r).warnings).toEqual([warning]);
  });

  it("refuses while ZZPERSONA_HOME names another old home", async () => {
    const m = machine();
    oldInstall(m);
    const fromEnv = await donn(m, ["migrate", "--yes", "--json"], {
      env: { ZZPERSONA_HOME: "/elsewhere/zz" },
    });
    expect(fromEnv.code).toBe(1);
    expect(json(fromEnv).error).toMatchObject({
      code: "migrate-old-home",
      message:
        "ZZPERSONA_HOME is set in your environment (/elsewhere/zz); donn migrate moves only ~/.zzpersona: unset it, or move that home by hand",
    });
    const old = serviceManager(
      { env: { HOME: user() }, probe: m.probe },
      { label: "zzpersona.daemon" },
    )!;
    writeFileSync(
      oldPlist(),
      old.render({
        command: ["/u/bin/zzpersona", "daemon", "run"],
        env: { ZZPERSONA_HOME: "/elsewhere/zz", ZZPERSONA_SERVICE: "1" },
        log: "/elsewhere/zz/daemon/daemon.log",
      }),
    );
    const fromService = await donn(m, ["migrate", "--yes", "--json"]);
    expect(fromService.code).toBe(1);
    expect(json(fromService).error).toMatchObject({
      code: "migrate-old-home",
      message: `ZZPERSONA_HOME is set in ${oldPlist()} (/elsewhere/zz); donn migrate moves only ~/.zzpersona: unset it, or move that home by hand`,
    });
    expect(changes(m)).toEqual([]);
    expect(existsSync(newHome())).toBe(false);
  });

  it("resumes when the target holds only a migration's progress", async () => {
    const m = machine();
    oldInstall(m);
    put(
      join(newHome(), "migrating.json"),
      `${JSON.stringify({ service: true })}\n`,
    );
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expectMigrated(m);
  });

  it("suggests removing the old global CLI", async () => {
    const m = machine();
    oldInstall(m);
    const pnpmBin = join(root, "Library/pnpm/bin");
    put(join(pnpmBin, "zzpersona"), "#!/bin/sh\n");
    chmodSync(join(pnpmBin, "zzpersona"), 0o755);
    const env = { PATH: `${bin()}:${pnpmBin}:/usr/bin:/bin` };
    const r = await donn(m, ["migrate", "--yes", "--json"], { env });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json(r).oldCli).toEqual({
      path: join(pnpmBin, "zzpersona"),
      remove: "pnpm remove --global @zzpersona/cli",
    });
    const text = await donn(m, ["migrate"], { env });
    expect(text.stdout).toContain(
      `the old CLI is still on PATH (${join(pnpmBin, "zzpersona")}); remove it: pnpm remove --global @zzpersona/cli`,
    );
  });
});

/** What running donn before migrating leaves in ~/.donn: its daemon, sessions, builds and mod. */
function madeByDonn() {
  const home = newHome();
  for (const file of ["sock", "pid", "token", "where", "daemon.lock"])
    put(join(home, "daemon", file), "");
  put(join(home, "daemon/daemon.log"), "a donn daemon ran here\n");
  put(join(home, "sessions/s9/launched.json"), "{}\n");
  put(join(home, "build/claude-code/user-me/settings.json"), "{}\n");
  mkdirSync(join(home, "personas"), { recursive: true });
  put(
    join(home, "mod/.claude-plugin/marketplace.json"),
    `${JSON.stringify({ name: "donn", plugins: [{ name: "donn", source: "./plugin" }] })}\n`,
  );
  put(join(home, "mod/plugin/.claude-plugin/plugin.json"), '{"name":"donn"}\n');
  put(
    join(home, "state.json"),
    `${JSON.stringify({ version: 1, projects: {} }, null, 2)}\n`,
  );
  put(join(home, "state.lock"), "");
}

const madeMessage = (daemon = "") =>
  `${newHome()} was made by running donn before migrating; ${daemon}run \`donn mod uninstall\` if the donn mod is installed, then remove ${newHome()} and run \`donn migrate\` again`;

describe("donn migrate: a target donn made before the migration", () => {
  it("names the cause when the target holds only what donn makes itself, and deletes nothing", async () => {
    const m = machine();
    oldInstall(m);
    madeByDonn();
    const before = readdirSync(newHome()).sort();
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code).toBe(1);
    expect(json(r).error).toMatchObject({
      code: "migrate-target-exists",
      message: madeMessage(),
    });
    expect(json(r).error.message).not.toContain("DONN_HOME");
    expect(changes(m)).toEqual([]);
    expect(readdirSync(newHome()).sort()).toEqual(before);
    expect(read(join(oldHome(), "layers/org/acme.yaml"))).toBe(ACME);
  });

  it("asks for the daemon to be stopped first when one runs for the target", async () => {
    const m = machine();
    oldInstall(m);
    madeByDonn();
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "daemon", "run"],
      { stdio: "ignore" },
    );
    children.push(child);
    await new Promise((resolve) => child.once("spawn", resolve));
    put(join(newHome(), "daemon/pid"), `${child.pid}\n`);
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code).toBe(1);
    expect(json(r).error.message).toBe(
      madeMessage("stop its daemon (`donn daemon stop`), "),
    );
    expect(isAlive(child.pid!)).toBe(true);
  });

  it("keeps the plain refusal when the target holds anything the user wrote", async () => {
    const plain = `${newHome()} already exists and is not empty; move it aside or set DONN_HOME`;
    const authored: [string, string][] = [
      [
        "state.json",
        `${JSON.stringify({ version: 1, default: "user/me", projects: {} })}\n`,
      ],
      [
        "state.json",
        `${JSON.stringify({ version: 1, projects: { "/p/.donn": "user/me" } })}\n`,
      ],
      ["config.yaml", "personas: ~/personas\n"],
      ["personas/me.yaml", ME],
      ["overrides.yaml", OVERRIDES],
      ["registry-token", "t\n"],
      ["cache/registry/index.json", "{}\n"],
      [
        "mod/.claude-plugin/marketplace.json",
        `${JSON.stringify({ name: "someone-else" })}\n`,
      ],
      ["notes.txt", "mine\n"],
    ];
    for (const [path, content] of authored) {
      rmSync(user(), { recursive: true, force: true });
      const m = machine();
      oldInstall(m);
      madeByDonn();
      put(join(newHome(), path), content);
      const r = await donn(m, ["migrate", "--yes", "--json"]);
      expect(r.code, path).toBe(1);
      expect(json(r).error.message, path).toBe(plain);
      expect(changes(m)).toEqual([]);
    }
  });
});

describe("donn doctor before the migration", () => {
  type Check = { id: string; status: string; message: string; fix?: string };
  const checksOf = (r: { stdout: string }) => json(r).checks as Check[];

  it("reports the old home first, as an error, its fix before init's and mod install's", async () => {
    const m = machine();
    oldInstall(m);
    const r = await donn(m, ["doctor", "--json"]);
    expect(r.code).toBe(1);
    expect(checksOf(r)[0]).toEqual({
      id: "migrate",
      status: "error",
      message: `${oldHome()} is from before the rename, and ${newHome()} does not exist yet`,
      fix: "donn migrate",
    });
    const text = await donn(m, ["doctor"]);
    const at = (fix: string) => text.stdout.indexOf(`fix: ${fix}`);
    expect(at("donn migrate")).toBeGreaterThan(-1);
    expect(at("donn init")).toBeGreaterThan(at("donn migrate"));
    expect(at("donn mod install")).toBeGreaterThan(at("donn migrate"));
    // doctor changes nothing: the new home is still not there.
    expect(existsSync(newHome())).toBe(false);
  });

  it("names a new home that donn made itself, with the same advice as migrate", async () => {
    const m = machine();
    oldInstall(m);
    madeByDonn();
    const r = await donn(m, ["doctor", "--json"]);
    expect(r.code).toBe(1);
    expect(checksOf(r)[0]).toEqual({
      id: "migrate",
      status: "error",
      message: `${oldHome()} is from before the rename, and ${newHome()} was made by running donn before migrating`,
      fix: `run \`donn mod uninstall\` if the donn mod is installed, then remove ${newHome()} and run \`donn migrate\` again`,
    });
  });

  it("says nothing about migrating once the old home is gone", async () => {
    const m = machine();
    madeByDonn();
    const r = await donn(m, ["doctor", "--json"]);
    expect(checksOf(r).find((c) => c.id === "migrate")).toBeUndefined();
  });
});

describe("donn migrate: project switches in state.json", () => {
  const PROJECT = (version: string) =>
    `apiVersion: ${version}\nkind: Persona\nmetadata:\n  name: project\n`;

  /** One project moved to .donn/ already, one still on the old folder, one switched since. */
  function projects() {
    const dir = (name: string) => {
      mkdirSync(join(root, name), { recursive: true });
      return realpathSync(join(root, name));
    };
    const moved = dir("moved");
    const waiting = dir("waiting");
    const fresh = dir("fresh");
    put(join(moved, ".donn/persona.yaml"), PROJECT("donn/v0"));
    put(join(waiting, ".zzpersona/persona.yaml"), PROJECT("zzpersona/v0"));
    put(join(fresh, ".donn/persona.yaml"), PROJECT("donn/v0"));
    put(
      join(oldHome(), "state.json"),
      `${JSON.stringify(
        {
          version: 1,
          default: "user/me",
          projects: {
            [join(moved, ".zzpersona")]: "team/a",
            [join(waiting, ".zzpersona")]: "team/b",
            [join(fresh, ".donn")]: "team/c",
          },
        },
        null,
        2,
      )}\n`,
    );
    return { moved, waiting, fresh };
  }

  /** The switch donn finds for a project folder, as `donn claude` would look it up. */
  const switchFor = async (dir: string) => {
    const state = JSON.parse(read(join(newHome(), "state.json"))) as {
      projects: Record<string, string>;
    };
    const project = findProject(dir);
    return project && state.projects[await projectKey(project)];
  };

  it("points each switch at the project's .donn/ folder and names projects still to migrate", async () => {
    const m = machine();
    oldInstall(m);
    const { moved, waiting, fresh } = projects();
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(stepOf(r, "state")).toEqual({ id: "state", status: "ran" });
    expect(JSON.parse(read(join(newHome(), "state.json")))).toEqual({
      version: 1,
      default: "user/me",
      projects: {
        [join(moved, ".donn")]: "team/a",
        [join(waiting, ".donn")]: "team/b",
        [join(fresh, ".donn")]: "team/c",
      },
    });
    expect(json(r).projects).toEqual([
      { dir: waiting, next: `donn migrate --project ${waiting}` },
    ]);
    expect(await switchFor(moved)).toBe("team/a");
    expect(await switchFor(fresh)).toBe("team/c");
    const text = await donn(m, ["migrate"]);
    expect(text.stdout).toContain(`  donn migrate --project ${waiting}\n`);
    // Once the project moves, its switch matches; nothing is left to name.
    const p = await donn(m, [
      "migrate",
      "--project",
      waiting,
      "--yes",
      "--json",
    ]);
    expect(p.code, p.stdout + p.stderr).toBe(0);
    expect(await switchFor(waiting)).toBe("team/b");
    const again = await donn(m, ["migrate", "--yes", "--json"]);
    expect(stepOf(again, "state")).toEqual({ id: "state", status: "done" });
    expect(json(again).projects).toBeUndefined();
  });

  it("ends with a working switch when the project migrates first", async () => {
    const m = machine();
    oldInstall(m);
    const { waiting } = projects();
    const p = await donn(m, [
      "migrate",
      "--project",
      waiting,
      "--yes",
      "--json",
    ]);
    expect(p.code, p.stdout + p.stderr).toBe(0);
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(await switchFor(waiting)).toBe("team/b");
    expect(json(r).projects).toBeUndefined();
  });

  it("keeps a switch made since the rename over the old one for the same project", async () => {
    const m = machine();
    oldInstall(m);
    const { moved } = projects();
    const file = join(oldHome(), "state.json");
    const state = JSON.parse(read(file));
    state.projects[join(moved, ".donn")] = "team/newer";
    writeFileSync(file, JSON.stringify(state));
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(await switchFor(moved)).toBe("team/newer");
    expect(
      Object.keys(JSON.parse(read(join(newHome(), "state.json"))).projects),
    ).not.toContain(join(moved, ".zzpersona"));
  });

  it("leaves a state.json it cannot read for doctor to report", async () => {
    const m = machine();
    oldInstall(m);
    put(join(oldHome(), "state.json"), "{");
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(stepOf(r, "state")).toEqual({ id: "state", status: "done" });
    expect(read(join(newHome(), "state.json"))).toBe("{");
  });
});

describe("donn migrate: what it reports and re-checks", () => {
  it("names persona and overrides values that point into the old home, changing none", async () => {
    const m = machine();
    oldInstall(m);
    const paths = [
      "apiVersion: zzpersona/v0",
      "kind: Persona",
      "metadata:",
      "  name: paths",
      "instructions:",
      "  - id: notes",
      "    file: ~/.zzpersona/notes/a.md",
      "  - id: words",
      "    inline: zzpersona and ~/.zzpersona-other/x are not the home",
      "hooks:",
      "  PreToolUse:",
      "    - id: guard",
      '      run: "bash $HOME/.zzpersona/hooks/guard.sh"',
      "skills:",
      "  - name: s",
      `    source: ${oldHome()}/skills/s`,
      "",
    ].join("\n");
    put(join(oldHome(), "personas/paths.yaml"), paths);
    const overrides = `apiVersion: zzpersona/v0\nkind: PersonaOverlay\ninstructions:\n  - id: o\n    file: ~/.zzpersona\n`;
    put(join(oldHome(), "overrides.yaml"), overrides);
    const team = `apiVersion: zzpersona/v0\nkind: Persona\nmetadata:\n  name: t\nmcpServers:\n  x:\n    command: ${oldHome()}/bin/x\n`;
    put(join(oldHome(), "layers/team/t.yaml"), team);
    // Not the user's to change: a build of the old home.
    put(join(oldHome(), "build/x.yaml"), "file: ~/.zzpersona/build-only\n");
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const home = newHome();
    expect(json(r).oldPaths).toEqual([
      {
        file: join(home, "layers/team/t.yaml"),
        field: "mcpServers.x.command",
        value: `${oldHome()}/bin/x`,
      },
      {
        file: join(home, "overrides.yaml"),
        field: "instructions[0].file",
        value: "~/.zzpersona",
      },
      {
        file: join(home, "personas/paths.yaml"),
        field: "hooks.PreToolUse[0].run",
        value: "bash $HOME/.zzpersona/hooks/guard.sh",
      },
      {
        file: join(home, "personas/paths.yaml"),
        field: "instructions[0].file",
        value: "~/.zzpersona/notes/a.md",
      },
      {
        file: join(home, "personas/paths.yaml"),
        field: "skills[0].source",
        value: `${oldHome()}/skills/s`,
      },
    ]);
    // Reported, not changed (only the apiVersion line moved on).
    expect(read(join(home, "personas/paths.yaml"))).toBe(migrated(paths));
    expect(read(join(home, "overrides.yaml"))).toBe(migrated(overrides));
    const text = await donn(m, ["migrate"]);
    expect(text.stdout).toContain(
      `  ${join(home, "personas/paths.yaml")}: skills[0].source: ${oldHome()}/skills/s\n`,
    );
  });

  it("starts the new service on a re-run when its file is written but it is not loaded", async () => {
    const m = machine();
    oldInstall(m);
    expect((await donn(m, ["migrate", "--yes", "--json"])).code).toBe(0);
    // Interrupted after the new service file was written, before it loaded.
    await Promise.all(daemons.splice(0).map((d) => d.close()));
    m.loaded.delete("dev.getdonn.daemon");
    put(
      join(newHome(), "migrating.json"),
      `${JSON.stringify({ service: true })}\n`,
    );
    expect(existsSync(newPlist())).toBe(true);
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(stepOf(r, "service-start")).toEqual({
      id: "service-start",
      status: "ran",
    });
    expect(m.loaded.has("dev.getdonn.daemon")).toBe(true);
  });

  it("does not take the old mod for removed when claude disappears before its step runs", async () => {
    const m = machine();
    oldInstall(m);
    const io = ioFor(m);
    const steps = await planMigration(io);
    m.noClaude = true;
    await expect(runMigration(io, steps, { yes: true })).rejects.toMatchObject({
      code: "mod-uninstall",
      message: expect.stringContaining("claude is not on PATH"),
    });
    // Stopped before the move: the old mod still reads from the old home.
    expect(existsSync(join(oldHome(), "mod"))).toBe(true);
    expect(existsSync(newHome())).toBe(false);
  });
});

describe("apiVersion is rewritten in place", () => {
  it("changes only the value, quoted or not, with or without a comment", () => {
    const cases: [string, string][] = [
      ["apiVersion: zzpersona/v0\n", "apiVersion: donn/v0\n"],
      ['apiVersion: "zzpersona/v0"\n', 'apiVersion: "donn/v0"\n'],
      ["apiVersion: 'zzpersona/v0'\n", "apiVersion: 'donn/v0'\n"],
      [
        "apiVersion:   zzpersona/v0   # the version\n",
        "apiVersion:   donn/v0   # the version\n",
      ],
      [
        'apiVersion: "zzpersona/v0" # zzpersona/v0 stays here\r\nkind: Persona\r\n',
        'apiVersion: "donn/v0" # zzpersona/v0 stays here\r\nkind: Persona\r\n',
      ],
      ["apiVersion: zzpersona/v0", "apiVersion: donn/v0"],
    ];
    for (const [before, after] of cases)
      expect(rewriteApiVersion(before)).toBe(after);
    // Not top-level, not the whole value, or another version: untouched.
    for (const same of [
      "  apiVersion: zzpersona/v0\n",
      "apiVersion: zzpersona/v01\n",
      "apiVersion: zzpersona/v1\n",
      "# apiVersion: zzpersona/v0\n",
      "description: apiVersion: zzpersona/v0\n",
      "apiVersion: \"zzpersona/v0'\n",
    ])
      expect(rewriteApiVersion(same)).toBe(same);
  });

  it("rewrites persona files in a personas folder outside the home, every other byte kept", async () => {
    const m = machine();
    const personas = join(root, "my-personas");
    const quoted = `# zzpersona org file\r\napiVersion: "zzpersona/v0"   # pinned\r\nkind: Persona\r\nmetadata:\r\n  name: acme\r\n  description: "zzpersona/v0 in a string"\r\n`;
    const plain = `apiVersion: zzpersona/v0\nkind: Persona\nmetadata:\n  name: web\nextends:\n  - org/acme\n`;
    put(join(personas, "org/acme.yaml"), quoted);
    put(join(personas, "team/web.yml"), plain);
    put(join(personas, "team/skills/x/SKILL.md"), "apiVersion: zzpersona/v0\n");
    put(join(personas, ".git/config.yaml"), "apiVersion: zzpersona/v0\n");
    put(join(oldHome(), "config.yaml"), `personas: ${personas}\n`);
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(read(join(personas, "org/acme.yaml"))).toBe(
      quoted.replace('"zzpersona/v0"   #', '"donn/v0"   #'),
    );
    expect(read(join(personas, "team/web.yml"))).toBe(
      plain.replace("zzpersona/v0", "donn/v0"),
    );
    // Not persona files: a skill's Markdown and git's own folder.
    expect(read(join(personas, "team/skills/x/SKILL.md"))).toBe(
      "apiVersion: zzpersona/v0\n",
    );
    expect(read(join(personas, ".git/config.yaml"))).toBe(
      "apiVersion: zzpersona/v0\n",
    );
    expect(read(join(newHome(), "config.yaml"))).toBe(
      `personas: ${personas}\n`,
    );
  });

  it("updates config.yaml paths into the old home, absolute or with ~", async () => {
    const m = machine();
    const old = oldHome();
    const config = [
      `personas: ${old}/layers # mine`,
      "adapters:",
      `  - "~/.zzpersona/adapters/x"`,
      `  - ${old}`,
      "  - ~/.zzpersona-other/y",
      "  - ./relative",
      "",
    ].join("\n");
    put(join(old, "config.yaml"), config);
    mkdirSync(join(old, "layers"));
    const r = await donn(m, ["migrate", "--yes", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(read(join(newHome(), "config.yaml"))).toBe(
      [
        `personas: ${newHome()}/layers # mine`,
        "adapters:",
        `  - "~/.donn/adapters/x"`,
        `  - ${newHome()}`,
        "  - ~/.zzpersona-other/y",
        "  - ./relative",
        "",
      ].join("\n"),
    );
  });
});

describe("moving the home", () => {
  const exdev = (src: string, target: string) => {
    return async (from: string, to: string) => {
      if (from === src && to === target)
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      await rename(from, to);
    };
  };

  function oldTree(src: string) {
    put(join(src, "config.yaml"), "personas: ./p\n");
    put(join(src, "p/org/a.yaml"), ACME);
    symlinkSync("p/org/a.yaml", join(src, "link.yaml"));
  }

  it("copies, verifies, then deletes across filesystems", async () => {
    const src = join(root, "a/.zzpersona");
    const target = join(root, "b/.donn");
    oldTree(src);
    await moveHome(src, target, { rename: exdev(src, target) });
    expect(existsSync(src)).toBe(false);
    expect(read(join(target, "p/org/a.yaml"))).toBe(ACME);
    expect(read(join(target, "link.yaml"))).toBe(ACME);
    expect(readdirSync(dirname(target))).toEqual([".donn"]);
    expect(readdirSync(dirname(src))).toEqual([]);
  });

  it("keeps the source when the copy does not verify", async () => {
    const src = join(root, "a/.zzpersona");
    const target = join(root, "b/.donn");
    oldTree(src);
    await expect(
      moveHome(src, target, {
        rename: exdev(src, target),
        copy: async (from, to) => {
          await cp(from, to, { recursive: true, verbatimSymlinks: true });
          writeFileSync(join(to, "p/org/a.yaml"), "changed");
        },
      }),
    ).rejects.toMatchObject({ code: "migrate-copy" });
    expect(read(join(src, "p/org/a.yaml"))).toBe(ACME);
    expect(existsSync(target)).toBe(false);
  });

  it("finishes a copy interrupted at any point", async () => {
    const src = join(root, "a/.zzpersona");
    const target = join(root, "b/.donn");
    // Interrupted mid-copy: a partial staging folder; the source is whole.
    oldTree(src);
    put(join(`${target}.migrating`, "config.yaml"), "partial");
    await moveHome(src, target, { rename: exdev(src, target) });
    expect(read(join(target, "p/org/a.yaml"))).toBe(ACME);
    expect(read(join(target, "config.yaml"))).toBe("personas: ./p\n");
    expect(existsSync(src)).toBe(false);
    expect(existsSync(`${target}.migrating`)).toBe(false);
    rmSync(target, { recursive: true });

    // Interrupted after the source was set aside, before the copy went into place.
    oldTree(`${src}.migrated`);
    oldTree(`${target}.migrating`);
    await moveHome(src, target);
    expect(read(join(target, "p/org/a.yaml"))).toBe(ACME);
    expect(existsSync(`${src}.migrated`)).toBe(false);
    expect(existsSync(`${target}.migrating`)).toBe(false);
    rmSync(target, { recursive: true });

    // Interrupted before the set-aside source was deleted.
    oldTree(`${src}.migrated`);
    oldTree(target);
    await moveHome(src, target);
    expect(existsSync(`${src}.migrated`)).toBe(false);
    expect(read(join(target, "p/org/a.yaml"))).toBe(ACME);
  });
});

describe("donn migrate --project", () => {
  /** A seeded repo whose project is still .zzpersona/, with a committed AGENTS.md block. */
  async function oldProject() {
    const s = seed();
    const cleanup = s.cleanup;
    roots.push(cleanup);
    const w = await zz(["write", "--json"], { cwd: s.repo, home: s.home });
    expect(w.code, w.stdout + w.stderr).toBe(0);
    const agents = join(s.repo, "AGENTS.md");
    const generated = read(agents)
      .replace("<!-- donn:begin", "<!-- zzpersona:begin")
      .replace("<!-- donn:end -->", "<!-- zzpersona:end -->")
      .replace(
        "<!-- zzpersona:begin — generated; edit the source, not this block -->\n",
        "<!-- zzpersona:begin — generated; edit the source, not this block -->\nzzpersona said: use zzpersona.\n",
      );
    const text = `# Agents\n\nKeep zzpersona in mind.\n\n${generated}\nFooter about zzpersona.\n`;
    writeFileSync(agents, text);
    const persona = join(s.repo, ".donn/persona.yaml");
    writeFileSync(
      persona,
      read(persona).replace(
        /^apiVersion: donn\/v0$/m,
        "apiVersion: zzpersona/v0",
      ),
    );
    execFileSync("mv", [join(s.repo, ".donn"), join(s.repo, ".zzpersona")]);
    return {
      s,
      agents,
      text,
      persona: read(join(s.repo, ".zzpersona/persona.yaml")),
    };
  }

  const roots: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of roots.splice(0)) cleanup();
  });

  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
      { cwd, encoding: "utf8" },
    );

  it("project markers are rewritten, the block is found again", async () => {
    const m = machine();
    const { s, agents, text, persona } = await oldProject();
    const r = await zz(["migrate", "--project", "--yes", "--json"], {
      cwd: join(s.repo, ".zzpersona"),
      home: s.home,
      env: { HOME: user() },
      probe: m.probe,
      runInput: m.runInput,
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json(r)).toMatchObject({
      project: s.repo,
      steps: [
        { id: "project-folder", status: "ran" },
        { id: "project-api-version", status: "ran" },
        { id: "project-markers", status: "ran" },
      ],
      doctor: { checks: expect.any(Array) },
    });
    // Only the two marker lines changed.
    expect(read(agents)).toBe(
      text
        .replace("<!-- zzpersona:begin", "<!-- donn:begin")
        .replace("<!-- zzpersona:end -->", "<!-- donn:end -->"),
    );
    expect(existsSync(join(s.repo, ".zzpersona"))).toBe(false);
    expect(read(join(s.repo, ".donn/persona.yaml"))).toBe(
      persona.replace("apiVersion: zzpersona/v0", "apiVersion: donn/v0"),
    );
    // donn write now replaces the block instead of adding a second one.
    const w = await zz(["write", "--json"], { cwd: s.repo, home: s.home });
    expect(w.code, w.stdout + w.stderr).toBe(0);
    expect(json(w).status).toBe("updated");
    const after = read(agents);
    expect(after.match(/<!-- donn:begin/g)).toHaveLength(1);
    expect(after).not.toContain("zzpersona:begin");
    expect(after).not.toContain("zzpersona said");
    expect(after.startsWith("# Agents\n\nKeep zzpersona in mind.\n\n")).toBe(
      true,
    );
    expect(after.endsWith("\nFooter about zzpersona.\n")).toBe(true);
    // A second run has nothing to do.
    const again = await zz(
      ["migrate", "--project", s.repo, "--yes", "--json"],
      {
        cwd: root,
        home: s.home,
        env: { HOME: user() },
        probe: m.probe,
        runInput: m.runInput,
      },
    );
    expect(again.code, again.stdout + again.stderr).toBe(0);
    expect(json(again).steps.map((x: { status: string }) => x.status)).toEqual([
      "done",
      "done",
      "done",
    ]);
  });

  it("uses git mv on a tracked .zzpersona/ and never commits", async () => {
    const m = machine();
    const { s } = await oldProject();
    git(s.repo, "init", "-q");
    git(s.repo, "add", ".");
    git(s.repo, "commit", "-q", "-m", "old");
    const head = git(s.repo, "rev-parse", "HEAD");
    const r = await zz(["migrate", "--project", s.repo, "--yes", "--json"], {
      cwd: root,
      home: s.home,
      env: { HOME: user() },
      probe: m.probe,
      runInput: m.runInput,
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(git(s.repo, "rev-parse", "HEAD")).toBe(head);
    // Staged as renames (the apiVersion edit to persona.yaml is left unstaged).
    const status = git(s.repo, "status", "--porcelain");
    expect(status).toMatch(
      /^R. \.zzpersona\/persona\.yaml -> \.donn\/persona\.yaml$/m,
    );
    expect(status).toMatch(
      /^R {2}\.zzpersona\/hooks\/format\.sh -> \.donn\/hooks\/format\.sh$/m,
    );
    expect(
      existsSync(join(s.repo, ".donn/instructions/checkout-overview.md")),
    ).toBe(true);
  });

  it("renames an untracked .zzpersona/ and refuses a non-empty .donn/", async () => {
    const m = machine();
    const { s } = await oldProject();
    mkdirSync(join(s.repo, ".donn"));
    writeFileSync(join(s.repo, ".donn/x"), "");
    const refused = await zz(
      ["migrate", "--project", s.repo, "--yes", "--json"],
      { cwd: root, home: s.home, env: { HOME: user() }, probe: m.probe },
    );
    expect(refused.code).toBe(1);
    expect(json(refused).error).toMatchObject({
      code: "migrate-target-exists",
      message: `${join(s.repo, ".donn")} already exists and is not empty; move it aside`,
    });
    expect(existsSync(join(s.repo, ".zzpersona/persona.yaml"))).toBe(true);
    rmSync(join(s.repo, ".donn"), { recursive: true });
    const ignore = "node_modules\n.zzpersona/build\n";
    writeFileSync(join(s.repo, ".gitignore"), ignore);
    const r = await zz(["migrate", "--project", s.repo, "--yes", "--json"], {
      cwd: root,
      home: s.home,
      env: { HOME: user() },
      probe: m.probe,
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(s.repo, ".donn/persona.yaml"))).toBe(true);
    // A .gitignore that names the old folder is reported, never changed.
    expect(json(r).gitignore).toEqual([
      { file: join(s.repo, ".gitignore"), line: 2, text: ".zzpersona/build" },
    ]);
    expect(read(join(s.repo, ".gitignore"))).toBe(ignore);
  });

  it("says nothing to migrate outside an old project", async () => {
    const m = machine();
    mkdirSync(join(root, "plain"));
    const r = await zz(
      ["migrate", "--project", join(root, "plain"), "--json"],
      {
        cwd: root,
        env: { HOME: user() },
        probe: m.probe,
      },
    );
    expect(r.code, r.stderr).toBe(0);
    expect(json(r).message).toBe(
      `nothing to migrate: no .zzpersona project found from ${join(root, "plain")}`,
    );
  });
});

describe("donn migrate --managed", () => {
  const managedRoot = () => join(root, "ClaudeCode");
  const admin = (extra: Partial<ManagedEnv> = {}): Partial<ManagedEnv> => ({
    root: managedRoot(),
    isAdmin: () => true,
    ...extra,
  });

  function oldPolicy() {
    const r = managedRoot();
    const files = {
      "managed-settings.d/50-zzpersona.json": "sha256:a",
      "managed-mcp.json": "sha256:b",
      "zzpersona/hooks/guard.sh": "sha256:c",
    };
    put(
      join(r, "zzpersona/manifest.json"),
      JSON.stringify({ format: 1, zzpersona: "0.12.0", files }),
    );
    for (const path of Object.keys(files)) put(join(r, path), "x");
    put(
      join(r, "zzpersona/pending.json"),
      JSON.stringify({ format: 1, paths: ["zzpersona/hooks/half.sh"] }),
    );
    put(join(r, "zzpersona/hooks/half.sh"), "x");
    // Not listed: never removed.
    put(join(r, "managed-settings.json"), "{}");
    put(join(r, "managed-settings.d/10-other.json"), "{}");
    put(join(r, "zzpersona/hooks/admin.sh"), "x");
  }

  it("removes only the files the old manifest and pending.json list", async () => {
    const m = machine();
    oldPolicy();
    const r = await donn(m, ["migrate", "--managed", "--yes", "--json"], {
      managed: admin(),
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json(r)).toMatchObject({
      root: managedRoot(),
      removed: [
        "managed-mcp.json",
        "managed-settings.d/50-zzpersona.json",
        "zzpersona/hooks/guard.sh",
        "zzpersona/hooks/half.sh",
        "zzpersona/manifest.json",
        "zzpersona/pending.json",
      ],
      next: ["donn managed build", "sudo donn managed install donn-managed"],
    });
    const left = (path: string) => existsSync(join(managedRoot(), path));
    expect(left("managed-mcp.json")).toBe(false);
    expect(left("managed-settings.d/50-zzpersona.json")).toBe(false);
    expect(left("zzpersona/hooks/guard.sh")).toBe(false);
    expect(left("zzpersona/hooks/half.sh")).toBe(false);
    expect(left("zzpersona/manifest.json")).toBe(false);
    expect(left("zzpersona/pending.json")).toBe(false);
    expect(left("managed-settings.json")).toBe(true);
    expect(left("managed-settings.d/10-other.json")).toBe(true);
    expect(left("zzpersona/hooks/admin.sh")).toBe(true);
    // Again: nothing left to remove.
    const again = await donn(m, ["migrate", "--managed", "--yes", "--json"], {
      managed: admin(),
    });
    expect(again.code).toBe(0);
    expect(json(again)).toMatchObject({ removed: [] });
  });

  it("keeps files the new donn install owns, managed-mcp.json among them", async () => {
    const home = join(root, "home");
    const personas = join(root, "personas");
    put(join(home, "config.yaml"), `personas: ${personas}\n`);
    put(
      join(personas, "org/acme.yaml"),
      [
        "apiVersion: donn/v0",
        "kind: Persona",
        "metadata: { name: acme }",
        "permissions:",
        '  deny: ["Bash(rm -rf:*)"]',
        "locks:",
        "  - permissions.deny",
        "policy:",
        "  mcp: exclusive",
        "",
      ].join("\n"),
    );
    const seam = admin({
      os: "linux",
      strict: () => false,
      mdmPolicy: async () => undefined,
      remoteSettingsFile: join(root, "remote-settings.json"),
      confirm: async () => true,
    });
    const run = (argv: string[]) =>
      zz(argv, { cwd: root, home, env: { HOME: user() }, managed: seam });
    const built = await run([
      "managed",
      "build",
      "--os",
      "linux",
      "--out",
      "bundle",
    ]);
    expect(built.code, built.stderr).toBe(0);
    const installed = await run([
      "managed",
      "install",
      join(root, "bundle"),
      "--yes",
    ]);
    expect(installed.code, installed.stderr).toBe(0);
    const mcp = join(managedRoot(), "managed-mcp.json");
    const before = read(mcp);
    // The old install listed the same file.
    put(
      join(managedRoot(), "zzpersona/manifest.json"),
      JSON.stringify({
        format: 1,
        zzpersona: "0.12.0",
        files: {
          "managed-mcp.json": "sha256:a",
          "managed-settings.d/50-zzpersona.json": "sha256:b",
        },
      }),
    );
    put(join(managedRoot(), "managed-settings.d/50-zzpersona.json"), "{}");
    const r = await run(["migrate", "--managed", "--yes", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json(r).removed).toEqual([
      "managed-settings.d/50-zzpersona.json",
      "zzpersona/manifest.json",
    ]);
    expect(read(mcp)).toBe(before);
    const check = await run(["managed", "check", "--json"]);
    expect(json(check).state, check.stdout).toBe("current");
  });

  it("needs administrator rights, asks first and refuses unsafe folders", async () => {
    const m = machine();
    oldPolicy();
    const noAdmin = await donn(m, ["migrate", "--managed", "--json"], {
      managed: { root: managedRoot(), isAdmin: () => false },
    });
    expect(json(noAdmin).error).toMatchObject({
      code: "managed-needs-admin",
      message: expect.stringContaining("sudo donn migrate --managed"),
    });
    const declined = await donn(m, ["migrate", "--managed"], {
      managed: admin({ confirm: async () => false }),
    });
    expect(declined.code).toBe(1);
    expect(existsSync(join(managedRoot(), "managed-mcp.json"))).toBe(true);

    rmSync(join(managedRoot(), "zzpersona"), { recursive: true });
    mkdirSync(join(root, "real"));
    put(
      join(root, "real/manifest.json"),
      JSON.stringify({ format: 1, files: { "managed-mcp.json": "x" } }),
    );
    symlinkSync(join(root, "real"), join(managedRoot(), "zzpersona"));
    const unsafe = await donn(m, ["migrate", "--managed", "--yes", "--json"], {
      managed: admin(),
    });
    expect(unsafe.code).toBe(1);
    expect(json(unsafe).error.code).toBe("managed-unsafe");
    expect(existsSync(join(managedRoot(), "managed-mcp.json"))).toBe(true);
  });

  it("refuses a manifest that lists a file the old name never installed", async () => {
    const m = machine();
    const r0 = managedRoot();
    put(
      join(r0, "zzpersona/manifest.json"),
      JSON.stringify({
        format: 1,
        files: { "managed-settings.json": "x" },
      }),
    );
    put(join(r0, "managed-settings.json"), "{}");
    const r = await donn(m, ["migrate", "--managed", "--yes", "--json"], {
      managed: admin(),
    });
    expect(r.code).toBe(1);
    expect(json(r).error.code).toBe("managed-bad-installed");
    expect(existsSync(join(r0, "managed-settings.json"))).toBe(true);
  });
});
