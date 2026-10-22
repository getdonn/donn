import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonRequest } from "./daemon/client.js";
import { allowedRun, runInProcess } from "./daemon/run.js";
import { startDaemon, type Daemon } from "./daemon/server.js";
import { createSession } from "./session.js";
import { installedProbe, seed, zz, type Seeded } from "./test/seed.js";

// POST /run: the daemon runs the mod's allowlisted commands in-process and answers what the CLI
// prints. See docs/planning/15-mod-transport.md §1.

let s: Seeded;
let daemons: Daemon[];
beforeEach(() => {
  s = seed();
  daemons = [];
});
afterEach(async () => {
  await Promise.all(daemons.map((d) => d.close()));
  s.cleanup();
});

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function start() {
  const daemon = await startDaemon({
    home: s.home,
    env: {},
    version: "9.9.9",
    debounceMs: 50,
    probe: installedProbe,
  });
  daemons.push(daemon);
  return daemon;
}

const run = (daemon: Daemon, body: unknown) =>
  daemonRequest(daemon.socket, daemon.token, "POST", "/run", 30_000, body);

/** A session launched on org/base, as `zzpersona claude` leaves it, owned by this process. */
async function session(): Promise<string> {
  const plugin = join(s.root, "launched-plugin");
  put(
    join(plugin, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "zzp-org--base" }),
  );
  return createSession(
    s.home,
    plugin,
    { persona: "org/base", source: "argument" },
    process.pid,
  );
}

describe("allowedRun", () => {
  it("accepts exactly the mod's forms, flags in any order", () => {
    for (const argv of [
      ["switch", "--json"],
      ["switch", "team/payments", "--json"],
      ["switch", "--json", "team/payments"],
      ["switch", "team/payments", "--default", "--json"],
      ["switch", "--default", "--json", "team/payments"],
      ["switch", "--clear", "--json"],
      ["switch", "--clear", "--default", "--json"],
      ["switch", "--default", "--clear", "--json"],
      ["list", "--json"],
      ["live", "team/payments", "--session", "/s/abc", "--json"],
      ["live", "--session", "/s/abc", "team/payments", "--json"],
      ["live", "--show", "--session", "/s/abc", "--json"],
      ["live", "--json", "--session", "/s/abc", "--show"],
    ]) {
      expect(allowedRun(argv), argv.join(" ")).toBe(true);
    }
  });

  it("refuses anything else", () => {
    for (const argv of [
      [],
      ["--json"],
      ["list"],
      ["switch"],
      ["--json", "list"],
      ["list", "--json", "--json"],
      ["list", "extra", "--json"],
      ["switch", "--json", "--force"],
      ["switch", "--clear", "team/x", "--json"],
      ["switch", "a", "b", "--json"],
      ["switch", "--default", "--json"],
      ["switch", "--clear", "--clear", "--json"],
      ["switch", "-", "--json"],
      ["switch", "", "--json"],
      ["switch", "--json", "--", "x"],
      ["switch", "--json", "--help"],
      ["switch", "--json", "--version"],
      ["live", "x", "--session", "rel/dir", "--json"],
      ["live", "x", "--session", "--json"],
      ["live", "x", "--json"],
      ["live", "x", "--session=/s/abc", "--json"],
      ["live", "x", "--show", "--session", "/s/abc", "--json"],
      ["live", "--session", "/s/abc", "--json"],
      ["live", "x", "--session", "/a", "--session", "/b", "--json"],
      ["live", "x", "y", "--session", "/s/abc", "--json"],
      ["live", "--show", "--session", "/s/abc", "--clear", "--json"],
      ["claude", "--json"],
      ["write", "--json"],
      ["daemon", "stop", "--json"],
      ["codex", "--json"],
      ["nope", "--json"],
    ]) {
      expect(allowedRun(argv), JSON.stringify(argv)).toBe(false);
    }
  });
});

describe("runInProcess", () => {
  it("turns a throw into exit code 1 with its message", async () => {
    const io = {
      get env(): NodeJS.ProcessEnv {
        throw new Error("boom");
      },
      probe: installedProbe,
    };
    expect(await runInProcess(io, ["list", "--json"], s.repo)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "boom",
    });
  });
});

