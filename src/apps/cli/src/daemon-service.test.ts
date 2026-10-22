import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Platform, Probe } from "@zzpersona/adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliVersion } from "./commands/daemon.js";
import { CliError } from "./errors.js";
import { connectDaemon } from "./daemon/client.js";
import { daemonPaths } from "./daemon/paths.js";
import { startDaemon, type Daemon } from "./daemon/server.js";
import {
  installedCommand,
  serviceManager,
  type ServiceManager,
  type ServiceSpec,
} from "./daemon/service.js";
import { seed, zz } from "./test/seed.js";

// zzpersona daemon install|uninstall, and the service seen from start, run, status and doctor.
// launchctl and systemctl are never run: a fake probe records the calls. See
// docs/planning/16-daemon-service.md §1.

const GOLDEN = join(import.meta.dirname, "../test/golden/service");
const uid = process.getuid!();

const SPEC: ServiceSpec = {
  command: ["/u/bin/zzpersona", "daemon", "run"],
  env: {
    PATH: "/u/bin:/usr/bin",
    ZZPERSONA_HOME: "/h",
    ZZPERSONA_SERVICE: "1",
  },
  log: "/h/daemon/daemon.log",
};

let root: string;
let daemons: Daemon[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zzp-service-"));
  daemons = [];
});
afterEach(async () => {
  await Promise.all(daemons.map((d) => d.close()));
  rmSync(root, { recursive: true, force: true });
});

/**
 * A probe that records each command line and fails the ones `fails` names. Like launchctl,
 * `print` finds the job between a `bootstrap` and a `bootout`.
 */
function fakeProbe(
  platform: Platform,
  fails: (call: string) => boolean = () => false,
) {
  const calls: string[] = [];
  let loaded = false;
  const probe: Probe = {
    platform,
    run: async (command, args) => {
      const call = [command, ...args].join(" ");
      calls.push(call);
      if (fails(call))
        return { exitCode: 5, stdout: "", stderr: `${command} said no\n` };
      if (command === "launchctl" && args[0] === "bootout") loaded = false;
      if (command === "launchctl" && args[0] === "bootstrap") loaded = true;
      if (command === "launchctl" && args[0] === "print" && !loaded)
        return { exitCode: 113, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readFile: async () => undefined,
    listDir: async () => undefined,
  };
  return { calls, probe };
}

const userHome = () => join(root, "user");
const zzHome = () => join(root, "zz");

function launchd(env: NodeJS.ProcessEnv = {}) {
  const fake = fakeProbe("darwin");
  const manager = serviceManager({
    env: { HOME: userHome(), ...env },
    probe: fake.probe,
  })!;
  return { ...fake, manager };
}

/** A folder holding an executable `zzpersona`, for PATH. */
function binWithCli(): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "zzpersona"), "#!/bin/sh\n");
  chmodSync(join(bin, "zzpersona"), 0o755);
  return bin;
}

/**
 * Write a service file as `install` would, without loading anything; it serves `home`, or with
 * `null` the default home (no ZZPERSONA_HOME).
 */
function writeServiceFile(
  manager: ServiceManager,
  command: string,
  home: string | null = zzHome(),
) {
  mkdirSync(dirname(manager.path), { recursive: true });
  const { ZZPERSONA_HOME: _, ...env } = SPEC.env;
  writeFileSync(
    manager.path,
    manager.render({
      ...SPEC,
      command: [command, "daemon", "run"],
      env: home === null ? env : { ...env, ZZPERSONA_HOME: home },
    }),
  );
}

async function inProcessDaemon(
  home: string,
  env: NodeJS.ProcessEnv = {},
  version = cliVersion(),
) {
  const daemon = await startDaemon({ home, env, version });
  daemons.push(daemon);
  return daemon;
}

