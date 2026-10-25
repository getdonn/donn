import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { quietIo, seed, zz } from "../test/seed.js";
import { fakeEve } from "../test/fake-eve.js";
import { eveEnv, packageManager, runEve } from "./eve.js";
import { nodeSpawn } from "./spawn.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "donn-eve-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("eveEnv", () => {
  it("drops the dev and test switches and forces production", () => {
    const env = eveEnv(
      {
        PATH: "/bin",
        NODE_ENV: "test",
        EVE_DEV: "1",
        EVE_MOCK_AUTHORED_MODELS: "1",
        VITEST: "true",
      },
      { A: "b" },
    );
    expect(env).toEqual({ PATH: "/bin", NODE_ENV: "production", A: "b" });
  });

  it("does not let extra bring the switches or a NODE_ENV back", () => {
    const env = eveEnv(
      { PATH: "/bin" },
      {
        NODE_ENV: "test",
        VITEST: "1",
        EVE_DEV: "1",
        EVE_MOCK_AUTHORED_MODELS: "1",
        A: "b",
      },
    );
    expect(env).toEqual({ PATH: "/bin", NODE_ENV: "production", A: "b" });
  });
});

describe("packageManager", () => {
  it("reads package.json, defaulting to pnpm", async () => {
    expect(await packageManager(dir)).toBe("pnpm");
    writeFileSync(join(dir, "package.json"), '{"packageManager":"npm@11.0.0"}');
    expect(await packageManager(dir)).toBe("npm");
    writeFileSync(
      join(dir, "package.json"),
      '{"packageManager":"pnpm@12.0.0"}',
    );
    expect(await packageManager(dir)).toBe("pnpm");
  });
});

describe("runEve", () => {
  const io = (spawn: ReturnType<typeof fakeEve>) => ({
    ...quietIo({ cwd: dir, home: dir, env: { VITEST: "true" } }),
    spawn,
  });

  it("runs `<pm> exec eve …` in the folder with the child env", async () => {
    const spawn = fakeEve();
    await runEve(io(spawn), dir, ["build"], { env: { X: "1" } });
    writeFileSync(join(dir, "package.json"), '{"packageManager":"npm@11.0.0"}');
    await runEve(io(spawn), dir, ["build"], { env: {} });
    expect(spawn.calls.map((c) => [c.command, ...c.args])).toEqual([
      ["pnpm", "exec", "eve", "build"],
      ["npm", "exec", "eve", "build"],
    ]);
    expect(spawn.calls[0]?.cwd).toBe(dir);
    expect(spawn.calls[0]?.env).toMatchObject({
      X: "1",
      NODE_ENV: "production",
    });
    expect(spawn.calls[0]?.env.VITEST).toBeUndefined();
  });

  it("streams lines in order from both streams and keeps the last 20", async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `l${i}`);
    const spawn = fakeEve({
      replies: [
        {
          lines: [...lines, { line: "err", stream: "stderr" }],
          exitCode: 1,
        },
      ],
    });
    const seen: string[] = [];
    const result = await runEve(io(spawn), dir, ["build"], {
      env: {},
      onProgress: (l) => seen.push(l),
    });
    expect(seen).toEqual([...lines, "err"]);
    expect(result.exitCode).toBe(1);
    expect(result.tail).toHaveLength(20);
    expect(result.tail.at(-1)).toBe("err");
    expect(result.tail[0]).toBe("l6");
  });

  it("matches replies by the arguments after eve and runs effects", async () => {
    const spawn = fakeEve({
      replies: [{ eve: ["init"], lines: ["init"], exitCode: 3 }],
      fallback: { lines: ["other"] },
    });
    expect((await runEve(io(spawn), dir, ["init"], { env: {} })).tail).toEqual([
      "init",
    ]);
    expect((await runEve(io(spawn), dir, ["dev"], { env: {} })).exitCode).toBe(
      0,
    );
  });
});

describe("nodeSpawn", () => {
  it("splits lines on both streams, including a last line without newline", async () => {
    const seen: [string, string][] = [];
    const child = nodeSpawn(
      process.execPath,
      [
        "-e",
        "process.stdout.write('a\\nb'); process.stderr.write('e\\n'); process.stdin.pipe(process.stdout)",
      ],
      {
        cwd: dir,
        env: process.env,
        stdin: "\nin",
        onLine: (l, s) => seen.push([s, l]),
      },
    );
    expect(await child.exited).toBe(0);
    expect(seen.filter(([s]) => s === "stderr")).toEqual([["stderr", "e"]]);
    expect(seen.filter(([s]) => s === "stdout").map(([, l]) => l)).toEqual([
      "a",
      "b",
      "in",
    ]);
  });

  it("kills the process group of a detached child", async () => {
    const child = nodeSpawn(
      process.execPath,
      ["-e", "setTimeout(()=>{},60000)"],
      {
        cwd: dir,
        env: process.env,
        detached: true,
      },
    );
    child.kill("SIGTERM");
    expect(await child.exited).toBe(128 + 15);
  });
});

describe("donn agent list", () => {
  it("is registered", async () => {
    const s = seed();
    try {
      const r = await zz(["agent", "list", "--json"], {
        cwd: s.repo,
        home: s.home,
      });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ agents: [] });
    } finally {
      s.cleanup();
    }
  });
});
