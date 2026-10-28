import { StatusOutput } from "@getdonn/cli-schemas";
import { mkdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliIo } from "./cli.js";
import { cliVersion } from "./commands/daemon.js";
import type { StatusJson } from "./commands/status.js";
import { watchStatus, type WatchOptions } from "./commands/status-watch.js";
import { connectDaemon, type DaemonEvent } from "./daemon/client.js";
import { daemonPaths } from "./daemon/paths.js";
import { startDaemon, type Daemon } from "./daemon/server.js";
import { writeState } from "./state.js";
import {
  installedProbe,
  NO_USER_HOME,
  quietIo,
  seed,
  zz,
  type Seeded,
} from "./test/seed.js";

// donn status --watch --json: a snapshot per line. See docs/planning/28-desktop.md §1.

const TIMING = { debounceMs: 50, pollMs: 200 };

let s: Seeded;
let daemons: Daemon[];
let stops: (() => Promise<void>)[];
let now: number;
beforeEach(() => {
  s = seed();
  daemons = [];
  stops = [];
  now = Date.parse("2026-10-26T00:00:00.000Z");
});
afterEach(async () => {
  for (const stop of stops) await stop();
  await Promise.all(daemons.map((d) => d.close()));
  s.cleanup();
});

async function start() {
  const daemon = await startDaemon({
    home: s.home,
    env: {},
    version: cliVersion(),
    debounceMs: 50,
    probe: installedProbe,
    now: () => now,
    passwdHome: () => NO_USER_HOME,
  });
  daemons.push(daemon);
  return daemon;
}

/** A session this process owns, as `donn claude` records it. */
function session(name: string) {
  const dir = join(s.home, "sessions", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "launched.json"),
    JSON.stringify({
      persona: "team/payments",
      source: "switch",
      pid: process.pid,
      project: s.repo,
      startedAt: "2026-10-21T00:00:00.000Z",
    }),
  );
}

/** `watchStatus` with its lines collected; aborted after the test. */
function watching(stdout?: CliIo["stdout"], timing: WatchOptions = TIMING) {
  const lines: StatusJson[] = [];
  const abort = new AbortController();
  const spawnDaemon = vi.fn(async () => {});
  const io: CliIo = {
    ...quietIo({
      cwd: s.root,
      home: s.home,
      env: { HOME: NO_USER_HOME, DONN_NO_DAEMON: "1" },
    }),
    stdout: stdout ?? {
      write: (text: string) => {
        for (const line of text.split("\n").filter(Boolean))
          lines.push(JSON.parse(line) as StatusJson);
      },
    },
    signal: abort.signal,
    spawnDaemon,
  };
  let settled = false;
  const result = watchStatus(io, timing).finally(() => (settled = true));
  stops.push(async () => {
    abort.abort();
    await result.catch(() => undefined);
  });
  /** The first line after the `from`th that `match` accepts. */
  const next = (match: (line: StatusJson) => boolean, from = lines.length) =>
    vi.waitFor(
      () => {
        const found = lines.slice(from).find(match);
        if (!found) throw new Error("no such line yet");
        return found;
      },
      { timeout: 3_000, interval: 10 },
    );
  /** Resolves once no line has come for `ms`. */
  const quiet = async (ms = (timing.debounceMs ?? 250) * 4 + 100) => {
    for (let count = -1; count !== lines.length;) {
      count = lines.length;
      await new Promise((r) => setTimeout(r, ms));
    }
  };
  return {
    lines,
    abort,
    result,
    spawnDaemon,
    next,
    quiet,
    settled: () => settled,
  };
}

const any = () => true;