describe("the service files", () => {
  it("renders the plist", () => {
    expect(launchd().manager.render(SPEC)).toBe(
      readFileSync(join(GOLDEN, "zzpersona.daemon.plist"), "utf8"),
    );
  });

  it("renders the unit", () => {
    const manager = serviceManager({
      env: { HOME: userHome() },
      probe: fakeProbe("linux").probe,
    })!;
    expect(manager.render(SPEC)).toBe(
      readFileSync(join(GOLDEN, "zzpersona-daemon.service"), "utf8"),
    );
  });

  it("escapes values", async () => {
    const odd = '/a b&<c>:%x"y';
    const spec: ServiceSpec = {
      ...SPEC,
      command: [`${odd}/zzpersona`, "daemon", "run"],
      env: { ...SPEC.env, PATH: odd },
    };
    const mac = launchd().manager;
    expect(mac.render(spec)).toContain(
      '<string>/a b&amp;&lt;c&gt;:%x"y</string>',
    );
    await mac.install(spec);
    expect(await installedCommand(mac)).toBe(`${odd}/zzpersona`);

    const linux = serviceManager({
      env: { HOME: userHome() },
      probe: fakeProbe("linux").probe,
    })!;
    const unit = linux.render(spec);
    expect(unit).toContain('Environment="PATH=/a b&<c>:%%x\\"y"');
    expect(unit).toContain('ExecStart="/a b&<c>:%%x\\"y/zzpersona" daemon run');
    await linux.install(spec);
    expect(await installedCommand(linux)).toBe(`${odd}/zzpersona`);
  });
});

