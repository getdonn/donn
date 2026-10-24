import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOnPath } from "./path.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "donn-path-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function file(dir: string, name: string, mode: number) {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, name), "#!/bin/sh\n");
  chmodSync(join(root, dir, name), mode);
  return join(root, dir, name);
}

describe("findOnPath", () => {
  it("finds the first executable on PATH, as a spawn without a shell would", () => {
    file("a", "donn", 0o644);
    const found = file("b", "donn", 0o755);
    file("c", "donn", 0o755);
    const PATH = ["a", "b", "c"].map((d) => join(root, d)).join(":");
    expect(findOnPath("donn", { PATH })).toBe(found);
  });

  it("is undefined when the command is missing or PATH is unset", () => {
    expect(findOnPath("donn", { PATH: join(root, "none") })).toBeUndefined();
    expect(findOnPath("donn", {})).toBeUndefined();
  });
});
