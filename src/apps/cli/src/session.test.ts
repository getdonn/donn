import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompileOutput } from "@getdonn/adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  buildHash,
  createSession,
  findOrphanSessions,
  listSessions,
  removeSession,
  sessionPlugins,
} from "./session.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "donn-session-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A built persona plugin, as writeBuild leaves it. */
function plugin(name: string) {
  const dir = join(root, "build", name, "plugin");
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(dir, ".claude-plugin/plugin.json"),
    JSON.stringify({ name }),
  );
  mkdirSync(join(dir, "skills/s"), { recursive: true });
  writeFileSync(join(dir, "skills/s/SKILL.md"), "skill");
  return dir;
}

const home = () => join(root, "home");

describe("session folders", () => {
  it("copies the plugin under its name and records the launch", async () => {
    const dir = await createSession(
      home(),
      plugin("donn-team--payments"),
      { persona: "team/payments", source: "switch" },
      4242,
    );
    expect(dir).toMatch(
      new RegExp(`^${join(home(), "sessions")}/[0-9a-f]{16}$`),
    );
    expect(sessionPlugins(dir)).toBe(join(dir, "plugins"));
    expect(
      readFileSync(
        join(dir, "plugins/donn-team--payments/skills/s/SKILL.md"),
        "utf8",
      ),
    ).toBe("skill");
    expect(
      JSON.parse(readFileSync(join(dir, "launched.json"), "utf8")),
    ).toEqual({ persona: "team/payments", source: "switch", pid: 4242 });
    await removeSession(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("finds only old sessions whose process is gone", async () => {
    const src = plugin("donn-x");
    const dead = await createSession(
      home(),
      src,
      { persona: "x", source: "argument" },
      999999,
    );
    const live = await createSession(
      home(),
      src,
      { persona: "x", source: "argument" },
      process.pid,
    );
    const fresh = await createSession(
      home(),
      src,
      { persona: "x", source: "argument" },
      999999,
    );
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    for (const dir of [dead, live]) utimesSync(dir, twoDaysAgo, twoDaysAgo);
    expect(await findOrphanSessions(home(), Date.now())).toEqual([dead]);
    expect(fresh).toBeTruthy();
  });

  it("finds nothing without a sessions folder", async () => {
    expect(await findOrphanSessions(home(), Date.now())).toEqual([]);
  });
});

describe("session registry", () => {
  it("reads an old launched.json as claude-code", async () => {
    const dir = await createSession(
      home(),
      plugin("donn-x"),
      { persona: "x", source: "argument" },
      process.pid,
    );
    const [info] = await listSessions(home());
    expect(info!.dir).toBe(dir);
    expect(info!.launched.harness).toBe("claude-code");
  });

  it("lists sessions with liveness", async () => {
    const src = plugin("donn-x");
    const child = spawnSync(process.execPath, ["-e", "0"]);
    const alive = await createSession(
      home(),
      src,
      { persona: "a", source: "argument", startedAt: "2026-01-01T00:00:00Z" },
      process.pid,
    );
    const dead = await createSession(
      home(),
      src,
      { persona: "b", source: "argument", startedAt: "2026-01-02T00:00:00Z" },
      child.pid,
    );
    mkdirSync(join(home(), "sessions/broken"), { recursive: true });
    writeFileSync(join(home(), "sessions/broken/launched.json"), "{nope");
    const list = await listSessions(home());
    expect(list.map((i) => [i.dir, i.running])).toEqual([
      [alive, true],
      [dead, false],
    ]);
  });

  it("creates a plugin-less session for Codex", async () => {
    const dir = await createSession(
      home(),
      undefined,
      { persona: "x", source: "argument", harness: "codex" },
      process.pid,
    );
    expect(existsSync(sessionPlugins(dir))).toBe(false);
    expect((await listSessions(home()))[0]!.launched.harness).toBe("codex");
  });

  it("returns nothing without a sessions folder", async () => {
    expect(await listSessions(home())).toEqual([]);
  });
});

describe("buildHash", () => {
  const output = (content: string): CompileOutput => ({
    files: {
      "b.txt": { content },
      "a.txt": { copyFrom: "skills/a", mode: 0o755 },
    },
    secretEnv: {},
    report: { dropped: [], notes: [] } as never,
  });

  it("hashes the same build the same", () => {
    const flipped: CompileOutput = {
      ...output("one"),
      files: Object.fromEntries(Object.entries(output("one").files).reverse()),
    };
    expect(buildHash(output("one"))).toBe(buildHash(flipped));
    expect(buildHash(output("one"))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with a one-byte change", () => {
    expect(buildHash(output("one"))).not.toBe(buildHash(output("onf")));
  });
});
