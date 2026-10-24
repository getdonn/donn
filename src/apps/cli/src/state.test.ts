import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "./errors.js";
import { projectKey, readState, updateState, writeState } from "./state.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "donn-state-"));
  dirs.push(dir);
  return dir;
};

describe("state.json", () => {
  it("is empty when missing and round-trips", async () => {
    const home = temp();
    expect(await readState(home)).toEqual({ version: 1, projects: {} });
    const state = {
      version: 1 as const,
      default: "team/payments",
      projects: { "/r/.donn": "org/base" },
    };
    await writeState(home, state);
    expect(await readState(home)).toEqual(state);
    expect(readdirSync(home)).toEqual(["state.json"]);
  });

  it("reports an unparseable file by name", async () => {
    const home = temp();
    writeFileSync(join(home, "state.json"), "{ bad json");
    const error = await readState(home).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({
      code: "invalid-state",
      details: { file: join(home, "state.json") },
    });
  });

  it("keys a symlinked project by its real path", async () => {
    const root = temp();
    mkdirSync(join(root, "real/.donn"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "link"));
    expect(await projectKey(join(root, "link/.donn"))).toBe(
      await projectKey(join(root, "real/.donn")),
    );
  });
});

describe("updateState", () => {
  it("keeps both of two concurrent updates", async () => {
    const home = mkdtempSync(join(tmpdir(), "donn-state-"));
    try {
      await Promise.all([
        updateState(home, (state) => {
          state.projects["/a"] = "team/a";
        }),
        updateState(home, (state) => {
          state.projects["/b"] = "team/b";
        }),
      ]);
      expect((await readState(home)).projects).toEqual({
        "/a": "team/a",
        "/b": "team/b",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