describe("POST /run", { timeout: 20_000 }, () => {
  it("runs each allowed form and answers what the CLI prints", async () => {
    const daemon = await start();
    for (const argv of [
      ["list", "--json"],
      ["switch", "--json"],
      ["switch", "team/payments", "--json"],
      ["switch", "--clear", "--json"],
      ["switch", "team/payments", "--default", "--json"],
      ["switch", "--clear", "--default", "--json"],
    ]) {
      // Both start from the same state: switches made, so --clear has one to clear.
      const before = async () => {
        await zz(["switch", "team/payments"], { cwd: s.repo, home: s.home });
        await zz(["switch", "org/base", "--default"], {
          cwd: s.repo,
          home: s.home,
        });
      };
      await before();
      const res = await run(daemon, { argv, cwd: s.repo });
      await before();
      const cli = await zz(argv, { cwd: s.repo, home: s.home });
      expect(res.status, argv.join(" ")).toBe(200);
      const body = res.body as {
        exitCode: number;
        stdout: string;
        stderr: string;
      };
      expect(body.exitCode, argv.join(" ")).toBe(cli.code);
      expect(JSON.parse(body.stdout), argv.join(" ")).toEqual(
        JSON.parse(cli.stdout),
      );
      expect(body.stderr).toBe(cli.stderr);
    }
  });

  it("uses the daemon's home", async () => {
    const daemon = await start();
    const res = await run(daemon, {
      argv: ["switch", "team/payments", "--json"],
      cwd: s.repo,
    });
    expect((res.body as { exitCode: number }).exitCode).toBe(0);
    const shown = await zz(["switch", "--json"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(JSON.parse(shown.stdout)).toMatchObject({
      persona: "team/payments",
    });
  });

  it("refuses argv outside the allowlist", async () => {
    const daemon = await start();
    for (const argv of [
      ["claude", "--json"],
      ["write", "--json"],
      ["daemon", "stop", "--json"],
      ["nope", "--json"],
      ["list"],
      ["switch", "--json", "--force"],
      ["list", "extra", "--json"],
      ["live", "x", "--session", "rel/dir", "--json"],
      ["switch", "--clear", "team/x", "--json"],
      ["switch", "a", "b", "--json"],
    ]) {
      const res = await run(daemon, { argv, cwd: s.repo });
      expect(res.status, JSON.stringify(argv)).toBe(403);
      expect(res.body).toEqual({
        error: { code: "not-allowed", message: expect.any(String) },
      });
    }
    // Nothing ran: the daemon still answers.
    expect(
      (await daemonRequest(daemon.socket, daemon.token, "GET", "/status"))
        .status,
    ).toBe(200);
  });

  it("refuses a malformed request", async () => {
    const daemon = await start();
    for (const body of [
      "not json",
      null,
      [],
      { cwd: s.repo },
      { argv: "list --json", cwd: s.repo },
      { argv: ["list", 1], cwd: s.repo },
      { argv: ["list", "--json"] },
      { argv: ["list", "--json"], cwd: 7 },
    ]) {
      const res = await daemonRequest(
        daemon.socket,
        daemon.token,
        "POST",
        "/run",
        undefined,
        body,
      );
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toEqual({
        error: { code: "bad-request", message: expect.any(String) },
      });
    }
  });

  it("refuses a body that is not JSON", async () => {
    const daemon = await start();
    const res = await new Promise<{ status: number; body: unknown }>(
      (resolve, reject) => {
        const req = request(
          {
            socketPath: daemon.socket,
            method: "POST",
            path: "/run",
            headers: { authorization: `Bearer ${daemon.token}` },
          },
          (r) => {
            let text = "";
            r.setEncoding("utf8");
            r.on("data", (chunk: string) => (text += chunk));
            r.on("end", () =>
              resolve({ status: r.statusCode ?? 0, body: JSON.parse(text) }),
            );
          },
        );
        req.on("error", reject);
        req.end("{ argv: [list");
      },
    );
    expect(res).toEqual({
      status: 400,
      body: { error: { code: "bad-request", message: expect.any(String) } },
    });
  });

  it("refuses a cwd that is not a directory", async () => {
    const daemon = await start();
    const file = join(s.root, "a-file");
    writeFileSync(file, "");
    for (const cwd of ["repo", join(s.root, "missing"), file]) {
      const res = await run(daemon, { argv: ["list", "--json"], cwd });
      expect(res.status, cwd).toBe(400);
      expect(res.body).toEqual({
        error: { code: "bad-request", message: expect.any(String) },
      });
    }
  });

  it("refuses a body over 1 MiB", async () => {
    const daemon = await start();
    const res = await run(daemon, {
      argv: ["list", "--json"],
      cwd: s.repo,
      pad: "x".repeat(1024 * 1024),
    });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      error: { code: "too-large", message: expect.any(String) },
    });
  });

  it("refuses a missing token", async () => {
    const daemon = await start();
    const res = await daemonRequest(
      daemon.socket,
      undefined,
      "POST",
      "/run",
      undefined,
      { argv: ["list", "--json"], cwd: s.repo },
    );
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });
  });

  it("answers a command that throws", async () => {
    const daemon = await start();
    // The persona store cannot be read: the command fails, the request does not.
    put(join(s.home, "config.yaml"), "personas: [unclosed\n");
    const res = await run(daemon, { argv: ["list", "--json"], cwd: s.repo });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ exitCode: 1 });
    const cli = await zz(["list", "--json"], { cwd: s.repo, home: s.home });
    expect((res.body as { stdout: string }).stdout).toBe(cli.stdout);
    expect(
      (await daemonRequest(daemon.socket, daemon.token, "GET", "/status"))
        .status,
    ).toBe(200);
  });

  it("takes the session lock for live", async () => {
    const dir = await session();
    const daemon = await start();
    // A changed file: the refresh swaps too.
    put(join(s.personas, "org/instructions/conduct.md"), "Review gently.");
    const [res] = await Promise.all([
      run(daemon, {
        argv: ["live", "project/persona", "--session", dir, "--json"],
        cwd: s.repo,
      }),
      daemon.refresh(),
    ]);
    expect(res.status).toBe(200);
    const body = res.body as { exitCode: number; stdout: string };
    expect(body.exitCode, body.stdout).toBe(0);
    const state = JSON.parse(readFileSync(join(dir, "live.json"), "utf8"));
    // The user's switch stands, whichever ran first, and plugins/ holds its plugin alone.
    expect(state.persona).toBe("project/persona");
    expect(readdirSync(join(dir, "plugins"))).toEqual([state.plugin]);
    const shown = await run(daemon, {
      argv: ["live", "--show", "--session", dir, "--json"],
      cwd: s.repo,
    });
    expect(JSON.parse((shown.body as { stdout: string }).stdout)).toMatchObject(
      { persona: "project/persona" },
    );
  });
});
