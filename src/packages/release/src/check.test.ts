import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { checkTarball, REPOSITORY_URL } from "./check.js";
import type { PublicPackage, Workspace } from "./packages.js";
import { realRunner } from "./run.js";
import { withTarball } from "./tarball.js";

type Json = Record<string, unknown>;

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0))
    rmSync(d, { recursive: true, force: true });
});

/** Builds a real tarball with `package/<file>` entries and reads it back. */
async function pack(
  files: Record<string, string>,
  manifest: Json,
  source: Json = manifest,
  all: Workspace[] = [],
) {
  const root = mkdtempSync(join(tmpdir(), "release-check-"));
  cleanup.push(root);
  const base = join(root, "src");
  const entries: Record<string, string> = {
    "package.json": JSON.stringify(manifest),
    "README.md": "r",
    LICENSE: "l",
    NOTICE: "n",
    ...files,
  };
  for (const [name, body] of Object.entries(entries)) {
    if (body === "\0skip") continue;
    const path = join(base, "package", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  const tgz = join(root, "p.tgz");
  const res = await realRunner("tar", ["-czf", tgz, "-C", base, "package"]);
  expect(res.code).toBe(0);
  const pkg: PublicPackage = {
    name: "@getdonn/pkg",
    version: "1.0.0",
    dir: root,
    private: false,
    manifest: source,
    deps: [],
  };
  return withTarball(tgz, realRunner, (c) => checkTarball(c, pkg, all));
}

const good: Json = {
  name: "@getdonn/pkg",
  version: "1.0.0",
  repository: { type: "git", url: REPOSITORY_URL, directory: "x" },
  main: "./dist/index.js",
  bin: { donn: "dist/bin.js" },
  exports: {
    ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
  },
  files: ["dist"],
};
const dist = {
  "dist/index.js": "1",
  "dist/index.d.ts": "1",
  "dist/bin.js": "1",
};

describe("withTarball", () => {
  it("removes the extraction directory afterwards, even on error", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-check-"));
    cleanup.push(root);
    mkdirSync(join(root, "package"));
    writeFileSync(join(root, "package", "package.json"), "{}");
    const tgz = join(root, "p.tgz");
    await realRunner("tar", ["-czf", tgz, "-C", root, "package"]);
    let dir = "";
    await withTarball(tgz, realRunner, (c) => {
      dir = c.dir;
      expect(existsSync(dir)).toBe(true);
    });
    expect(existsSync(dir)).toBe(false);
    await expect(
      withTarball(tgz, realRunner, (c) => {
        dir = c.dir;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(dir)).toBe(false);
  });
});

describe("checkTarball", () => {
  it("a good tarball has no problems", async () => {
    expect(await pack({ ...dist, "CHANGELOG.md": "c" }, good)).toEqual([]);
  });

  it.each(["workspace:*", "link:../x", "file:../x"])(
    "%s in any dependency field is reported",
    async (spec) => {
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        const problems = await pack(dist, {
          ...good,
          [field]: { "@x/y": spec },
        });
        expect(problems.join("\n")).toContain(`${field}.@x/y is still ${spec}`);
      }
    },
  );

  it("a missing LICENSE, NOTICE, README.md or package.json is reported", async () => {
    for (const f of ["LICENSE", "NOTICE", "README.md"]) {
      const problems = await pack({ ...dist, [f]: "\0skip" }, good);
      expect(problems).toEqual([`missing ${f}`]);
    }
    const problems = await pack({ ...dist, "package.json": "\0skip" }, good);
    expect(problems).toEqual(["missing package.json"]);
  });

  it("an exports/bin/main target missing from the tarball is reported", async () => {
    const manifest = {
      ...good,
      main: "./dist/main.js",
      bin: { donn: "dist/cli.js" },
      exports: {
        ".": { import: { types: "./dist/t.d.ts", default: "./dist/i.js" } },
      },
    };
    const problems = await pack({ "dist/x.js": "1" }, manifest);
    expect(problems.sort()).toEqual([
      "target dist/cli.js is not in the tarball",
      "target dist/i.js is not in the tarball",
      "target dist/main.js is not in the tarball",
      "target dist/t.d.ts is not in the tarball",
    ]);
  });

  it("files outside dist and the allowed list are reported", async () => {
    const problems = await pack(
      { ...dist, "src/x.ts": "1", "dist/x.js.map": "1", "openapi.json": "{}" },
      good,
    );
    expect(problems.sort()).toEqual([
      "unexpected file dist/x.js.map",
      "unexpected file openapi.json",
      "unexpected file src/x.ts",
    ]);
    const declared = { ...good, files: ["dist", "openapi.json"] };
    expect(
      await pack(
        { ...dist, "openapi.json": "{}", "src/x.ts": "1" },
        good,
        declared,
      ),
    ).toEqual(["unexpected file src/x.ts"]);
  });

  it("a wrong repository.url is reported", async () => {
    const problems = await pack(dist, {
      ...good,
      repository: { url: "git+https://github.com/other/donn.git" },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("repository.url");
  });

  it("a dependency on a private @getdonn package is reported", async () => {
    const priv: Workspace = {
      name: "@getdonn/secret",
      version: "1.0.0",
      dir: "/x",
      private: true,
      manifest: {},
    };
    const problems = await pack(
      dist,
      { ...good, dependencies: { "@getdonn/secret": "1.0.0" } },
      good,
      [priv],
    );
    expect(problems).toEqual([
      "dependencies.@getdonn/secret is a private package",
    ]);
  });
});
