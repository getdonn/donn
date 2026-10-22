import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Opt-in (ZZP_E2E_SERVICE=1, macOS only; separate from ZZP_E2E because it touches the user's
// launchd domain): the built `zzpersona` installed as a launchd agent under a scratch label, with
// a temp HOME (so the plist lands in a temp folder) and a temp ZZPERSONA_HOME. The real
// `zzpersona.daemon` service, ~/Library/LaunchAgents and ~/.zzpersona are never touched. See
// docs/planning/16-daemon-service.md §4.

const PACKAGE = join(import.meta.dirname, "..");
const BIN = join(PACKAGE, "dist/bin.js");
const LABEL = `zzpersona.daemon.e2e-${Math.random().toString(36).slice(2, 10)}`;
const UID = process.getuid?.() ?? -1;
const TARGET = `gui/${UID}/${LABEL}`;

// Created in beforeAll, so a skipped run leaves nothing behind. Short names: the socket path
// must stay under macOS's 104 bytes so it sits in the home, not in a temp folder of its own.
let work = "";
let home = "";
let zzhome = "";
let bin = "";

interface Status {
  running: boolean;
  pid?: number;
  service?: { installed: boolean; path: string; managed: boolean };
}

function zzpersona(args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    ZZPERSONA_HOME: zzhome,
    ZZPERSONA_SERVICE_LABEL: LABEL,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  delete env.ZZPERSONA_SERVICE;
  const result = spawnSync("zzpersona", args, {
    cwd: work,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `zzpersona ${args.join(" ")} exited ${result.status}: ${result.stderr}`,
    );
  }
  return result.stdout;
}

const status = () =>
  JSON.parse(zzpersona(["daemon", "status", "--json"])) as Status;

const loaded = () =>
  spawnSync("launchctl", ["print", TARGET], { stdio: "ignore" }).status === 0;

async function until<T>(
  ms: number,
  check: () => T | undefined,
): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== undefined || Date.now() >= deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe.skipIf(
  process.env.ZZP_E2E_SERVICE !== "1" || process.platform !== "darwin",
)("e2e: zzpersona daemon install (launchd)", () => {
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "zzp-svc-"));
    home = join(work, "h");
    zzhome = join(work, "z");
    bin = join(work, "bin");
    mkdirSync(home);
    mkdirSync(zzhome);
    mkdirSync(bin);
    execFileSync("pnpm", ["build"], { cwd: PACKAGE, stdio: "ignore" });
    writeFileSync(
      join(bin, "zzpersona"),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} "$@"\n`,
      { mode: 0o755 },
    );
  }, 120_000);

  afterAll(() => {
    // Always, whatever failed: the scratch job must not outlive the test.
    spawnSync("launchctl", ["bootout", TARGET], { stdio: "ignore" });
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it("installs, survives kill -9, stays stopped after stop, uninstalls", async () => {
    const plist = join(home, "Library/LaunchAgents", `${LABEL}.plist`);

    const installed = JSON.parse(
      zzpersona(["daemon", "install", "--json"]),
    ) as { installed: boolean; path: string; pid: number };
    expect(installed.installed).toBe(true);
    expect(installed.path).toBe(plist);
    expect(existsSync(plist)).toBe(true);
    expect(loaded()).toBe(true);

    const first = status();
    expect(first.running).toBe(true);
    expect(first.service).toMatchObject({ installed: true, managed: true });
    const pid = first.pid!;

    // launchd brings a crashed daemon back (KeepAlive: SuccessfulExit false).
    process.kill(pid, "SIGKILL");
    const back = await until(15_000, () => {
      const now = status();
      return now.running && now.pid !== pid ? now : undefined;
    });
    expect(back?.pid).toBeGreaterThan(0);
    expect(back?.service?.managed).toBe(true);

    // A clean stop exits 0, so launchd leaves it stopped.
    zzpersona(["daemon", "stop", "--json"]);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(status().running).toBe(false);

    const removed = JSON.parse(
      zzpersona(["daemon", "uninstall", "--json"]),
    ) as { installed: boolean; removed: boolean };
    expect(removed).toMatchObject({ installed: false, removed: true });
    expect(existsSync(plist)).toBe(false);
    expect(await until(5_000, () => (loaded() ? undefined : true))).toBe(true);
  }, 90_000);
});
