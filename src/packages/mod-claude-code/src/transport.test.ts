import { describe, expect, it } from "vitest";
import type { Mod$, ProcessRunResult } from "./api.js";
import { runCli } from "./cli.js";
import { DAEMON_TIMEOUT_MS, viaDaemon } from "./transport.js";

// A stand-in host for the daemon route: files, stat, a socket that answers, and a clock the test
// fires. See docs/planning/15-mod-transport.md, section 2.

const HOME = "/home/u/.zzpersona";
const SOCK = `${HOME}/daemon/sock`;

type Reply = { status: number; text: string } | Error | "never";

interface Request {
  url: string;
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    socketPath?: string;
  };
}

function host(options: {
  env?: Record<string, string>;
  files?: Record<string, string>;
  stat?: Record<string, { kind: string; isLink: boolean }>;
  replies?: Reply[];
  run?: ProcessRunResult | Error;
}) {
  const env = options.env ?? { HOME: "/home/u" };
  const files = new Map(Object.entries(options.files ?? {}));
  const stats = options.stat ?? {};
  const replies = [...(options.replies ?? [])];
  const requests: Request[] = [];
  const runs: (readonly string[])[] = [];
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  /** Settles a reply held back with "never". */
  let late: ((reply: { status: number; text: string }) => void) | undefined;
  const $ = {
    env: { get: async (name: string) => env[name] },
    fs: {
      read: async (path: string) => {
        const text = files.get(path);
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return text;
      },
      stat: async (path: string) => {
        const stat = stats[path];
        if (stat === undefined) throw new Error(`ENOENT: ${path}`);
        return { ...stat, size: 0, mtimeMs: 0 };
      },
    },
    http: {
      fetch: async (url: string, init: Request["init"]) => {
        requests.push({ url, init });
        const reply = replies.shift() ?? new Error("ECONNREFUSED");
        if (reply instanceof Error) throw reply;
        if (reply === "never")
          return new Promise((resolve) => {
            late = (r) =>
              resolve({ ...r, ok: r.status < 300, headers: {} } as never);
          });
        return { ...reply, ok: reply.status < 300, headers: {} };
      },
    },
    clock: {
      after: (ms: number, fn: () => void) => {
        const timer = { ms, fn, cancelled: false };
        timers.push(timer);
        return { cancel: () => (timer.cancelled = true) };
      },
    },
    process: {
      run: async (argv: readonly string[]) => {
        runs.push(argv);
        const run = options.run ?? {
          exitCode: 0,
          stdout: '{"from":"cli"}',
          stderr: "",
        };
        if (run instanceof Error) throw run;
        return run;
      },
    },
  } as unknown as Mod$;
  const fire = () => timers.filter((t) => !t.cancelled).forEach((t) => t.fn());
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    $,
    files,
    requests,
    runs,
    timers,
    fire,
    settle,
    late: (reply: { status: number; text: string }) => late?.(reply),
  };
}

const SOCKET = { [SOCK]: { kind: "other", isLink: false } };
const TOKEN = { [`${HOME}/daemon/token`]: "t0k\n" };
const ran = (stdout: string, exitCode = 0) => ({
  status: 200,
  text: JSON.stringify({ exitCode, stdout, stderr: "" }),
});

