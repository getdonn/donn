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

/** A probe that records each command line and fails the ones `fails` names. */
function fakeProbe(
  platform: Platform,
  fails: (call: string) => boolean = () => false,
) {
  const calls: string[] = [];
  const probe: Probe = {
    platform,
    run: async (command, args) => {
      const call = [command, ...args].join(" ");
      calls.push(call);
      return fails(call)
        ? { exitCode: 5, stdout: "", stderr: `${command} said no\n` }
        : { exitCode: 0, stdout: "", stderr: "" };
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

/** Write a service file as `install` would, without loading anything. */
function writeServiceFile(manager: ServiceManager, command: string) {
  mkdirSync(dirname(manager.path), { recursive: true });
  writeFileSync(
    manager.path,
    manager.render({ ...SPEC, command: [command, "daemon", "run"] }),
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
      `launchctl bootstrap gui/${uid} ${plist}`,
    ];
    expect(calls).toEqual([
      ...install,
      ...install,
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
      "systemctl --user start zzpersona-daemon.service",
      "systemctl --user is-enabled zzpersona-daemon.service",
      "systemctl --user disable --now zzpersona-daemon.service",
      "systemctl --user daemon-reload",
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
    expect(calls).toHaveLength(2);
  });

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
    expect(calls).toEqual([]);

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
