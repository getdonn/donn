import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentCompileOutput } from "@getdonn/adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readManifest,
  writeAgentFiles,
  writeManifest,
  type Manifest,
} from "./files.js";

const sha = (text: string) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

let root: string;
let dir: string;
let sources: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "donn-files-"));
  dir = join(root, "agent");
  sources = join(root, "personas");
  const put = (path: string, text: string, mode = 0o644) => {
    mkdirSync(dirname(join(sources, path)), { recursive: true });
    writeFileSync(join(sources, path), text, { mode });
  };
  put("team/skills/sim/SKILL.md", "---\ndescription: d\n---\n");
  put("team/skills/sim/scripts/run.sh", "#!/bin/sh\n", 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const store = {
  locate: (virtual: string) => ({
    path: join(sources, virtual),
    root: sources,
  }),
};

const output = (files: AgentCompileOutput["files"]): AgentCompileOutput => ({
  files,
  secretEnv: {},
  env: {},
  report: { adapter: "eve", irVersion: 0, entries: [] },
  portability: [],
});

const base = (files: Record<string, string>): Manifest => ({
  agent: "a",
  persona: "project/persona",
  adapter: "eve",
  frameworkVersion: "0.83.2",
  template: "eve:blank",
  target: "local",
  path: "agents/a",
  files,
  agentTs: "patched",
  edits: [],
  state: "complete",
});

describe("writeAgentFiles", () => {
  it("writes content, copies skill directories and hashes each copied file", async () => {
    const files = await writeAgentFiles(
      dir,
      output({
        "agent/lib/donn/config.ts": { content: "export const donn = {};\n" },
        "agent/skills/donn-sim": { copyFrom: "team/skills/sim" },
      }),
      undefined,
      { force: false, store },
    );
    expect(files).toEqual({
      "agent/lib/donn/config.ts": sha("export const donn = {};\n"),
      "agent/skills/donn-sim/SKILL.md": sha("---\ndescription: d\n---\n"),
      "agent/skills/donn-sim/scripts/run.sh": sha("#!/bin/sh\n"),
    });
    expect(
      statSync(join(dir, "agent/skills/donn-sim/scripts/run.sh")).mode & 0o777,
    ).toBe(0o755);
  });

  it("stops on an edited owned file unless forced, and removes what the compile dropped", async () => {
    const first = await writeAgentFiles(
      dir,
      output({
        "agent/instructions/donn.md": { content: "one\n" },
        "agent/skills/donn-sim": { copyFrom: "team/skills/sim" },
      }),
      undefined,
      { force: false, store },
    );
    writeFileSync(join(dir, "agent/instructions/donn.md"), "edited\n");
    const next = output({ "agent/instructions/donn.md": { content: "two\n" } });
    await expect(
      writeAgentFiles(dir, next, base(first), { force: false, store }),
    ).rejects.toMatchObject({
      code: "owned-file-edited",
      details: { files: ["agent/instructions/donn.md"] },
    });
    expect(readFileSync(join(dir, "agent/instructions/donn.md"), "utf8")).toBe(
      "edited\n",
    );
    expect(existsSync(join(dir, "agent/skills/donn-sim/SKILL.md"))).toBe(true);

    const files = await writeAgentFiles(dir, next, base(first), {
      force: true,
      store,
    });
    expect(files).toEqual({ "agent/instructions/donn.md": sha("two\n") });
    expect(existsSync(join(dir, "agent/skills/donn-sim"))).toBe(false);
    expect(existsSync(join(dir, "agent/skills"))).toBe(false);
    expect(existsSync(join(dir, "agent/instructions/donn.md"))).toBe(true);
  });

  it("refuses a path outside the agent directory", async () => {
    await expect(
      writeAgentFiles(
        dir,
        output({ "../escape.ts": { content: "x" } }),
        undefined,
        { force: false, store },
      ),
    ).rejects.toMatchObject({ code: "unsafe-path" });
  });
});

describe("the manifest", () => {
  it("round-trips at .donn/agent.json, and is undefined when absent", async () => {
    expect(await readManifest(dir)).toBeUndefined();
    const m = base({ "agent/x.ts": sha("x") });
    await writeManifest(dir, m);
    expect(await readManifest(dir)).toEqual(m);
    expect(
      JSON.parse(readFileSync(join(dir, ".donn/agent.json"), "utf8")),
    ).toEqual(m);
  });

  it("refuses a manifest that is not one", async () => {
    mkdirSync(join(dir, ".donn"), { recursive: true });
    writeFileSync(join(dir, ".donn/agent.json"), '{"agent": 1}');
    await expect(readManifest(dir)).rejects.toMatchObject({
      code: "invalid-manifest",
    });
  });
});

describe("writeAgentFiles read errors", () => {
  it("fails with a filesystem error when an owned file cannot be read, and deletes nothing", async () => {
    const file = join(dir, "agent/x.md");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "mine", { mode: 0o000 });
    try {
      await expect(
        writeAgentFiles(dir, output({}), base({ "agent/x.md": sha("old") }), {
          force: false,
          store,
        }),
      ).rejects.toMatchObject({ code: "filesystem" });
      expect(existsSync(file)).toBe(true);
    } finally {
      chmodSync(file, 0o644);
    }
  });
});
