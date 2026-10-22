import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ActivationPlan } from "@zzpersona/adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliVersion } from "./commands/daemon.js";
import { daemonPaths } from "./daemon/paths.js";
import { serviceManager } from "./daemon/service.js";
import { startDaemon, type Daemon } from "./daemon/server.js";
import { seed, zz, type Seeded } from "./test/seed.js";

let s: Seeded;
let daemons: Daemon[];
beforeEach(() => {
  s = seed();
  // Fixture 002's one secret resolves from the environment.
  const file = join(s.personas, "org/base.yaml");
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      "vault: { type: hashicorp-vault, address: https://vault.corp }",
      "vault: { type: env }",
    ),
  );
  daemons = [];
});
afterEach(async () => {
  await Promise.all(daemons.map((d) => d.close()));
  s.cleanup();
});

// The test helper sets ZZPERSONA_NO_DAEMON=1 by default; these tests opt back in.
const ON = {
  ZZPERSONA_NO_DAEMON: "",
  "payments/schema-token": "tok-value",
};
const FAILURE = (reason: string) =>
  `zzpersona: daemon not started (${reason}); live refresh is off for this session\n`;

async function inProcessDaemon(version = cliVersion()) {
  const daemon = await startDaemon({
    home: s.home,
    env: {},
    version,
  });
  daemons.push(daemon);
  return daemon;
}

/** A launch whose runPlan and spawnDaemon append to one event log. */
function harness(
  spawn: (home: string) => Promise<void> = async () =>
    void (await inProcessDaemon()),
) {
  const events: string[] = [];
  return {
    events,
    runPlan: async (_plan: ActivationPlan) => {
      events.push("run");
      return 3;
    },
    spawnDaemon: async (home: string) => {
      events.push("spawn");
      await spawn(home);
    },
  };
}

const options = (h: ReturnType<typeof harness>, env = {}) => ({
  cwd: s.repo,
  home: s.home,
  env: { ...ON, ...env },
  runPlan: h.runPlan,
  spawnDaemon: h.spawnDaemon,
});

describe("auto-start", () => {
  it("starts the daemon before the launch", async () => {
    const h = harness();
    const r = await zz(["claude"], options(h));
    expect(h.events).toEqual(["spawn", "run"]);
    expect(r.code).toBe(3);
    expect(r.stderr).not.toContain("daemon not started");
  });

  it("leaves a running daemon alone", async () => {
    await inProcessDaemon();
    const h = harness();
    await zz(["claude"], options(h));
    expect(h.events).toEqual(["run"]);
  });

  it("is skipped for --dry-run, --json, autoStart: false and ZZPERSONA_NO_DAEMON=1", async () => {
    const h = harness();
    await zz(["claude", "--dry-run"], options(h));
    await zz(["claude", "--json"], options(h));
    await zz(["claude"], options(h, { ZZPERSONA_NO_DAEMON: "1" }));
    expect(h.events).toEqual(["run"]);
    writeFileSync(
      `${s.home}/config.yaml`,
      `personas: ${s.personas}\ndaemon:\n  autoStart: false\n`,
    );
    await zz(["claude"], options(h));
    expect(h.events).toEqual(["run", "run"]);
  });

  it("uses the service when installed", async () => {
    const h = harness();
    const manager = serviceManager({
      env: { HOME: s.root },
      probe: {
        platform: "darwin",
        run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        readFile: async () => undefined,
        listDir: async () => undefined,
      },
    })!;
    // The service file serves this home, so start() is the service manager's, not a spawn.
    mkdirSync(dirname(manager.path), { recursive: true });
    writeFileSync(
      manager.path,
      manager.render({
        command: ["/u/bin/zzpersona", "daemon", "run"],
        env: { ZZPERSONA_HOME: s.home, ZZPERSONA_SERVICE: "1" },
        log: daemonPaths(s.home).log,
      }),
    );
    let started = 0;
    const service = {
      ...manager,
      start: async () => {
        started++;
        await inProcessDaemon();
      },
    };
    await zz(["claude"], {
      ...options(h, { HOME: s.root }),
      service,
    });
    expect(started).toBe(1);
    expect(h.events).toEqual(["run"]);
  });

  it("a daemon of another version is told to reinstall when the service serves this home", async () => {
    await inProcessDaemon("0.0.1");
    const h = harness();
    const mismatch = `daemon runs 0.0.1, CLI is ${cliVersion()}`;
    const plain = await zz(["claude"], options(h));
    expect(plain.stderr).toContain(
      `${mismatch}; zzpersona daemon stop && zzpersona daemon start\n`,
    );

    const manager = serviceManager({
      env: { HOME: s.root },
      probe: {
        platform: "darwin",
        run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        readFile: async () => undefined,
        listDir: async () => undefined,
      },
    })!;
    mkdirSync(dirname(manager.path), { recursive: true });
    writeFileSync(
      manager.path,
      manager.render({
        command: ["/u/bin/zzpersona", "daemon", "run"],
        env: { ZZPERSONA_HOME: s.home, ZZPERSONA_SERVICE: "1" },
        log: daemonPaths(s.home).log,
      }),
    );
    const r = await zz(["claude"], {
      ...options(h, { HOME: s.root }),
      service: manager,
    });
    expect(r.stderr).toContain(`${mismatch}; zzpersona daemon install\n`);
  });

  it("a failed start still launches", async () => {
    const h = harness(async () => {
      throw new Error("no such binary");
    });
    const r = await zz(["claude"], options(h));
    expect(h.events).toEqual(["spawn", "run"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain(FAILURE("no such binary"));
  });

  it("a refusing daemon does not stop a launch", async () => {
    const daemon = await inProcessDaemon();
    writeFileSync(daemonPaths(s.home).token, "0".repeat(64));
    const h = harness();
    const r = await zz(["claude"], options(h));
    expect(daemon.socket).toBeTruthy();
    expect(h.events).toEqual(["run"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(
      /^zzpersona: daemon not started \(.+\); live refresh is off for this session$/m,
    );
  });

  it("waits no more than 1 s", async () => {
    const h = harness(async () => {});
    const began = Date.now();
    const r = await zz(["claude"], options(h));
    expect(Date.now() - began).toBeLessThan(1500);
    expect(h.events).toEqual(["spawn", "run"]);
    expect(r.stderr).toContain(FAILURE("did not answer within 1 s"));
  });

  it("a start that never settles still launches within 1.5 s", async () => {
    const h = harness(() => new Promise<void>(() => {}));
    const began = Date.now();
    const r = await zz(["claude"], options(h));
    expect(Date.now() - began).toBeLessThan(1500);
    expect(h.events).toEqual(["spawn", "run"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain(FAILURE("did not answer within 1 s"));
  });

  it("codex starts it too", async () => {
    const h = harness();
    await zz(["codex"], options(h));
    expect(h.events).toEqual(["spawn", "run"]);
  });
});

describe("config daemon key", () => {
  it("rejects an unknown daemon key", async () => {
    writeFileSync(
      `${s.home}/config.yaml`,
      `personas: ${s.personas}\ndaemon:\n  autostart: true\n`,
    );
    const r = await zz(["resolve", "--json"], { cwd: s.repo, home: s.home });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("invalid-config");
  });
});
