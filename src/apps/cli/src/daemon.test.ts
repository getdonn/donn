import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliVersion } from "./commands/daemon.js";
import { connectDaemon, daemonRequest, ownSocket } from "./daemon/client.js";
import { daemonPaths, privateSocketDir } from "./daemon/paths.js";
import { startDaemon, type Daemon } from "./daemon/server.js";
import { zz } from "./test/seed.js";

let root: string;
let daemons: Daemon[];
let stubborn: ChildProcess | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "donn-daemon-"));
  daemons = [];
});
afterEach(async () => {
  await Promise.all(daemons.map((d) => d.close()));
  stubborn?.kill("SIGKILL");
  stubborn = undefined;
  rmSync(root, { recursive: true, force: true });
});

const homeIn = (name = "home") => join(root, name);

async function start(home = homeIn(), env: NodeJS.ProcessEnv = {}) {
  const daemon = await startDaemon({ home, env, version: "9.9.9" });
  daemons.push(daemon);
  return daemon;
}

/** A pid that belonged to a process that has exited. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

describe("the daemon", () => {
  it("serves its status over the socket with the token", async () => {
    const daemon = await start();
    const res = await daemonRequest(
      daemon.socket,
      daemon.token,
      "GET",
      "/status",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      version: "9.9.9",
      pid: process.pid,
      startedAt: daemon.startedAt,
      service: false,
      watching: expect.arrayContaining([join(homeIn(), "sessions")]),
      sessions: [],
    });
    const client = await connectDaemon(homeIn());
    expect((await client!.status()).version).toBe("9.9.9");
  });

  it("reports running sessions with their state", async () => {
    const home = homeIn();
    const dir = join(home, "sessions/abc");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "launched.json"),
      JSON.stringify({
        persona: "team/payments",
        source: "switch",
        pid: process.pid,
        project: "/repo",
        startedAt: "2026-10-21T00:00:00.000Z",
      }),
    );
    await start(home);
    const status = await (await connectDaemon(home))!.status();
    expect(status.sessions).toEqual([
      {
        dir,
        harness: "claude-code",
        project: "/repo",
        launched: "team/payments",
        startedAt: "2026-10-21T00:00:00.000Z",
        held: [],
        // This home has no personas: the first refresh cannot compile it.
        state: "refresh-failed",
        at: expect.any(String),
        error: expect.stringContaining("team/payments"),
      },
    ]);
  });

  it("rejects a missing or wrong token", async () => {
    const daemon = await start();
    for (const token of [undefined, "wrong"]) {
      const res = await daemonRequest(daemon.socket, token, "GET", "/status");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: { code: "unauthorized", message: expect.any(String) },
      });
    }
  });

  it("answers 404 for an unknown path", async () => {
    const daemon = await start();
    const res = await daemonRequest(
      daemon.socket,
      daemon.token,
      "GET",
      "/nope",
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: "not-found", message: expect.any(String) },
    });
  });

  it("creates the socket and token owner-only", async () => {
    const daemon = await start();
    const paths = daemonPaths(homeIn());
    expect(statSync(paths.dir).mode & 0o777).toBe(0o700);
    expect(statSync(daemon.socket).mode & 0o777).toBe(0o600);
    expect(statSync(paths.token).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths.token, "utf8")).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(paths.token, "utf8")).toBe(daemon.token);
  });

  it("cleans up a stale socket, pid and lock", async () => {
    const paths = daemonPaths(homeIn());
    mkdirSync(paths.dir, { recursive: true });
    const dead = deadPid();
    writeFileSync(paths.sock, "stale");
    writeFileSync(paths.pid, `${dead}\n`);
    writeFileSync(paths.lock, `${dead}\n`);
    const daemon = await start();
    expect(readFileSync(paths.pid, "utf8").trim()).toBe(String(process.pid));
    const res = await daemonRequest(
      daemon.socket,
      daemon.token,
      "GET",
      "/status",
    );
    expect(res.status).toBe(200);
  });

  it("refuses a second daemon for the same home", async () => {
    await start();
    await expect(start()).rejects.toMatchObject({
      code: "daemon-running",
      message: "already running",
    });
  });

  it("runs one daemon per home", async () => {
    const a = await start(homeIn("a"));
    const b = await start(homeIn("b"));
    expect(a.socket).not.toBe(b.socket);
    expect(a.token).not.toBe(b.token);
    expect((await connectDaemon(homeIn("a")))?.status()).toBeDefined();
    expect(await (await connectDaemon(homeIn("b")))!.status()).toMatchObject({
      pid: process.pid,
    });
  });

  it("removes its files on shutdown", async () => {
    const home = homeIn();
    const daemon = await start(home);
    const paths = daemonPaths(home);
    await (await connectDaemon(home))!.shutdown();
    // The lock goes last, after the socket: wait for it, not the socket.
    await waitFor(() => !existsSync(paths.lock));
    expect(existsSync(daemon.socket)).toBe(false);
    expect(existsSync(paths.pid)).toBe(false);
    expect(existsSync(paths.lock)).toBe(false);
    expect(existsSync(paths.token)).toBe(false);
    expect(await connectDaemon(home)).toBeUndefined();
  });

  it("rotates the log past 1 MiB", async () => {
    const paths = daemonPaths(homeIn());
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.log, "x".repeat(1024 * 1024 + 1));
    const daemon = await start();
    await daemon.close();
    expect(statSync(`${paths.log}.1`).size).toBe(1024 * 1024 + 1);
    expect(statSync(paths.log).size).toBeLessThan(1024);
    expect(readFileSync(paths.log, "utf8")).toContain("started");
  });

  it("moves the socket for a long home", async () => {
    const home = longHome();
    const daemon = await start(home);
    const paths = daemonPaths(home, {});
    const dir = join(tmpdir(), `donnd-${process.getuid!()}`);
    expect(daemon.socket).toMatch(
      new RegExp(`^${dir}/donnd-[0-9a-f]{8}\\.sock$`),
    );
    expect(paths.sock).toBe(daemon.socket);
    // A folder of the user's own, so no one else can take the socket's name.
    const stats = lstatSync(dir);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.uid).toBe(process.getuid!());
    expect(stats.mode & 0o777).toBe(0o700);
    expect(readFileSync(paths.where, "utf8").trim()).toBe(daemon.socket);
    expect((await (await connectDaemon(home))!.status()).pid).toBe(process.pid);
    await daemon.close();
    expect(existsSync(paths.where)).toBe(false);
  });

  it("puts a long home's socket in XDG_RUNTIME_DIR when set", async () => {
    const run = join(root, "run");
    mkdirSync(run, { mode: 0o700 });
    const home = longHome();
    const daemon = await start(home, { XDG_RUNTIME_DIR: run });
    expect(daemon.socket).toMatch(
      new RegExp(`^${run}/donnd-[0-9a-f]{8}\\.sock$`),
    );
    expect((await (await connectDaemon(home))!.status()).pid).toBe(process.pid);
  });

  it("refuses a socket folder others could reach", async () => {
    const loose = join(root, "loose");
    mkdirSync(loose);
    chmodSync(loose, 0o755);
    const home = longHome();
    await expect(start(home, { XDG_RUNTIME_DIR: loose })).rejects.toMatchObject(
      { code: "daemon-socket-dir" },
    );
    // A failed start leaves nothing a client would take for a daemon.
    const paths = daemonPaths(home, { XDG_RUNTIME_DIR: loose });
    expect(existsSync(paths.lock)).toBe(false);
    expect(existsSync(paths.token)).toBe(false);
    expect(existsSync(paths.sock)).toBe(false);
  });

  it("checks the socket folder is a private directory of the user's", async () => {
    const mine = join(root, "mine");
    await privateSocketDir(mine);
    expect(lstatSync(mine).mode & 0o777).toBe(0o700);
    // Someone else's folder.
    await expect(
      privateSocketDir(mine, process.getuid!() + 1),
    ).rejects.toMatchObject({ code: "daemon-socket-dir" });
    // A symlink to a folder that would pass.
    const link = join(root, "link");
    symlinkSync(mine, link);
    await expect(privateSocketDir(link)).rejects.toMatchObject({
      code: "daemon-socket-dir",
    });
    const loose = join(root, "loose");
    mkdirSync(loose, { mode: 0o700 });
    chmodSync(loose, 0o750);
    await expect(privateSocketDir(loose)).rejects.toMatchObject({
      code: "daemon-socket-dir",
    });
  });

  it("sends its token only to a socket of the user's", async () => {
    const home = homeIn();
    const paths = daemonPaths(home);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.token, "secret");
    const seen: IncomingHttpHeaders[] = [];
    const listener = createServer((req, res) => {
      seen.push(req.headers);
      res.end("{}");
    });
    await new Promise<void>((r) => listener.listen(paths.sock, r));
    try {
      // The socket stands for one another user listens on.
      const other = process.getuid!() + 1;
      expect(await connectDaemon(home, { uid: other })).toBeUndefined();
      expect(seen).toEqual([]);
      expect(await connectDaemon(home)).toBeDefined();
      expect(seen[0]?.authorization).toBe("Bearer secret");
    } finally {
      await new Promise((r) => listener.close(r));
    }
  });

  it("knows a socket of the user's", () => {
    const uid = process.getuid!();
    const socket = (owner: number, isSocket = true) => ({
      uid: owner,
      isSocket: () => isSocket,
    });
    expect(ownSocket(socket(uid))).toBe(true);
    expect(ownSocket(socket(uid + 1))).toBe(false);
    expect(ownSocket(socket(uid, false))).toBe(false);
    expect(ownSocket(undefined)).toBe(false);
  });
});

/** A home whose `<home>/daemon/sock` is too long for a socket path. */
function longHome() {
  let home = homeIn();
  while (Buffer.byteLength(join(home, "daemon/sock")) <= 103) {
    home = join(home, "a-rather-long-folder-name");
  }
  return home;
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("donn daemon", () => {
  const run = (argv: string[]) =>
    zz(argv, {
      cwd: root,
      home: homeIn(),
      // No HOME: no login service to report beside the daemon.
      env: { HOME: undefined },
      spawnDaemon: async (home) => {
        daemons.push(
          await startDaemon({ home, env: {}, version: cliVersion() }),
        );
      },
    });

  it("starts, reports, refuses a second start and stops", async () => {
    expect(
      JSON.parse((await run(["daemon", "status", "--json"])).stdout),
    ).toEqual({ running: false });

    const started = await run(["daemon", "start"]);
    expect(started.code).toBe(0);
    expect(daemons).toHaveLength(1);

    const status = await run(["daemon", "status", "--json"]);
    expect(JSON.parse(status.stdout)).toMatchObject({
      running: true,
      version: cliVersion(),
      pid: process.pid,
      sessions: 0,
    });
    expect((await run(["daemon", "status"])).stdout).toContain(
      "daemon running",
    );

    const again = await run(["daemon", "start"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("already running");
    expect(daemons).toHaveLength(1);

    const stopped = await run(["daemon", "stop", "--json"]);
    expect(JSON.parse(stopped.stdout)).toEqual({
      running: false,
      stopped: true,
    });
    const after = await run(["daemon", "status"]);
    expect(after.code).toBe(0);
    expect(after.stdout).toContain("daemon not running");
  });

  it("stops nothing when no daemon runs", async () => {
    const stopped = await run(["daemon", "stop", "--json"]);
    expect(stopped.code).toBe(0);
    expect(JSON.parse(stopped.stdout)).toEqual({
      running: false,
      stopped: false,
    });
  });

  it("returns from stop only once the lock is released", async () => {
    await run(["daemon", "start"]);
    const stopped = await run(["daemon", "stop"]);
    expect(stopped.stdout).toBe("daemon stopped\n");
    expect(existsSync(daemonPaths(homeIn()).lock)).toBe(false);
  });

  it("reports a daemon that ignores SIGTERM as not stopped", async () => {
    // A wedged daemon: alive, named by the pid file, holding the lock, no socket.
    stubborn = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);",
        "daemon",
        "run",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise((resolve) => stubborn!.stdout!.once("data", resolve));
    const paths = daemonPaths(homeIn());
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.pid, `${stubborn.pid}\n`);
    writeFileSync(paths.lock, `${stubborn.pid}\n`);
    const stopped = await run(["daemon", "stop", "--json"]);
    expect(stopped.code).toBe(1);
    expect(JSON.parse(stopped.stdout)).toMatchObject({
      error: { code: "daemon-stop" },
    });
  }, 15_000);

  it("never signals a live process that is not the daemon", async () => {
    // The daemon died and the OS gave its pid to an unrelated process.
    stubborn = spawn(
      process.execPath,
      ["-e", "console.log('ready'); setInterval(() => {}, 1000);"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise((resolve) => stubborn!.stdout!.once("data", resolve));
    const paths = daemonPaths(homeIn());
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.pid, `${stubborn.pid}\n`);
    writeFileSync(paths.lock, `${stubborn.pid}\n`);
    const stopped = await run(["daemon", "stop"]);
    expect(stopped).toMatchObject({ code: 0, stdout: "daemon not running\n" });
    expect(stubborn.exitCode).toBeNull();
    expect(stubborn.signalCode).toBeNull();
  });
});
