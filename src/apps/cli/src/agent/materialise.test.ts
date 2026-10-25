import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEve } from "../test/fake-eve.js";
import { quietIo } from "../test/seed.js";
import { placeTemplate, stageTemplate } from "./materialise.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "donn-materialise-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

describe("stageTemplate", () => {
  it("copies a path template without .git or node_modules", async () => {
    put("tpl/package.json", "{}");
    put("tpl/agent/agent.ts", "x");
    put("tpl/.git/HEAD", "ref");
    put("tpl/node_modules/eve/index.js", "x");
    put("tpl/agent/deep/.git", "gitdir: ../x");
    const io = quietIo({ cwd: root, home: root });
    const staging = await stageTemplate(
      io,
      { kind: "path", dir: join(root, "tpl") },
      "0.83.2",
      { stagingBase: join(root, "stage") },
    );
    try {
      expect(readFileSync(join(staging, "agent/agent.ts"), "utf8")).toBe("x");
      expect(existsSync(join(staging, ".git"))).toBe(false);
      expect(existsSync(join(staging, "agent/deep/.git"))).toBe(false);
      expect(existsSync(join(staging, "node_modules"))).toBe(false);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it("refuses eve:blank when a workspace or package sits above the staging folder", async () => {
    put("outer/package.json", "{}");
    mkdirSync(join(root, "outer/stage"), { recursive: true });
    const spawn = fakeEve();
    const io = { ...quietIo({ cwd: root, home: root }), spawn };
    await expect(
      stageTemplate(io, { kind: "blank", name: "a" }, "0.83.2", {
        stagingBase: join(root, "outer/stage"),
      }),
    ).rejects.toMatchObject({
      code: "ancestor-workspace",
      details: { file: join(root, "outer/package.json") },
    });
    expect(spawn.calls).toEqual([]);
  });

  it("reports eve init's failure with its last lines", async () => {
    const spawn = fakeEve({
      replies: [
        {
          eve: ["init"],
          lines: ["An eve project already exists"],
          exitCode: 1,
        },
      ],
    });
    const io = { ...quietIo({ cwd: root, home: root }), spawn };
    await expect(
      stageTemplate(io, { kind: "blank", name: "a" }, "0.83.2", {
        stagingBase: join(root, "stage"),
      }),
    ).rejects.toMatchObject({
      code: "eve-failed",
      details: { tail: ["An eve project already exists"] },
    });
    expect(spawn.calls[0]?.args.slice(0, 4)).toEqual([
      "--package=eve@0.83.2",
      "dlx",
      "eve",
      "init",
    ]);
  });
});

describe("placeTemplate", () => {
  it("moves the staged files into an empty or missing folder, leaving the staged install behind", async () => {
    put("stage/package.json", "{}");
    put("stage/agent/agent.ts", "x");
    put("stage/node_modules/eve/index.js", "x");
    mkdirSync(join(root, "dest"));
    await placeTemplate(join(root, "stage"), join(root, "dest"));
    expect(readFileSync(join(root, "dest/agent/agent.ts"), "utf8")).toBe("x");
    expect(existsSync(join(root, "dest/node_modules"))).toBe(false);
    await placeTemplate(join(root, "stage"), join(root, "new/dest"));
    expect(existsSync(join(root, "new/dest/package.json"))).toBe(true);
  });
});
