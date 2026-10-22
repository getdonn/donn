import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliVersion } from "./commands/daemon.js";
import { connectDaemon, type DaemonStatus } from "./daemon/client.js";
import { daemonPaths } from "./daemon/paths.js";
import { startDaemon, type Daemon } from "./daemon/server.js";
import { zz } from "./test/seed.js";

let root: string;
let home: string;
let daemons: Daemon[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zzp-status-"));
  home = join(root, "home");
  daemons = [];
});
afterEach(async () => {
  await Promise.all(daemons.map((d) => d.close()));
  rmSync(root, { recursive: true, force: true });
});

async function start(version = cliVersion()) {
  const daemon = await startDaemon({ home, env: {}, version });
  daemons.push(daemon);
  return daemon;
}

/** A session this process owns, as `zzpersona claude` records it. */
function session(name: string, extra: object = {}) {
  const dir = join(home, "sessions", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "launched.json"),
    JSON.stringify({
      persona: "team/payments",
      source: "switch",
      pid: process.pid,
      project: "/repo",
      startedAt: "2026-10-21T00:00:00.000Z",
      ...extra,
    }),
  );
}

const NOT_RUNNING =
  "daemon not running: sessions are not refreshed on edits; zzpersona daemon start";

describe("zzpersona status", () => {
  it("prints the daemon's sessions", async () => {
    session("a");
    session("b", { persona: "org/base", project: undefined });
    await start();
    const r = await zz(["status"], { cwd: root, home });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe(`daemon ${cliVersion()} (pid ${process.pid})`);
    // A fake session has no build to refresh, so its state is the daemon's to name.
    expect(lines[1]).toMatch(/^claude-code  team\/payments  \S+  \/repo$/);
    expect(lines[2]).toMatch(/^claude-code  org\/base  \S+  -$/);
  });

  it("shows a swap as launched → live", async () => {
    session("a");
    writeFileSync(
      join(home, "sessions/a/live.json"),
      JSON.stringify({
        persona: "org/base",
        previous: "team/payments",
        launched: "team/payments",
        instructions: "x",
        held: [],
        stricter: false,
        plugin: "p",
        appliedAt: "2026-10-21T00:00:01.000Z",
      }),
    );
    await start();
    const r = await zz(["status"], { cwd: root, home });
    expect(r.stdout).toContain("team/payments → org/base");
  });

  it("prints the daemon's status plus daemon: true as JSON", async () => {
    session("a");
    await start();
    const r = await zz(["status", "--json"], { cwd: root, home });
    const out = JSON.parse(r.stdout) as DaemonStatus & { daemon: boolean };
    expect(out.daemon).toBe(true);
    expect(out.version).toBe(cliVersion());
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]).toMatchObject({ launched: "team/payments" });
  });

  it("lists sessions without state when no daemon runs", async () => {
    session("a");
    const r = await zz(["status"], { cwd: root, home });
    expect(r.code).toBe(0);
    expect(r.stdout.trimEnd().split("\n")).toEqual([
      NOT_RUNNING,
      "claude-code  team/payments  /repo",
    ]);
    const json = await zz(["status", "--json"], { cwd: root, home });
    const out = JSON.parse(json.stdout) as {
      daemon: boolean;
      sessions: { launched: string }[];
    };
    expect(out.daemon).toBe(false);
    expect(out.sessions).toMatchObject([{ launched: "team/payments" }]);
  });

  it("falls back when the socket is dead", async () => {
    const paths = daemonPaths(home);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.sock, "");
    writeFileSync(paths.token, "stale-token");
    const began = Date.now();
    const r = await zz(["status"], { cwd: root, home });
    expect(Date.now() - began).toBeLessThan(1000);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe(NOT_RUNNING);
  });

  it("re-reads a rotated token", async () => {
    const first = await start();
    const client = await connectDaemon(home);
    expect((await client!.status()).pid).toBe(process.pid);
    await first.close();
    const second = await start();
    expect(second.token).not.toBe(first.token);
    expect((await client!.status()).version).toBe(cliVersion());
  });

  it("warns once on a version mismatch", async () => {
    await start("0.0.1");
    const r = await zz(["status"], { cwd: root, home });
    expect(r.code).toBe(0);
    const warning = `daemon runs 0.0.1, CLI is ${cliVersion()}; zzpersona daemon stop && zzpersona daemon start`;
    expect(r.stderr).toBe(`${warning}\n`);
    expect(r.stdout.split("\n")[0]).toBe(
      "daemon 0.0.1 (pid " + process.pid + ")",
    );
  });
});

describe("zzpersona daemon refresh", () => {
  it("asks the daemon to refresh", async () => {
    await start();
    const r = await zz(["daemon", "refresh"], { cwd: root, home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("refreshed\n");
    const json = await zz(["daemon", "refresh", "--json"], {
      cwd: root,
      home,
    });
    expect(JSON.parse(json.stdout)).toEqual({ running: true, refreshed: true });
  });

  it("says so when no daemon runs", async () => {
    const r = await zz(["daemon", "refresh"], { cwd: root, home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${NOT_RUNNING}\n`);
    const json = await zz(["daemon", "refresh", "--json"], {
      cwd: root,
      home,
    });
    expect(JSON.parse(json.stdout)).toEqual({
      running: false,
      refreshed: false,
    });
  });
});
