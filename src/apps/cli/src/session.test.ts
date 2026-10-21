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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSession,
  findOrphanSessions,
  removeSession,
  sessionPlugins,
} from "./session.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zzp-session-"));
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
      plugin("zzp-team--payments"),
      { persona: "team/payments", source: "switch" },
      4242,
    );
    expect(dir).toMatch(
      new RegExp(`^${join(home(), "sessions")}/[0-9a-f]{16}$`),
    );
    expect(sessionPlugins(dir)).toBe(join(dir, "plugins"));
    expect(
      readFileSync(
        join(dir, "plugins/zzp-team--payments/skills/s/SKILL.md"),
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
    const src = plugin("zzp-x");
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
