import { describe, expect, it } from "vitest";
import { isContainedPath } from "./index.js";

describe("isContainedPath (I5)", () => {
  it.each(["a", "a/b", "team/skills/x", "a/./b"])("accepts %s", (path) => {
    expect(isContainedPath(path)).toBe(true);
  });

  it.each([
    "",
    "..",
    "../x",
    "a/../../b",
    "/etc/passwd",
    "C:\\Users\\x",
    "c:/x",
    "\\x",
    "\\\\server\\share\\x",
    "a\\..\\..\\b",
  ])("rejects %s", (path) => {
    expect(isContainedPath(path)).toBe(false);
  });
});
