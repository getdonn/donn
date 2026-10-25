import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEve } from "../test/fake-eve.js";
import { quietIo } from "../test/seed.js";
import {
  dependenciesFor,
  ignoreGenerated,
  install,
  prepareInstall,
} from "./install.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "donn-install-"));
  writeFileSync(
    join(dir, "package.json"),
    '{\n  "name": "a",\n  "dependencies": { "eve": "^0.80.0" }\n}\n',
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = (file: string) => readFileSync(join(dir, file), "utf8");

describe("dependenciesFor", () => {
  it("adds ai, the provider packages the compile imports, the world and the Vercel CLI", () => {
    const files = {
      "agent/lib/donn/config.ts": {
        content: 'import { createAnthropic } from "@ai-sdk/anthropic";\n',
      },
    };
    expect(
      dependenciesFor(files, { target: "self-host", world: "postgres" }),
    ).toEqual({
      dependencies: {
        ai: "^7.0.152",
        "@ai-sdk/anthropic": "^4",
        "@workflow/world-postgres": "^5.0.5",
      },
      devDependencies: {},
    });
    expect(
      dependenciesFor(
        {
          "x.ts": {
            content: 'import { a } from "@ai-sdk/openai-compatible";\n',
          },
        },
        { target: "vercel" },
        "50.1.0",
      ),
    ).toEqual({
      dependencies: { ai: "^7.0.152", "@ai-sdk/openai-compatible": "^3" },
      devDependencies: { vercel: "50.1.0" },
    });
  });
});

describe("prepareInstall", () => {
  it("pins eve exactly and creates the agent's own workspace file when there is none", async () => {
    const edits = await prepareInstall(dir, "0.83.2", {
      dependencies: { ai: "^7.0.152" },
      devDependencies: {},
    });
    expect(edits).toEqual(["package.json", "pnpm-workspace.yaml"]);
    expect(JSON.parse(read("package.json"))).toEqual({
      name: "a",
      dependencies: { eve: "0.83.2", ai: "^7.0.152" },
    });
    expect(read("pnpm-workspace.yaml")).toBe(
      "packages:\n  - .\nallowBuilds:\n  cbor-extract: false\nminimumReleaseAgeExclude:\n  - eve@0.83.2\n",
    );
  });

  it("edits a template's workspace file in place, keeping its comments and choices", async () => {
    writeFileSync(
      join(dir, "pnpm-workspace.yaml"),
      "# mine\nallowBuilds:\n  cbor-extract: true # on purpose\nminimumReleaseAgeExclude:\n  - eve\n",
    );
    await prepareInstall(dir, "0.83.2", {
      dependencies: {},
      devDependencies: { vercel: "50.1.0" },
    });
    expect(read("pnpm-workspace.yaml")).toBe(
      "# mine\nallowBuilds:\n  cbor-extract: true # on purpose\nminimumReleaseAgeExclude:\n  - eve\n",
    );
    expect(JSON.parse(read("package.json")).devDependencies).toEqual({
      vercel: "50.1.0",
    });
  });
});

describe("install", () => {
  const io = (spawn: ReturnType<typeof fakeEve>) => ({
    ...quietIo({ cwd: dir, home: dir }),
    spawn,
  });

  it("runs the package manager's install in place", async () => {
    const spawn = fakeEve();
    await install(io(spawn), dir);
    expect(spawn.calls.map((c) => [c.command, c.args, c.cwd])).toEqual([
      ["pnpm", ["install"], dir],
    ]);
  });

  it("treats ERR_PNPM_IGNORED_BUILDS as success once node_modules is there", async () => {
    const spawn = fakeEve({
      replies: [],
      fallback: {
        lines: ["[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: x"],
        exitCode: 1,
        effect: () => mkdirSync(join(dir, "node_modules")),
      },
    });
    await expect(install(io(spawn), dir)).resolves.toBeUndefined();
  });

  it("fails with the command and the last lines otherwise", async () => {
    const spawn = fakeEve({
      replies: [],
      fallback: { lines: ["boom"], exitCode: 1 },
    });
    await expect(install(io(spawn), dir)).rejects.toMatchObject({
      code: "install-failed",
      details: { command: "pnpm install", exitCode: 1, tail: ["boom"] },
    });
  });
});

describe("ignoreGenerated", () => {
  it("appends only the missing entries to the template's .gitignore", async () => {
    writeFileSync(join(dir, ".gitignore"), "/node_modules/\n.output\n.env*");
    expect(await ignoreGenerated(dir)).toBe(true);
    expect(read(".gitignore")).toBe(
      "/node_modules/\n.output\n.env*\n.vercel/\n.eve/\n",
    );
    expect(await ignoreGenerated(dir)).toBe(false);
  });

  it("creates one when the template has none", async () => {
    expect(await ignoreGenerated(dir)).toBe(true);
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    expect(read(".gitignore")).toBe(
      ".env*\n.output/\n.vercel/\nnode_modules/\n.eve/\n",
    );
  });
});
