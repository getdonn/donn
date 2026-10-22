import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
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
import { acquireLock, startDaemon, type Daemon } from "./daemon/server.js";

let root: string;
let daemons: Daemon[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zzp-lock-"));
  daemons = [];
});
afterEach(async () => {
  await Promise.all(daemons.map((d) => d.close()));
  rmSync(root, { recursive: true, force: true });
});

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
    expect(existsSync(`${lock}.takeover`)).toBe(false);
  });

  it("an empty lock is stale", async () => {
    const lock = join(root, "daemon.lock");
    writeFileSync(lock, "");
    await acquireLock(lock);
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
  });

  it("a live owner keeps the lock", async () => {
    const lock = join(root, "daemon.lock");
    writeFileSync(lock, `${process.pid}\n`);
    await expect(acquireLock(lock)).rejects.toMatchObject({
      code: "daemon-running",
    });
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
  });

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
