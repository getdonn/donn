import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CompileOutput } from "@zzpersona/adapter-sdk";
import { createLocalStore } from "@zzpersona/store-local";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutorError, writeBuild } from "./index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "zzp-build-"));
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