describe("donn status --watch", () => {
  it("requires --json", async () => {
    const r = await zz(["status", "--watch"], { cwd: s.root, home: s.home });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("error: --watch prints JSON lines; add --json\n");
    expect(r.stdout).toBe("");
  });

  it("prints a first line", async () => {
    await start();
    const w = watching();
    const first = await w.next(any);
    expect(first.daemon).toBe(true);
    StatusOutput.parse(first);
    expect(w.lines[0]).toEqual(first);
  });

  it("prints after an event", async () => {
    const daemon = await start();
    const w = watching();
    expect((await w.next(any)).sessions).toEqual([]);
    // Counted before the change: its line can come while the refresh is still being awaited.
    const from = w.lines.length;
    session("a");
    await daemon.refresh();
    const line = await w.next((l) => l.sessions.length === 1, from);
    expect(line.sessions[0]).toMatchObject({ launched: "team/payments" });
    StatusOutput.parse(line);
  });

  it("prints after a switch", async () => {
    await start();
    const w = watching();
    await w.next(any);
    const from = w.lines.length;
    const r = await zz(["switch", "team/payments", "--default"], {
      cwd: s.root,
      home: s.home,
    });
    expect(r.code).toBe(0);
    const line = await w.next((l) => l.switched.default !== undefined, from);
    expect(line.switched.default).toBe("team/payments");
    StatusOutput.parse(line);
  });

  it("reads state.json again once its watcher is live", async () => {
    // FSEvents arms a watch late: a switch made just after the first line can go unreported.
    // A watcher that never reports stands in for it.
    await start();
    const deaf = vi.fn((dir: string) => watch(dir, () => {}));
    const w = watching(undefined, { ...TIMING, settleMs: 300, watch: deaf });
    await w.next(any);
    const from = w.lines.length;
    await writeState(s.home, {
      version: 1,
      default: "team/payments",
      projects: {},
    });
    const line = await w.next((l) => l.switched.default !== undefined, from);
    expect(line.switched.default).toBe("team/payments");
    expect(deaf).toHaveBeenCalledWith(s.home, expect.any(Function));
  });

  it("debounces bursts and skips repeats", async () => {
    session("a");
    const daemon = await start();
    const client = await connectDaemon(s.home);
    const events: DaemonEvent[] = [];
    const unfollow = client!.events((e) => events.push(e));
    stops.push(async () => unfollow());
    await client!.status();
    // Longer than the file events' own latency, so the switches below come inside one wait.
    const w = watching(undefined, { ...TIMING, debounceMs: 150 });
    await w.next((l) => l.sessions.length === 1);
    await w.quiet();
    // Every refresh records a new time: a change, ten times over within 50 ms.
    const before = w.lines.length;
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        now += 1_000 * (i + 1);
        return client!.refresh();
      }),
    );
    await w.quiet();
    expect(w.lines.length - before).toBeGreaterThanOrEqual(1);
    expect(w.lines.length - before).toBeLessThanOrEqual(2);
    // Ten switches 20 ms apart, each a different state.json.
    const switched = w.lines.length;
    for (let i = 0; i < 10; i++) {
      await writeState(s.home, {
        version: 1,
        projects: { [`/p${i}`]: "team/payments" },
      });
      await new Promise((r) => setTimeout(r, 20));
    }
    await w.next((l) => l.switched.projects["/p9"] !== undefined, switched);
    await w.quiet();
    expect(w.lines.length - switched).toBeLessThanOrEqual(2);
    // The same time again: the daemon says so, and the line would be the same.
    const seen = events.length;
    const after = w.lines.length;
    await daemon.refresh();
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(seen));
    await w.quiet();
    expect(w.lines.length).toBe(after);
  });

  it("waits for a daemon without starting one", async () => {
    const w = watching();
    const first = await w.next(any);
    expect(first.daemon).toBe(false);
    StatusOutput.parse(first);
    await start();
    const up = await w.next((l) => l.daemon);
    StatusOutput.parse(up);
    expect(w.spawnDaemon).not.toHaveBeenCalled();
  });

  it("follows a restart", async () => {
    const daemon = await start();
    const w = watching();
    await w.next((l) => l.daemon);
    const up = w.lines.length;
    await daemon.close();
    const down = await w.next((l) => !l.daemon, up);
    StatusOutput.parse(down);
    const from = w.lines.length;
    await start();
    await w.next((l) => l.daemon, from);
    expect(w.settled()).toBe(false);
  });

  it("follows a daemon that ends the stream without a word", async () => {
    const fake = await fakeDaemon(s.home);
    stops.push(() => fake.close());
    const w = watching();
    await w.next((l) => l.daemon);
    const up = w.lines.length;
    await fake.close();
    await w.next((l) => !l.daemon, up);
    expect(w.settled()).toBe(false);
  });

  it("exits on a closed stdout", async () => {
    const daemon = await start();
    let writes = 0;
    const w = watching({
      write: () => {
        if (++writes > 1)
          throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        return true;
      },
    });
    await vi.waitFor(() => expect(writes).toBe(1));
    session("a");
    await daemon.refresh();
    expect(await w.result).toBe(0);
    expect(writes).toBe(2);
    // No longer following: the daemon closes without waiting on the stream.
    session("b");
    await daemon.refresh();
    const t = Date.now();
    await daemon.close();
    expect(Date.now() - t).toBeLessThan(900);
    expect(writes).toBe(2);
  });

  it("stops on the signal", async () => {
    await start();
    const w = watching();
    await w.next(any);
    w.abort.abort();
    expect(await w.result).toBe(0);
  });
});

describe("the daemon client's events", () => {
  it("says once when the stream ends, not when stopped", async () => {
    const daemon = await start();
    const client = await connectDaemon(s.home);
    const ended = vi.fn();
    const stop = client!.events(() => {}, ended);
    await client!.status();
    const other = vi.fn();
    client!.events(() => {}, other)();
    await daemon.close();
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
    stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(ended).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });
});

/**
 * A daemon that answers `/status` and `/events` and then dies without `daemon.stopping`: its
 * close cuts the stream and removes the token.
 */
async function fakeDaemon(home: string) {
  const paths = daemonPaths(home);
  const token = "fake-token";
  mkdirSync(paths.dir, { recursive: true });
  mkdirSync(dirname(paths.sock), { recursive: true });
  rmSync(paths.sock, { force: true });
  writeFileSync(paths.token, token);
  const streams = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      streams.add(res);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        version: cliVersion(),
        pid: process.pid,
        startedAt: "2026-10-26T00:00:00.000Z",
        service: false,
        watching: [],
        sessions: [],
        agents: [],
        syncFailed: [],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(paths.sock, resolve));
  let closing: Promise<void> | undefined;
  return {
    close: () =>
      (closing ??= (async () => {
        rmSync(paths.token, { force: true });
        for (const res of streams) res.destroy();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      })()),
  };
}
