import {
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findBuildLeftovers, removeBuildLeftovers } from "./index.js";

const dirs: string[] = [];
const anHourAgo = () => new Date(Date.now() - 60 * 60 * 1000);
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("build maintenance", () => {
  it("finds and removes stale locks, orphaned versions and temp links", async () => {
    const home = mkdtempSync(join(tmpdir(), "zzp-maint-"));
    dirs.push(home);
    const persona = join(home, "build/team-p-12345678");
    mkdirSync(join(persona, "claude-code.v-aaaa1111"), { recursive: true });
    symlinkSync("claude-code.v-aaaa1111", join(persona, "claude-code"));
    mkdirSync(join(persona, "claude-code.v-bbbb2222"));
    mkdirSync(join(persona, "claude-code.lock"));
    writeFileSync(join(persona, "claude-code.lock/pid"), "999999");
    symlinkSync(
      "claude-code.v-aaaa1111",
      join(persona, "claude-code.link-cccc3333"),
    );
    utimesSync(
      join(persona, "claude-code.v-bbbb2222"),
      anHourAgo(),
      anHourAgo(),
    );
    lutimesSync(
      join(persona, "claude-code.link-cccc3333"),
      anHourAgo(),
      anHourAgo(),
    );

    const leftovers = await findBuildLeftovers(home);
    expect(leftovers).toEqual({
      staleLocks: [join(persona, "claude-code.lock")],
      orphanVersions: [join(persona, "claude-code.v-bbbb2222")],
      tempLinks: [join(persona, "claude-code.link-cccc3333")],
    });
    await removeBuildLeftovers(leftovers);
    expect(readdirSync(persona).sort()).toEqual([
      "claude-code",
      "claude-code.v-aaaa1111",
    ]);
  });

  it("keeps a lock whose owner is alive, and copes with no build folder", async () => {
    const home = mkdtempSync(join(tmpdir(), "zzp-maint-"));
    dirs.push(home);
    expect(await findBuildLeftovers(home)).toEqual({
      staleLocks: [],
      orphanVersions: [],
      tempLinks: [],
    });
    const lock = join(home, "build/x/claude-code.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), String(process.pid));
    expect((await findBuildLeftovers(home)).staleLocks).toEqual([]);
  });

  it("keeps recent versions, temp links and pid-less locks: a build may be writing them", async () => {
    const home = mkdtempSync(join(tmpdir(), "zzp-maint-"));
    dirs.push(home);
    const persona = join(home, "build/team-p-12345678");
    mkdirSync(join(persona, "claude-code.v-dddd4444"), { recursive: true });
    mkdirSync(join(persona, "claude-code.lock"));
    symlinkSync(
      "claude-code.v-dddd4444",
      join(persona, "claude-code.link-eeee5555"),
    );
    expect(await findBuildLeftovers(home)).toEqual({
      staleLocks: [],
      orphanVersions: [],
      tempLinks: [],
    });

    utimesSync(join(persona, "claude-code.lock"), anHourAgo(), anHourAgo());
    expect((await findBuildLeftovers(home)).staleLocks).toEqual([
      join(persona, "claude-code.lock"),
    ]);
  });
});
