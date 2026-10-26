import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliVersion } from "./commands/daemon.js";
import { startDaemon, type Daemon } from "./daemon/server.js";
import { installedProbe, seed, zz, type Seeded } from "./test/seed.js";

// `donn ui`: asks the daemon for its bridge and opens the one-time-code URL.
// See docs/planning/26-gui.md §1.

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

async function daemon(uiDir?: string) {
  const d = await startDaemon({
    home: s.home,
    env: {},
    version: cliVersion(),
    debounceMs: 50,
    probe: installedProbe,
    ...(uiDir && { bridge: { uiDir } }),
  });
  daemons.push(d);
  return d;
}

/** A built app to serve, so no test depends on `dist/ui`. */
function builtApp(): string {
  const dir = join(s.root, "ui-dist");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>x</title>");
  return dir;
}

function exchange(port: number, code: string) {
  return new Promise<number>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/session",
        headers: {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          "content-type": "application/json",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ code }));
  });
}

const run = (argv: string[], opened: string[] = []) =>
  zz(["ui", ...argv], {
    cwd: s.repo,
    home: s.home,
    openBrowser: async (url) => void opened.push(url),
  });

describe("donn ui", { timeout: 20_000 }, () => {
  it("--no-open --json gives a URL whose code exchanges once", async () => {
    await daemon(builtApp());
    const opened: string[] = [];
    const r = await run(["--no-open", "--json"], opened);
    expect(r.code).toBe(0);
    expect(opened).toEqual([]);
    const { url, port } = JSON.parse(r.stdout) as { url: string; port: number };
    expect(url).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${port}/#t=[A-Za-z0-9_-]{43}$`),
    );
    const code = url.split("#t=")[1]!;
    expect(await exchange(port, code)).toBe(200);
    expect(await exchange(port, code)).not.toBe(200);
  });

  it("opens the browser and prints the URL without the code", async () => {
    await daemon(builtApp());
    const opened: string[] = [];
    const r = await run([], opened);
    expect(r.code).toBe(0);
    expect(opened).toHaveLength(1);
    const code = opened[0]!.split("#t=")[1]!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.stdout).toMatch(
      /^donn ui at http:\/\/127\.0\.0\.1:\d+\/ \(opened in your browser\)\n$/,
    );
    expect(r.stdout + r.stderr).not.toContain(code);
  });

  it("--no-open prints the full URL and says the code is single-use", async () => {
    await daemon(builtApp());
    const r = await run(["--no-open"]);
    expect(r.stdout).toMatch(/http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]{43}/);
    expect(r.stdout).toMatch(/once/);
    expect(r.stdout).toMatch(/60 s/);
  });

  it("honours --port", async () => {
    await daemon(builtApp());
    const probe = JSON.parse((await run(["--no-open", "--json"])).stdout) as {
      port: number;
    };
    // A second daemon-less ask for the same bridge returns its port; ask for a free one.
    await daemons[0]!.close();
    daemons.length = 0;
    await daemon(builtApp());
    const r = await run(["--no-open", "--json", "--port", `${probe.port}`]);
    expect(JSON.parse(r.stdout)).toMatchObject({ port: probe.port });
  });

  it.each(["80", "1023", "65536", "abc", "1.5"])(
    "refuses --port %s",
    async (port) => {
      await daemon(builtApp());
      const r = await run(["--no-open", "--json", "--port", port]);
      expect(r.code).not.toBe(0);
      expect(JSON.parse(r.stderr + r.stdout)).toMatchObject({
        error: { code: "usage" },
      });
    },
  );

  it("fails with ui-disabled when daemon.ui is false", async () => {
    writeFileSync(
      join(s.home, "config.yaml"),
      `personas: ${s.personas}\ndaemon:\n  ui: false\n`,
    );
    await daemon(builtApp());
    const r = await run(["--no-open", "--json"]);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stderr + r.stdout)).toMatchObject({
      error: { code: "ui-disabled" },
    });
  });

  it("says to start the daemon when none runs and auto-start is off", async () => {
    writeFileSync(
      join(s.home, "config.yaml"),
      `personas: ${s.personas}\ndaemon:\n  autoStart: false\n`,
    );
    const r = await run(["--no-open", "--json"]);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stderr + r.stdout)).toMatchObject({
      error: { code: "daemon", fix: "donn daemon start" },
    });
  });

  it("warns with the build command when the app is not built", async () => {
    await daemon(join(s.root, "no-such-dist"));
    const r = await run(["--no-open", "--json"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("pnpm --filter @getdonn/ui build");
    expect(JSON.parse(r.stdout)).toHaveProperty("url");
  });

  it("does not warn when the app is built", async () => {
    await daemon(builtApp());
    const r = await run(["--no-open", "--json"]);
    expect(r.stderr).toBe("");
  });
});
