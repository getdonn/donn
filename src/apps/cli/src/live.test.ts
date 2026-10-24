import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "./session.js";
import { seed, zz, type Seeded } from "./test/seed.js";

let s: Seeded;
beforeEach(() => {
  s = seed();
  const persona = (ref: string, body: string[]) =>
    put(
      join(s.personas, `${ref}.yaml`),
      [
        "apiVersion: donn/v0",
        "kind: Persona",
        `metadata: { name: ${ref.split("/")[1]} }`,
        "extends: [org/base]",
        ...body,
        "",
      ].join("\n"),
    );
  persona("team/twin", [
    "instructions:",
    "  - { id: twin-note, inline: You are the twin. }",
  ]);
  persona("team/strict", ["permissions:", '  deny: ["Bash(kubectl:*)"]']);
});
afterEach(() => s.cleanup());

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A session launched on org/base, as `donn claude` leaves it. */
async function session(): Promise<string> {
  const plugin = join(s.root, "launched-plugin");
  put(
    join(plugin, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "donn-org--base" }),
  );
  return createSession(
    s.home,
    plugin,
    { persona: "org/base", source: "argument" },
    process.pid,
  );
}

const live = (args: string[]) =>
  zz(["live", ...args, "--json"], { cwd: s.repo, home: s.home });
const children = (dir: string) => readdirSync(join(dir, "plugins")).sort();

describe("donn live", () => {
  it("swaps the persona plugin and records the live state", async () => {
    const dir = await session();
    const r = await live(["project/persona", "--session", dir]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const state = JSON.parse(r.stdout);
    expect(state).toMatchObject({
      persona: "project/persona",
      previous: "org/base",
      launched: "org/base",
      plugin: "donn-project--persona",
      held: ["mcp", "permissions", "settings"],
    });
    expect(state.instructions.split("\n")[0]).toBe(
      "## donn persona: project/persona",
    );
    expect(children(dir)).toEqual(["donn-project--persona"]);
    expect(
      existsSync(
        join(dir, "plugins/donn-project--persona/.claude-plugin/plugin.json"),
      ),
    ).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "live.json"), "utf8"))).toEqual(
      state,
    );
  });

  it("records the build hash", async () => {
    const dir = await session();
    const r = await live(["project/persona", "--session", dir]);
    const state = JSON.parse(r.stdout);
    expect(state.buildHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(readFileSync(join(dir, "live.json"), "utf8"))).toEqual(
      state,
    );
  });

  it("holds nothing when MCP and permissions match", async () => {
    const dir = await session();
    const state = JSON.parse(
      (await live(["team/twin", "--session", dir])).stdout,
    );
    expect(state).toMatchObject({ held: [], stricter: false });
  });

  it("flags a persona that denies more", async () => {
    const dir = await session();
    const state = JSON.parse(
      (await live(["team/strict", "--session", dir])).stdout,
    );
    expect(state).toMatchObject({ held: ["permissions"], stricter: true });
  });

  it("a failed switch changes nothing", async () => {
    const dir = await session();
    await live(["team/twin", "--session", dir]);
    const before = readFileSync(join(dir, "live.json"), "utf8");
    for (const bad of ["team/nope", "team/payments"]) {
      const r = await live([bad, "--session", dir]);
      expect(r.code, bad).toBe(1);
      expect(children(dir), bad).toEqual(["donn-team--twin"]);
      expect(readFileSync(join(dir, "live.json"), "utf8"), bad).toBe(before);
    }
  });

  it("explains when live switching is unavailable", async () => {
    const message = async (dir: string) =>
      JSON.parse((await live(["team/twin", "--session", dir])).stdout).error;
    expect(await message(join(s.root, "gone"))).toMatchObject({
      code: "live-unavailable",
      message:
        "live switching is unavailable: the session folder is gone; relaunch",
    });
    const bare = join(s.root, "bare");
    mkdirSync(bare);
    expect(await message(bare)).toMatchObject({
      code: "live-unavailable",
      message:
        "live switching is unavailable: live switching needs a session started by donn claude",
    });
    const partial = await session();
    rmSync(join(partial, "plugins"), { recursive: true });
    expect(await message(partial)).toMatchObject({
      code: "live-unavailable",
      message:
        "live switching is unavailable: managed settings block --plugin-dir",
    });
  });

  it("shows the live state, or the launched persona before any switch", async () => {
    const dir = await session();
    expect(
      JSON.parse((await live(["--show", "--session", dir])).stdout),
    ).toEqual({ launched: "org/base" });
    await live(["team/twin", "--session", dir]);
    expect(
      JSON.parse((await live(["--show", "--session", dir])).stdout),
    ).toMatchObject({ persona: "team/twin", launched: "org/base" });
  });
});

describe("donn live against the launch snapshot", () => {
  /** A session launched on `ref`, with the snapshot donn claude records. */
  async function launchedOn(ref: string, overlay = true): Promise<string> {
    const resolved = await zz(
      ["resolve", ref, "--json", ...(overlay ? [] : ["--no-overlay"])],
      { cwd: s.repo, home: s.home },
    );
    const { ir } = JSON.parse(resolved.stdout);
    const plugin = join(s.root, `plugin-${ref.replace("/", "-")}`);
    put(
      join(plugin, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: `donn-${ref.replace("/", "--")}` }),
    );
    return createSession(
      s.home,
      plugin,
      {
        persona: ref,
        source: "argument",
        overlay,
        snapshot: {
          mcp: ir.mcp,
          permissions: ir.permissions,
          settings: ir.targets["claude-code"] ?? {},
        },
      },
      process.pid,
    );
  }
  const persona = (ref: string, body: string[]) =>
    put(
      join(s.personas, `${ref}.yaml`),
      [
        "apiVersion: donn/v0",
        "kind: Persona",
        `metadata: { name: ${ref.split("/")[1]} }`,
        "extends: [org/base]",
        ...body,
        "",
      ].join("\n"),
    );

  it("still switches when the launched persona no longer resolves", async () => {
    persona("team/launched", []);
    const dir = await launchedOn("team/launched");
    rmSync(join(s.personas, "team/launched.yaml"));
    const r = await live(["team/twin", "--session", dir]);
    expect(r.code, r.stdout).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ held: [] });
  });

  it("holds launched Claude Code settings such as defaultMode", async () => {
    persona("team/bypass", [
      "targets:",
      "  claude-code:",
      "    permissions: { defaultMode: bypassPermissions }",
    ]);
    const dir = await launchedOn("team/bypass");
    const state = JSON.parse(
      (await live(["team/twin", "--session", dir])).stdout,
    );
    expect(state.held).toEqual(["settings"]);
  });

  it("resolves with the overlay setting the session was launched with", async () => {
    const dir = await launchedOn("org/base", false);
    const state = JSON.parse(
      (await live(["team/twin", "--session", dir])).stdout,
    );
    expect(state.held).toEqual([]);
  });

  it("serializes concurrent switches, leaving exactly the recorded persona", async () => {
    const dir = await session();
    await Promise.all([
      live(["team/twin", "--session", dir]),
      live(["team/strict", "--session", dir]),
    ]);
    const recorded = JSON.parse(readFileSync(join(dir, "live.json"), "utf8"));
    expect(children(dir)).toEqual([recorded.plugin]);
  });
});