describe("viaDaemon", () => {
  it("posts the command to the daemon's socket with the token", async () => {
    const h = host({ files: TOKEN, stat: SOCKET, replies: [ran("{}")] });
    expect(await viaDaemon(h.$, ["list", "--json"], "/repo")).toEqual({
      exitCode: 0,
      stdout: "{}",
    });
    expect(h.requests).toEqual([
      {
        url: "http://zzpersona/run",
        init: {
          method: "POST",
          socketPath: SOCK,
          headers: {
            authorization: "Bearer t0k",
            "content-type": "application/json",
          },
          body: JSON.stringify({ argv: ["list", "--json"], cwd: "/repo" }),
        },
      },
    ]);
    expect(h.timers.map((t) => [t.ms, t.cancelled])).toEqual([
      [DAEMON_TIMEOUT_MS, true],
    ]);
  });

  it("finds the socket through where, under ZZPERSONA_HOME", async () => {
    const h = host({
      env: { ZZPERSONA_HOME: "/z", HOME: "/home/u" },
      files: { "/z/daemon/where": "/tmp/zz.sock\n", "/z/daemon/token": "k" },
      stat: { "/tmp/zz.sock": { kind: "other", isLink: false } },
      replies: [ran("{}")],
    });
    expect(await viaDaemon(h.$, ["list", "--json"], "/r")).toBeDefined();
    expect(h.requests[0]!.init.socketPath).toBe("/tmp/zz.sock");
  });

  it("passes a command's failure through", async () => {
    const h = host({ files: TOKEN, stat: SOCKET, replies: [ran("{}", 1)] });
    expect(await viaDaemon(h.$, ["list", "--json"], "/r")).toEqual({
      exitCode: 1,
      stdout: "{}",
    });
  });

  it("retries once with a re-read token", async () => {
    const h = host({
      files: TOKEN,
      stat: SOCKET,
      replies: [{ status: 401, text: "{}" }, ran("{}")],
    });
    // The daemon restarted with a new token between the two reads.
    const fetch = h.$.http!.fetch;
    h.$.http!.fetch = async (url, init) => {
      h.files.set(`${HOME}/daemon/token`, "n3w");
      return fetch(url, init);
    };
    expect(await viaDaemon(h.$, ["list", "--json"], "/r")).toBeDefined();
    expect(h.requests.map((r) => r.init.headers?.authorization)).toEqual([
      "Bearer t0k",
      "Bearer n3w",
    ]);
  });

  it("gives up on a second 401", async () => {
    const h = host({
      files: TOKEN,
      stat: SOCKET,
      replies: [
        { status: 401, text: "{}" },
        { status: 401, text: "{}" },
        ran("{}"),
      ],
    });
    expect(await viaDaemon(h.$, ["list", "--json"], "/r")).toBeUndefined();
    expect(h.requests).toHaveLength(2);
  });

  it("cannot answer without a socket, a token or a good reply", async () => {
    const none = async (options: Parameters<typeof host>[0]) =>
      viaDaemon(host(options).$, ["list", "--json"], "/r");
    expect(await none({ files: TOKEN })).toBeUndefined();
    expect(await none({ stat: SOCKET, replies: [ran("{}")] })).toBeUndefined();
    expect(await none({ files: TOKEN, stat: SOCKET })).toBeUndefined();
    const reply = (status: number, text = "{}") =>
      none({ files: TOKEN, stat: SOCKET, replies: [{ status, text }] });
    expect(await reply(500)).toBeUndefined();
    expect(await reply(403)).toBeUndefined();
    expect(await reply(200, "not json")).toBeUndefined();
    expect(await reply(200, '{"exitCode":"0","stdout":1}')).toBeUndefined();
    expect(await none({ env: {}, files: TOKEN, stat: SOCKET })).toBeUndefined();
  });

  it("sends no token to a link", async () => {
    const h = host({
      files: TOKEN,
      stat: { [SOCK]: { kind: "other", isLink: true } },
      replies: [ran("{}")],
    });
    expect(await viaDaemon(h.$, ["list", "--json"], "/r")).toBeUndefined();
    expect(h.requests).toEqual([]);
  });

  it("sends no token to a plain file", async () => {
    const h = host({
      files: TOKEN,
      stat: { [SOCK]: { kind: "file", isLink: false } },
      replies: [ran("{}")],
    });
    expect(await viaDaemon(h.$, ["list", "--json"], "/r")).toBeUndefined();
    expect(h.requests).toEqual([]);
  });

  it("cannot answer on an older Claude Code", async () => {
    const h = host({ files: TOKEN, stat: SOCKET, replies: [ran("{}")] });
    delete (h.$ as { http?: unknown }).http;
    expect(await viaDaemon(h.$, ["list", "--json"], "/r")).toBeUndefined();
  });
});

describe("runCli through the daemon", () => {
  it("uses the daemon and runs no process", async () => {
    const h = host({
      files: TOKEN,
      stat: SOCKET,
      replies: [ran('{"from":"daemon"}')],
    });
    expect(await runCli(h.$, ["list"], "/r")).toEqual({
      ok: true,
      json: { from: "daemon" },
    });
    expect(JSON.parse(h.requests[0]!.init.body!)).toEqual({
      argv: ["list", "--json"],
      cwd: "/r",
    });
    expect(h.runs).toEqual([]);
  });

  it("keeps the CLI's error envelope from the daemon", async () => {
    const h = host({
      files: TOKEN,
      stat: SOCKET,
      replies: [ran('{"error":{"code":"no-persona","message":"none"}}', 1)],
    });
    expect(await runCli(h.$, ["switch"], "/r")).toEqual({
      ok: false,
      code: "no-persona",
      reason: "none",
    });
  });

  it("falls back to the CLI", async () => {
    const cases: Parameters<typeof host>[0][] = [
      { files: TOKEN },
      { files: TOKEN, stat: SOCKET, replies: [new Error("ECONNREFUSED")] },
      { files: TOKEN, stat: SOCKET, replies: [{ status: 500, text: "{}" }] },
      {
        files: TOKEN,
        stat: SOCKET,
        replies: [
          { status: 401, text: "{}" },
          { status: 401, text: "{}" },
        ],
      },
    ];
    for (const options of cases) {
      const h = host(options);
      expect(await runCli(h.$, ["list"], "/r")).toEqual({
        ok: true,
        json: { from: "cli" },
      });
      expect(h.runs).toEqual([["zzpersona", "list", "--json"]]);
    }
  });

  it("falls back after 1.5 s", async () => {
    const h = host({ files: TOKEN, stat: SOCKET, replies: ["never"] });
    const result = runCli(h.$, ["list"], "/r");
    await h.settle();
    expect(h.requests).toHaveLength(1);
    expect(h.runs).toEqual([]);
    expect(h.timers.map((t) => t.ms)).toEqual([1500]);
    h.fire();
    expect(await result).toEqual({ ok: true, json: { from: "cli" } });
    expect(h.runs).toHaveLength(1);
    // A late answer changes nothing.
    h.late(ran('{"from":"daemon"}'));
    await h.settle();
    expect(h.runs).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
    expect(await result).toEqual({ ok: true, json: { from: "cli" } });
  });

  it("says how to fix it when both fail", async () => {
    const h = host({ run: new Error("Acme policy: no process.run") });
    expect(await runCli(h.$, ["list"], "/r")).toEqual({
      ok: false,
      code: "unavailable",
      reason:
        "start the daemon (zzpersona daemon start), or allow the mod to run zzpersona",
    });
  });
});
