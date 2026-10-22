import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonRequest } from "./daemon/client.js";
import { daemonPaths } from "./daemon/paths.js";
import { isDaemonProcess, processCommand } from "./daemon/process.js";
import { acquireLock, startDaemon, type Daemon } from "./daemon/server.js";

let root: string;
let daemons: Daemon[];
let children: ChildProcess[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zzp-lock-"));
  daemons = [];
  children = [];
});
afterEach(async () => {
  await Promise.all(daemons.map((d) => d.close()));
  for (const child of children) child.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

/** A live child process; with `daemon`, its command line ends in `daemon run` like a daemon's. */
async function liveChild(daemon: boolean): Promise<number> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "console.log('ready'); setInterval(() => {}, 1000);",
      ...(daemon ? ["daemon", "run"] : []),
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  children.push(child);
  await new Promise((resolve) => child.stdout!.once("data", resolve));
  return child.pid!;
}

/** A pid that belonged to a process that has exited. */
const deadPid = () => spawnSync("true").pid!;

const code = (result: PromiseSettledResult<void>) =>
  result.status === "rejected"
    ? (result.reason as { code?: string }).code
    : undefined;

/** Set a file's mtime to `seconds` ago. */
const age = (file: string, seconds: number) => {
  const then = new Date(Date.now() - seconds * 1000);
  utimesSync(file, then, then);
};

describe("the daemon lock", () => {
  it("one of twenty starters wins a stale lock", async () => {
    const lock = join(root, "daemon.lock");
    writeFileSync(lock, `${deadPid()}\n`);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => acquireLock(lock)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => code(r) === "daemon-running")).toHaveLength(
      19,
    );
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
    // No takeover file and no temp file left behind, by the winner or the nineteen.
    expect(readdirSync(root)).toEqual(["daemon.lock"]);
  });

  it("is never seen empty while being created", async () => {
    const lock = join(root, "daemon.lock");
    const seen = new Set<string>();
    let done = false;
    const acquired = acquireLock(lock).finally(() => (done = true));
    while (!done) {
      try {
        seen.add(readFileSync(lock, "utf8"));
      } catch {
        // Not there yet.
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    await acquired;
    expect([...seen].filter((text) => text !== `${process.pid}\n`)).toEqual([]);
  });

  it("leaves no temp file when it fails", async () => {
    const lock = join(root, "daemon.lock");
    writeFileSync(lock, `${await liveChild(true)}\n`);
    await expect(acquireLock(lock)).rejects.toMatchObject({
      code: "daemon-running",
    });
    const dead = `${deadPid()}\n`;
    writeFileSync(`${lock}.takeover`, "");
    writeFileSync(lock, dead);
    await expect(acquireLock(lock)).rejects.toMatchObject({
      code: "daemon-running",
    });
    expect(readdirSync(root).sort()).toEqual([
      "daemon.lock",
      "daemon.lock.takeover",
    ]);
  });

  it("an empty lock is stale", async () => {
    const lock = join(root, "daemon.lock");
    writeFileSync(lock, "");
    await acquireLock(lock);
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
  });

  it("a live owner keeps the lock", async () => {
    const lock = join(root, "daemon.lock");
    const owner = `${await liveChild(true)}\n`;
    writeFileSync(lock, owner);
    await expect(acquireLock(lock)).rejects.toMatchObject({
      code: "daemon-running",
    });
    expect(readFileSync(lock, "utf8")).toBe(owner);
  });

  it("a live process that is not a daemon does not keep the lock", async () => {
    // Its pid was reused: the owner that wrote it is gone.
    const lock = join(root, "daemon.lock");
    writeFileSync(lock, `${await liveChild(false)}\n`);
    await acquireLock(lock);
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
  });

  it("a lock naming this process is stale unless this process took it", async () => {
    const lock = join(root, "daemon.lock");
    writeFileSync(lock, `${process.pid}\n`);
    await acquireLock(lock);
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
    // Now this process holds it: a second start here finds it taken.
    await expect(acquireLock(lock)).rejects.toMatchObject({
      code: "daemon-running",
    });
  });

  it("a readable lock that names no pid is stale", async () => {
    const lock = join(root, "daemon.lock");
    writeFileSync(lock, "not a pid\n");
    await acquireLock(lock);
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
  });

  it.skipIf(process.getuid?.() === 0)(
    "an unreadable lock is stale, taken over once",
    async () => {
      const lock = join(root, "daemon.lock");
      writeFileSync(lock, `${await liveChild(true)}\n`);
      chmodSync(lock, 0o000);
      const results = await Promise.allSettled([
        acquireLock(lock),
        acquireLock(lock),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
    },
  );

  it("removes a takeover file older than 10 s", async () => {
    const lock = join(root, "daemon.lock");
    const takeover = `${lock}.takeover`;
    writeFileSync(lock, `${deadPid()}\n`);
    writeFileSync(takeover, "");
    age(takeover, 11);
    await acquireLock(lock);
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
    expect(existsSync(takeover)).toBe(false);

    const dead = `${deadPid()}\n`;
    writeFileSync(lock, dead);
    writeFileSync(takeover, "");
    age(takeover, 1);
    await expect(acquireLock(lock)).rejects.toMatchObject({
      code: "daemon-running",
    });
    expect(readFileSync(lock, "utf8")).toBe(dead);
    expect(existsSync(takeover)).toBe(true);
  });

  it("a lock that vanishes before it is read is created again", async () => {
    // Its daemon stopped between our failed create and our read.
    // Another starter's takeover is in progress, so the takeover path would give up.
    const lock = join(root, "daemon.lock");
    writeFileSync(lock, `${await liveChild(true)}\n`);
    writeFileSync(`${lock}.takeover`, "");
    await acquireLock(lock, { afterExists: async () => rmSync(lock) });
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
  });

  it("does not remove a takeover file another starter just made", async () => {
    // The stale one was replaced between our stat and our remove: the new one is not ours.
    const lock = join(root, "daemon.lock");
    const takeover = `${lock}.takeover`;
    const dead = `${deadPid()}\n`;
    writeFileSync(lock, dead);
    writeFileSync(takeover, "");
    age(takeover, 11);
    await expect(
      acquireLock(lock, {
        beforeStaleRemove: async () => {
          rmSync(takeover);
          writeFileSync(takeover, "fresh");
        },
      }),
    ).rejects.toMatchObject({ code: "daemon-running" });
    expect(readFileSync(lock, "utf8")).toBe(dead);
    expect(readFileSync(takeover, "utf8")).toBe("fresh");
    expect(readdirSync(root).sort()).toEqual([
      "daemon.lock",
      "daemon.lock.takeover",
    ]);
  });

  it("sweeps temp files left by starters that died", async () => {
    const lock = join(root, "daemon.lock");
    const gone = `${lock}.${deadPid()}.0123456789ab`;
    const live = `${lock}.${await liveChild(false)}.ba9876543210`;
    writeFileSync(gone, "1\n");
    writeFileSync(live, "2\n");
    await acquireLock(lock);
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  it("creates the lock without link() where hard links are not supported", async () => {
    for (const code of ["EPERM", "ENOTSUP", "EXDEV"]) {
      const lock = join(root, `${code}.lock`);
      const noLink = async () => {
        throw Object.assign(new Error(`link: ${code}`), { code });
      };
      await acquireLock(lock, { link: noLink });
      expect(readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
      // Held: a second start here finds it taken.
      await expect(acquireLock(lock, { link: noLink })).rejects.toMatchObject({
        code: "daemon-running",
      });
    }
    expect(readdirSync(root).sort()).toEqual([
      "ENOTSUP.lock",
      "EPERM.lock",
      "EXDEV.lock",
    ]);
  });

  it("releases the lock when start fails after taking it", async () => {
    const home = join(root, "home");
    // A file where the sessions folder goes: its mkdir fails.
    mkdirSync(home);
    writeFileSync(join(home, "sessions"), "");
    await expect(
      startDaemon({ home, env: {}, version: "9.9.9" }),
    ).rejects.toThrow();
    expect(existsSync(daemonPaths(home, {}).lock)).toBe(false);
    rmSync(join(home, "sessions"));
    daemons.push(await startDaemon({ home, env: {}, version: "9.9.9" }));
  });

  it("leaves a live socket alone", async () => {
    const home = join(root, "home");
    const first = await startDaemon({ home, env: {}, version: "9.9.9" });
    daemons.push(first);
    const paths = daemonPaths(home, {});
    const token = readFileSync(paths.token, "utf8");
    rmSync(paths.lock);
    await expect(
      startDaemon({ home, env: {}, version: "9.9.9" }),
    ).rejects.toMatchObject({ code: "daemon-running" });
    expect(readFileSync(paths.token, "utf8")).toBe(token);
    expect(existsSync(paths.pid)).toBe(true);
    // The starter released the lock it took, and only that.
    expect(existsSync(paths.lock)).toBe(false);
    const res = await daemonRequest(
      first.socket,
      first.token,
      "GET",
      "/status",
    );
    expect(res.status).toBe(200);
  });
});

describe("isDaemonProcess", () => {
  it("is a live process whose command line runs the daemon", async () => {
    expect(isDaemonProcess(await liveChild(true))).toBe(true);
    expect(isDaemonProcess(await liveChild(false))).toBe(false);
    expect(isDaemonProcess(deadPid())).toBe(false);
  });

  it("falls back to liveness where the command line cannot be read", async () => {
    const none = () => undefined;
    expect(isDaemonProcess(await liveChild(false), none)).toBe(true);
    expect(isDaemonProcess(deadPid(), none)).toBe(false);
  });

  it("reads the whole command line, however long", async () => {
    // Like a ps that cuts its output at the terminal's width unless told -ww.
    const long = `${"/very/long/path".repeat(20)}/zzpersona daemon run`;
    const ps = ((_: string, args: string[]) => ({
      status: 0,
      stdout: `${args.includes("-ww") ? long : long.slice(0, 80)}\n`,
      stderr: "",
    })) as unknown as typeof import("node:child_process").spawnSync;
    const pid = await liveChild(false);
    expect(processCommand(pid, ps)).toBe(long);
    expect(isDaemonProcess(pid, (p) => processCommand(p, ps))).toBe(true);
  });
});
