import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CompileOutput } from "@getdonn/adapter-sdk";
import { createLocalStore } from "@getdonn/store-local";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutorError, writeBuild } from "./index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "donn-build-"));
  dirs.push(root);
  const personas = join(root, "personas");
  const put = (path: string, content = "x") => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  put(join(personas, "team/skills/s/SKILL.md"), "skill");
  put(join(personas, "org/hooks/run.sh"), "#!/bin/sh");
  put(join(root, "outside.txt"), "secret stuff");
  const store = createLocalStore({ personas, user: join(root, "home") });
  const buildDir = join(root, "home/build/team-p-12345678/claude-code");
  return { root, personas, store, buildDir, put };
}

const output = (files: CompileOutput["files"]): CompileOutput => ({
  files,
  secretEnv: {},
  report: { adapter: "toy", irVersion: 0, entries: [] },
});

describe("writeBuild", () => {
  it("writes content and copies, with modes", async () => {
    const { store, buildDir } = setup();
    await writeBuild(
      output({
        "settings.json": { content: "{}" },
        "plugin/skills/s": { copyFrom: "team/skills/s" },
        "plugin/hooks/scripts/run.sh": {
          copyFrom: "org/hooks/run.sh",
          mode: 0o755,
        },
      }),
      { buildDir, store },
    );
    expect(readFileSync(join(buildDir, "settings.json"), "utf8")).toBe("{}");
    expect(statSync(join(buildDir, "settings.json")).mode & 0o777).toBe(0o644);
    expect(
      readFileSync(join(buildDir, "plugin/skills/s/SKILL.md"), "utf8"),
    ).toBe("skill");
    expect(
      statSync(join(buildDir, "plugin/hooks/scripts/run.sh")).mode & 0o777,
    ).toBe(0o755);
    expect(statSync(dirname(dirname(buildDir))).mode & 0o777).toBe(0o700);
  });

  it("replaces a previous build", async () => {
    const { store, buildDir } = setup();
    await writeBuild(output({ "a.txt": { content: "1" } }), {
      buildDir,
      store,
    });
    await writeBuild(output({ "b.txt": { content: "2" } }), {
      buildDir,
      store,
    });
    expect(existsSync(join(buildDir, "a.txt"))).toBe(false);
    expect(readFileSync(join(buildDir, "b.txt"), "utf8")).toBe("2");
  });

  it("refuses a copyFrom that escapes its mount, leaving the old build intact", async () => {
    const { store, buildDir } = setup();
    await writeBuild(output({ "keep.txt": { content: "old" } }), {
      buildDir,
      store,
    });
    await expect(
      writeBuild(output({ x: { copyFrom: "team/../../outside.txt" } }), {
        buildDir,
        store,
      }),
    ).rejects.toThrow(ExecutorError);
    expect(readFileSync(join(buildDir, "keep.txt"), "utf8")).toBe("old");
    expect(
      readFileSync(join(buildDir, "keep.txt"), "utf8") +
        String(existsSync(`${buildDir}.tmp`)),
    ).toBe("oldfalse");
  });

  it("refuses a symlink inside a copied directory that points outside the mount", async () => {
    const { root, personas, store, buildDir } = setup();
    symlinkSync(
      join(root, "outside.txt"),
      join(personas, "team/skills/s/leak.txt"),
    );
    await expect(
      writeBuild(output({ "plugin/skills/s": { copyFrom: "team/skills/s" } }), {
        buildDir,
        store,
      }),
    ).rejects.toThrow(/outside/);
  });

  it("refuses a copyFrom with no mount", async () => {
    const { store, buildDir } = setup();
    await expect(
      writeBuild(output({ x: { copyFrom: "project/a.md" } }), {
        buildDir,
        store,
      }),
    ).rejects.toThrow(ExecutorError);
  });
});

describe("review fixes", () => {
  it("turns filesystem errors into an ExecutorError naming the source (I1)", async () => {
    const { personas, store, buildDir } = setup();
    symlinkSync("..", join(personas, "team/skills/s/loop"));
    const error = await writeBuild(
      output({ "plugin/skills/s": { copyFrom: "team/skills/s" } }),
      { buildDir, store },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExecutorError);
    expect((error as Error).message).toContain("team/skills/s");
  });

  it("survives concurrent builds of the same persona (I2)", async () => {
    const { store, buildDir } = setup();
    const builds = Array.from({ length: 8 }, (_, i) =>
      writeBuild(
        output({
          "settings.json": { content: String(i) },
          "plugin/skills/s": { copyFrom: "team/skills/s" },
        }),
        { buildDir, store },
      ),
    );
    await expect(Promise.all(builds)).resolves.toBeDefined();
    expect(readFileSync(join(buildDir, "settings.json"), "utf8")).toMatch(
      /^[0-7]$/,
    );
    expect(
      readFileSync(join(buildDir, "plugin/skills/s/SKILL.md"), "utf8"),
    ).toBe("skill");
    const leftovers = readdirSync(dirname(buildDir)).filter(
      (name) => name !== "claude-code",
    );
    expect(leftovers).toHaveLength(1); // the one version the build directory points to
  });

  it("swaps builds atomically: the build directory is never missing (I2)", async () => {
    const { store, buildDir } = setup();
    await writeBuild(
      output({ "keep.txt": { content: "" }, "a.txt": { content: "1" } }),
      { buildDir, store },
    );
    expect(lstatSync(buildDir).isSymbolicLink()).toBe(true);
    // One path every build has: two checks (a.txt, then b.txt) could straddle a swap.
    let missing = false;
    const watch = setInterval(() => {
      if (!existsSync(join(buildDir, "keep.txt"))) missing = true;
    }, 0);
    for (let i = 0; i < 20; i++) {
      await writeBuild(
        output({
          "keep.txt": { content: "" },
          [i % 2 ? "a.txt" : "b.txt"]: { content: "x" },
        }),
        {
          buildDir,
          store,
        },
      );
    }
    clearInterval(watch);
    expect(missing).toBe(false);
  });
});