describe("the service managers", () => {
  it("installs, reinstalls and uninstalls through launchctl", async () => {
    const { calls, manager } = launchd();
    const plist = join(
      userHome(),
      "Library/LaunchAgents/zzpersona.daemon.plist",
    );
    expect(manager).toMatchObject({
      kind: "launchd",
      label: "zzpersona.daemon",
      path: plist,
    });
    expect(await installedCommand(manager)).toBeUndefined();

    await manager.install(SPEC);
    await manager.install(SPEC);
    expect(readFileSync(plist, "utf8")).toBe(manager.render(SPEC));
    expect(statSync(plist).mode & 0o777).toBe(0o644);
    expect(await installedCommand(manager)).toBe("/u/bin/zzpersona");
    await manager.start();
    expect(await manager.loaded()).toBe(true);
    await manager.uninstall();
    expect(existsSync(plist)).toBe(false);

    const install = [
      `launchctl bootout gui/${uid}/zzpersona.daemon`,
      `launchctl print gui/${uid}/zzpersona.daemon`,
      `launchctl bootstrap gui/${uid} ${plist}`,
    ];
    expect(calls).toEqual([
      ...install,
      ...install,
      `launchctl print gui/${uid}/zzpersona.daemon`,
      `launchctl kickstart gui/${uid}/zzpersona.daemon`,
      `launchctl print gui/${uid}/zzpersona.daemon`,
      `launchctl bootout gui/${uid}/zzpersona.daemon`,
    ]);
  });

  it("installs, reinstalls and uninstalls through systemctl", async () => {
    const { calls, probe } = fakeProbe("linux");
    const config = join(root, "xdg");
    const manager = serviceManager({
      env: { HOME: userHome(), XDG_CONFIG_HOME: config },
      probe,
    })!;
    const unit = join(config, "systemd/user/zzpersona-daemon.service");
    expect(manager).toMatchObject({ kind: "systemd", path: unit });

    await manager.install(SPEC);
    await manager.install(SPEC);
    expect(readFileSync(unit, "utf8")).toBe(manager.render(SPEC));
    expect(statSync(unit).mode & 0o777).toBe(0o644);
    await manager.start();
    expect(await manager.loaded()).toBe(true);
    await manager.uninstall();
    expect(existsSync(unit)).toBe(false);

    const install = [
      "systemctl --user disable --now zzpersona-daemon.service",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now zzpersona-daemon.service",
    ];
    expect(calls).toEqual([
      ...install,
      ...install,
      "systemctl --user is-enabled zzpersona-daemon.service",
      "systemctl --user start zzpersona-daemon.service",
      "systemctl --user is-enabled zzpersona-daemon.service",
      "systemctl --user disable --now zzpersona-daemon.service",
      "systemctl --user daemon-reload",
    ]);
  });

  it("start loads a service that is not loaded", async () => {
    const mac = launchd();
    writeServiceFile(mac.manager, "/u/bin/zzpersona");
    await mac.manager.start();
    expect(mac.calls).toEqual([
      `launchctl print gui/${uid}/zzpersona.daemon`,
      `launchctl bootstrap gui/${uid} ${mac.manager.path}`,
    ]);

    const { calls, probe } = fakeProbe("linux", (call) =>
      call.includes("is-enabled"),
    );
    const linux = serviceManager({ env: { HOME: userHome() }, probe })!;
    await linux.start();
    expect(calls).toEqual([
      "systemctl --user is-enabled zzpersona-daemon.service",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now zzpersona-daemon.service",
    ]);
  });

  it("puts the unit under ~/.config without XDG_CONFIG_HOME", () => {
    const manager = serviceManager({
      env: { HOME: userHome() },
      probe: fakeProbe("linux").probe,
    })!;
    expect(manager.path).toBe(
      join(userHome(), ".config/systemd/user/zzpersona-daemon.service"),
    );
  });

  it("takes a test-only label", () => {
    const mac = launchd({ ZZPERSONA_SERVICE_LABEL: "zzpersona.daemon.e2e-1" });
    expect(mac.manager.label).toBe("zzpersona.daemon.e2e-1");
    expect(mac.manager.path).toBe(
      join(userHome(), "Library/LaunchAgents/zzpersona.daemon.e2e-1.plist"),
    );
    const linux = serviceManager({
      env: { HOME: userHome(), ZZPERSONA_SERVICE_LABEL: "zz-e2e" },
      probe: fakeProbe("linux").probe,
    })!;
    expect(linux.path).toBe(
      join(userHome(), ".config/systemd/user/zz-e2e.service"),
    );
  });

  it("reinstalls over a broken service", async () => {
    const { calls, probe } = fakeProbe("darwin", (call) =>
      call.includes("bootout"),
    );
    const manager = serviceManager({ env: { HOME: userHome() }, probe })!;
    await manager.install(SPEC);
    expect(calls).toHaveLength(3);
  });

  it("waits for launchd to let go of the old job before bootstrapping", async () => {
    const calls: string[] = [];
    let prints = 0;
    const probe: Probe = {
      ...fakeProbe("darwin").probe,
      run: async (command, args) => {
        calls.push(args[0]!);
        const still = args[0] === "print" && ++prints <= 2;
        return {
          exitCode: args[0] === "print" && !still ? 113 : 0,
          stdout: "",
          stderr: "",
        };
      },
    };
    const manager = serviceManager({ env: { HOME: userHome() }, probe })!;
    await manager.install(SPEC);
    expect(calls).toEqual(["bootout", "print", "print", "print", "bootstrap"]);
  });

  it("bootstraps anyway once launchd has not let go within the wait", async () => {
    const calls: string[] = [];
    const probe: Probe = {
      ...fakeProbe("darwin").probe,
      // `print` always finds the job: it never goes.
      run: async (_command, args) => {
        calls.push(args[0]!);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const manager = serviceManager(
      { env: { HOME: userHome() }, probe },
      { unloadWaitMs: 100 },
    )!;
    const began = Date.now();
    await manager.install(SPEC);
    expect(Date.now() - began).toBeGreaterThanOrEqual(100);
    expect(calls[0]).toBe("bootout");
    expect(calls.at(-1)).toBe("bootstrap");
    expect(calls.filter((call) => call === "print").length).toBeGreaterThan(1);
  }, 2_000);

  it("fails with the manager's stderr when loading fails", async () => {
    const { probe } = fakeProbe("darwin", (call) => call.includes("bootstrap"));
    const manager = serviceManager({ env: { HOME: userHome() }, probe })!;
    await expect(manager.install(SPEC)).rejects.toMatchObject({
      code: "service",
      message: expect.stringContaining("launchctl said no"),
    });
    await expect(
      serviceManager({
        env: { HOME: userHome() },
        probe: fakeProbe("darwin", () => true).probe,
      })!.start(),
    ).rejects.toMatchObject({ code: "service" });
  });

  it("a failed install removes the file it wrote", async () => {
    const mac = serviceManager({
      env: { HOME: userHome() },
      probe: fakeProbe("darwin", (call) => call.includes("bootstrap")).probe,
    })!;
    await expect(mac.install(SPEC)).rejects.toMatchObject({ code: "service" });
    expect(existsSync(mac.path)).toBe(false);

    // Linux without a user systemd (WSL, containers, SSH): daemon-reload fails.
    const linux = serviceManager({
      env: { HOME: userHome() },
      probe: fakeProbe("linux", (call) => call.includes("daemon-reload")).probe,
    })!;
    await expect(linux.install(SPEC)).rejects.toMatchObject({
      code: "service",
      message: expect.stringContaining("systemctl said no"),
    });
    expect(existsSync(linux.path)).toBe(false);
  });

  it("a failed reinstall puts the working file back and loads it again", async () => {
    const next: ServiceSpec = {
      ...SPEC,
      command: ["/new/bin/zzpersona", "daemon", "run"],
    };
    for (const [platform, step] of [
      ["darwin", "bootstrap"],
      ["linux", "enable"],
    ] as const) {
      let failing = false;
      const { calls, probe } = fakeProbe(
        platform,
        (call) => failing && call.includes(step),
      );
      const manager = serviceManager({ env: { HOME: userHome() }, probe })!;
      await manager.install(SPEC);
      failing = true;
      calls.length = 0;
      await expect(manager.install(next)).rejects.toMatchObject({
        code: "service",
        message: expect.stringContaining("said no"),
      });
      expect(readFileSync(manager.path, "utf8")).toBe(manager.render(SPEC));
      expect(statSync(manager.path).mode & 0o777).toBe(0o644);
      // Loaded twice: the new file, then the old one put back.
      expect(calls.filter((call) => call.includes(step))).toHaveLength(2);
      rmSync(manager.path);
    }
  });

  it("uninstall ignores a failing reload once the file is gone", async () => {
    const linux = serviceManager({
      env: { HOME: userHome() },
      probe: fakeProbe("linux", (call) => call.includes("daemon-reload")).probe,
    })!;
    writeServiceFile(linux, "/u/bin/zzpersona");
    await linux.uninstall();
    expect(existsSync(linux.path)).toBe(false);
  });

  it("has no manager on Windows", () => {
    expect(
      serviceManager({
        env: { HOME: userHome() },
        probe: fakeProbe("win32").probe,
      }),
    ).toBeUndefined();
  });
});

describe("zzpersona daemon install|uninstall", () => {
  const json = (r: { stdout: string }) => JSON.parse(r.stdout);

  it("daemon install refuses without zzpersona on PATH", async () => {
    const r = await zz(["daemon", "install", "--json"], {
      cwd: root,
      home: zzHome(),
      env: { HOME: userHome(), PATH: join(root, "empty") },
      probe: fakeProbe("darwin").probe,
    });
    expect(r.code).toBe(1);
    expect(json(r).error.code).toBe("cli-not-on-path");
    expect(json(r).error.message).toContain("pnpm add --global");
    expect(existsSync(launchd().manager.path)).toBe(false);
  });

  it("daemon install stops a detached daemon first, then waits for the socket", async () => {
    const bin = binWithCli();
    const base = launchd().manager;
    const specs: ServiceSpec[] = [];
    let stoppedFirst = false;
    const service: ServiceManager = {
      ...base,
      install: async (spec) => {
        stoppedFirst = (await connectDaemon(zzHome())) === undefined;
        specs.push(spec);
        writeServiceFile(base, spec.command[0]!);
        // The service's daemon comes up a little later, as launchd's would.
        setTimeout(
          () => void inProcessDaemon(zzHome(), { ZZPERSONA_SERVICE: "1" }),
          50,
        );
      },
    };
    const env = { HOME: userHome(), PATH: `${bin}:/usr/bin` };
    const options = {
      cwd: root,
      home: zzHome(),
      env,
      service,
      spawnDaemon: async (home: string) => void (await inProcessDaemon(home)),
    };
    expect((await zz(["daemon", "start"], options)).code).toBe(0);

    const r = await zz(["daemon", "install", "--json"], options);
    expect(r.code).toBe(0);
    expect(stoppedFirst).toBe(true);
    expect(specs).toEqual([
      {
        command: [join(bin, "zzpersona"), "daemon", "run"],
        env: {
          PATH: `${bin}:/usr/bin`,
          ZZPERSONA_HOME: zzHome(),
          ZZPERSONA_SERVICE: "1",
        },
        log: daemonPaths(zzHome()).log,
      },
    ]);
    expect(json(r)).toEqual({
      installed: true,
      path: base.path,
      command: join(bin, "zzpersona"),
      pid: process.pid,
    });

    const status = json(await zz(["daemon", "status", "--json"], options));
    expect(status.service).toEqual({
      installed: true,
      path: base.path,
      home: zzHome(),
      managed: true,
    });
  });

  it("leaves ZZPERSONA_HOME out of the file when it is not set", async () => {
    const bin = binWithCli();
    const base = launchd().manager;
    const specs: ServiceSpec[] = [];
    const service: ServiceManager = {
      ...base,
      install: async (spec) => {
        specs.push(spec);
        void inProcessDaemon(join(userHome(), ".zzpersona"));
      },
    };
    const r = await zz(["daemon", "install"], {
      cwd: root,
      env: { HOME: userHome(), PATH: bin },
      service,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      `service installed (${base.path}); daemon running (pid ${process.pid})\n`,
    );
    expect(specs[0]!.env).toEqual({ PATH: bin, ZZPERSONA_SERVICE: "1" });
  });

  it("writes a relative ZZPERSONA_HOME as an absolute path", async () => {
    const bin = binWithCli();
    const base = launchd().manager;
    const specs: ServiceSpec[] = [];
    const service: ServiceManager = {
      ...base,
      install: async (spec) => {
        specs.push(spec);
        await inProcessDaemon(join(root, "rel"), { ZZPERSONA_SERVICE: "1" });
      },
    };
    const r = await zz(["daemon", "install"], {
      cwd: root,
      env: { HOME: userHome(), PATH: bin, ZZPERSONA_HOME: "rel" },
      service,
    });
    expect(r.code).toBe(0);
    expect(specs[0]!.env.ZZPERSONA_HOME).toBe(join(root, "rel"));
    expect(specs[0]!.log).toBe(daemonPaths(join(root, "rel")).log);
  });

  it("fails when the service's daemon never answers", async () => {
    const bin = binWithCli();
    const base = launchd().manager;
    const r = await zz(["daemon", "install", "--json"], {
      cwd: root,
      home: zzHome(),
      env: { HOME: userHome(), PATH: bin },
      service: { ...base, install: async () => {} },
    });
    expect(r.code).toBe(1);
    expect(json(r).error.code).toBe("daemon-start");
  }, 10_000);

  it("names the journal when the systemd service's daemon never answers", async () => {
    const bin = binWithCli();
    const base = serviceManager({
      env: { HOME: userHome() },
      probe: fakeProbe("linux").probe,
    })!;
    const r = await zz(["daemon", "install", "--json"], {
      cwd: root,
      home: zzHome(),
      env: { HOME: userHome(), PATH: bin },
      service: { ...base, install: async () => {} },
    });
    expect(r.code).toBe(1);
    expect(json(r).error).toMatchObject({
      code: "daemon-start",
      message: expect.stringContaining("journalctl --user -u zzpersona-daemon"),
    });
  }, 10_000);

  it("daemon start falls back to a detached daemon when the service will not start", async () => {
    const base = launchd().manager;
    writeServiceFile(base, "/u/bin/zzpersona");
    let spawned = 0;
    const refused = async () => {
      throw new CliError("service", "systemctl --user start failed: no bus");
    };
    const r = await zz(["daemon", "start", "--json"], {
      cwd: root,
      home: zzHome(),
      env: { HOME: userHome() },
      service: { ...base, start: refused },
      spawnDaemon: async (home) => {
        spawned++;
        await inProcessDaemon(home);
      },
    });
    expect(r.code).toBe(0);
    expect(spawned).toBe(1);
    expect(json(r)).toMatchObject({ running: true, already: false });

    // The service's error shows only when the fallback fails too.
    writeServiceFile(base, "/u/bin/zzpersona", join(root, "other"));
    const both = await zz(["daemon", "start", "--json"], {
      cwd: root,
      home: join(root, "other"),
      env: { HOME: userHome() },
      service: { ...base, start: refused },
      spawnDaemon: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(both.code).toBe(1);
    expect(json(both).error).toMatchObject({
      code: "service",
      message: expect.stringContaining("no bus"),
    });
  });

  it("daemon uninstall removes the file, or says it is not installed", async () => {
    const { calls, probe, manager } = launchd();
    const options = {
      cwd: root,
      home: zzHome(),
      env: { HOME: userHome() },
      probe,
    };
    const none = await zz(["daemon", "uninstall"], options);
    expect(none).toMatchObject({ code: 0, stdout: "not installed\n" });
    // Only asked whether a job is loaded without its file.
    expect(calls).toEqual([`launchctl print gui/${uid}/zzpersona.daemon`]);
    calls.length = 0;

    writeServiceFile(manager, "/u/bin/zzpersona");
    const r = await zz(["daemon", "uninstall", "--json"], options);
    expect(r.code).toBe(0);
    expect(json(r)).toEqual({
      installed: false,
      removed: true,
      path: manager.path,
    });
    expect(existsSync(manager.path)).toBe(false);
    expect(calls).toEqual([`launchctl bootout gui/${uid}/zzpersona.daemon`]);
  });

  it("daemon install and uninstall say when the service served another home", async () => {
    const bin = binWithCli();
    const base = launchd().manager;
    const other = join(root, "other");
    const service: ServiceManager = {
      ...base,
      install: async (spec) => {
        writeServiceFile(base, spec.command[0]!);
        await inProcessDaemon(zzHome(), { ZZPERSONA_SERVICE: "1" });
      },
      uninstall: async () => rmSync(base.path),
    };
    const options = {
      cwd: root,
      home: zzHome(),
      env: { HOME: userHome(), PATH: bin },
      service,
    };

    writeServiceFile(base, "/u/bin/zzpersona", other);
    const r = await zz(["daemon", "install"], options);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      `replacing the service for ${other}\n` +
        `service installed (${base.path}); daemon running (pid ${process.pid})\n`,
    );
    await Promise.all(daemons.splice(0).map((d) => d.close()));

    writeServiceFile(base, "/u/bin/zzpersona", other);
    const j = await zz(["daemon", "install", "--json"], options);
    expect(JSON.parse(j.stdout)).toMatchObject({
      installed: true,
      replaced: other,
    });
    await Promise.all(daemons.splice(0).map((d) => d.close()));

    // This home's own service is no other's: nothing said.
    const same = await zz(["daemon", "install", "--json"], options);
    expect(JSON.parse(same.stdout).replaced).toBeUndefined();
    await Promise.all(daemons.splice(0).map((d) => d.close()));

    writeServiceFile(base, "/u/bin/zzpersona", other);
    const u = await zz(["daemon", "uninstall"], options);
    expect(u.stdout).toBe(
      `removing the service for ${other}\nservice uninstalled (${base.path})\n`,
    );
    writeServiceFile(base, "/u/bin/zzpersona", other);
    const uj = await zz(["daemon", "uninstall", "--json"], options);
    expect(JSON.parse(uj.stdout)).toEqual({
      installed: false,
      removed: true,
      replaced: other,
      path: base.path,
    });
  });

  it("daemon uninstall unloads a job whose file is gone", async () => {
    const { calls, probe, manager } = launchd();
    // Loaded, then its file removed by hand: launchd still runs the job.
    await probe.run("launchctl", ["bootstrap", `gui/${uid}`, manager.path]);
    calls.length = 0;
    const options = {
      cwd: root,
      home: zzHome(),
      env: { HOME: userHome() },
      probe,
    };
    const r = await zz(["daemon", "uninstall"], options);
    expect(r).toMatchObject({
      code: 0,
      stdout: `service unloaded (zzpersona.daemon); its file was already gone\n`,
    });
    expect(calls).toEqual([
      `launchctl print gui/${uid}/zzpersona.daemon`,
      `launchctl bootout gui/${uid}/zzpersona.daemon`,
    ]);
    expect(await manager.loaded()).toBe(false);

    await probe.run("launchctl", ["bootstrap", `gui/${uid}`, manager.path]);
    const json = await zz(["daemon", "uninstall", "--json"], options);
    expect(JSON.parse(json.stdout)).toEqual({
      installed: false,
      removed: false,
      unloaded: true,
      path: manager.path,
    });
  });

  it("daemon start uses the service when installed", async () => {
    const base = launchd().manager;
    writeServiceFile(base, "/u/bin/zzpersona");
    let started = 0;
    const r = await zz(["daemon", "start", "--json"], {
      cwd: root,
      home: zzHome(),
      env: { HOME: userHome() },
      service: {
        ...base,
        start: async () => {
          started++;
          await inProcessDaemon(zzHome(), { ZZPERSONA_SERVICE: "1" });
        },
      },
      spawnDaemon: async () => {
        throw new Error("spawned");
      },
    });
    expect(r.code).toBe(0);
    expect(started).toBe(1);
    expect(json(r)).toMatchObject({ running: true, already: false });
  });

  it("daemon start uses the service only for the home it serves", async () => {
    const base = launchd().manager;
    let started = 0;
    let spawned = 0;
    const start = (home?: string) =>
      zz(["daemon", "start"], {
        cwd: root,
        ...(home && { home }),
        env: { HOME: userHome() },
        service: {
          ...base,
          start: async () => {
            started++;
            await inProcessDaemon(home ?? join(userHome(), ".zzpersona"));
          },
        },
        spawnDaemon: async (h) => {
          spawned++;
          await inProcessDaemon(h);
        },
      });

    writeServiceFile(base, "/u/bin/zzpersona", join(root, "a"));
    expect((await start(join(root, "b"))).code).toBe(0);
    expect({ started, spawned }).toEqual({ started: 0, spawned: 1 });

    // Another spelling of the home the file serves is the same home.
    expect((await start(`${join(root, "a")}/`)).code).toBe(0);
    expect({ started, spawned }).toEqual({ started: 1, spawned: 1 });
    await Promise.all(daemons.splice(0).map((d) => d.close()));
    started = 0;

    // No ZZPERSONA_HOME in the file: it serves the default home.
    writeServiceFile(base, "/u/bin/zzpersona", null);
    expect((await start()).code).toBe(0);
    expect({ started, spawned }).toEqual({ started: 1, spawned: 1 });
    expect((await start(join(root, "c"))).code).toBe(0);
    expect({ started, spawned }).toEqual({ started: 1, spawned: 2 });
  });

  it("Windows is refused", async () => {
    for (const command of ["install", "uninstall"]) {
      const r = await zz(["daemon", command, "--json"], {
        cwd: root,
        home: zzHome(),
        env: { HOME: userHome(), PATH: binWithCli() },
        probe: fakeProbe("win32").probe,
      });
      expect(r.code).toBe(1);
      expect(json(r).error).toEqual({
        code: "service-unsupported",
        message: "the daemon service is not supported on Windows yet",
      });
    }
  });
});

describe("the service elsewhere", () => {
  it("status and doctor leave another home's service alone", async () => {
    const base = launchd().manager;
    const service: ServiceManager = { ...base, loaded: async () => false };
    const other = join(root, "other");
    writeServiceFile(base, join(root, "gone/zzpersona"), other);
    const r = await zz(["daemon", "status"], {
      cwd: root,
      home: zzHome(),
      service,
    });
    expect(r.stdout).toBe(
      `daemon not running\nservice: installed (${base.path}) for ${other}\n`,
    );

    await inProcessDaemon(zzHome(), {}, "0.0.1");
    const s = seed();
    try {
      const d = await zz(["doctor", "--json"], {
        cwd: s.repo,
        home: zzHome(),
        service,
      });
      expect(
        (
          JSON.parse(d.stdout) as {
            checks: { id: string; fix?: string }[];
          }
        ).checks.find((c) => c.id === "daemon"),
      ).toMatchObject({
        status: "warn",
        fix: "zzpersona daemon stop && zzpersona daemon start",
      });
    } finally {
      s.cleanup();
    }
  });

  it("already running exits 0 under the service", async () => {
    await inProcessDaemon(zzHome());
    const run = (env: NodeJS.ProcessEnv) =>
      zz(["daemon", "run", "--json"], { cwd: root, home: zzHome(), env });
    const service = await run({ ZZPERSONA_SERVICE: "1" });
    expect(service.code).toBe(0);
    expect(JSON.parse(service.stdout)).toEqual({
      running: true,
      already: true,
    });
    const plain = await run({});
    expect(plain.code).toBe(1);
    expect(plain.stdout).toContain("daemon-running");
  });

  it("the daemon reports whether it is the service's", async () => {
    await inProcessDaemon(zzHome(), { ZZPERSONA_SERVICE: "1" });
    await inProcessDaemon(join(root, "other"));
    const service = async (home: string) =>
      (await (await connectDaemon(home))!.status()).service;
    expect(await service(zzHome())).toBe(true);
    expect(await service(join(root, "other"))).toBe(false);
  });

  it("status and doctor report the service", async () => {
    const base = launchd().manager;
    const loaded = { value: true };
    const service: ServiceManager = {
      ...base,
      loaded: async () => loaded.value,
    };
    const status = (json: boolean) =>
      zz(["daemon", "status", ...(json ? ["--json"] : [])], {
        cwd: root,
        home: zzHome(),
        service,
      });

    expect((await status(false)).stdout).toBe(
      "daemon not running\nservice: not installed\n",
    );
    expect(JSON.parse((await status(true)).stdout)).toEqual({
      running: false,
      service: { installed: false, path: base.path, managed: false },
    });

    writeServiceFile(base, process.execPath);
    await inProcessDaemon(zzHome());
    expect((await status(false)).stdout).toContain(
      `service: installed (${base.path}); the running daemon was started outside it\n`,
    );
    expect(JSON.parse((await status(true)).stdout).service).toEqual({
      installed: true,
      path: base.path,
      home: zzHome(),
      managed: false,
    });

    const s = seed();
    try {
      const doctor = async () => {
        const r = await zz(["doctor", "--json"], {
          cwd: s.repo,
          home: zzHome(),
          service,
        });
        return (
          JSON.parse(r.stdout) as {
            checks: {
              id: string;
              status: string;
              message: string;
              fix?: string;
            }[];
          }
        ).checks.find((c) => c.id === "daemon")!;
      };
      expect(await doctor()).toMatchObject({ status: "ok" });

      loaded.value = false;
      expect(await doctor()).toEqual({
        id: "daemon",
        status: "warn",
        message: `the daemon service is installed but not loaded (${base.path})`,
        fix: "zzpersona daemon install",
      });

      loaded.value = true;
      writeServiceFile(base, join(root, "gone/zzpersona"));
      expect(await doctor()).toEqual({
        id: "daemon",
        status: "warn",
        message: `the daemon service runs ${join(root, "gone/zzpersona")}, which no longer exists`,
        fix: "zzpersona daemon install",
      });

      writeServiceFile(base, process.execPath);
      await Promise.all(daemons.splice(0).map((d) => d.close()));
      await inProcessDaemon(zzHome(), {}, "0.0.1");
      expect(await doctor()).toEqual({
        id: "daemon",
        status: "warn",
        message: `daemon runs 0.0.1, CLI is ${cliVersion()}`,
        fix: "zzpersona daemon install",
      });
    } finally {
      s.cleanup();
    }
  });
});
