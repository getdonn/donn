import { describe, expect, it } from "vitest";
import { formatPath, isValidLockPath, parsePath } from "./path.js";

describe("parsePath", () => {
  it("splits dotted keys", () => {
    expect(parsePath("targets.claude-code.model")).toEqual({
      keys: ["targets", "claude-code", "model"],
    });
  });

  it("keeps dots and parentheses inside a final entry", () => {
    expect(parsePath("permissions.deny[Read(./.env)]")).toEqual({
      keys: ["permissions", "deny"],
      entry: "Read(./.env)",
    });
  });

  it("rejects malformed paths", () => {
    for (const path of [
      "",
      "mcp..gateway",
      ".mcp",
      "skills[",
      "skills[]",
      "skills[x]y",
    ]) {
      expect(parsePath(path), path).toBeUndefined();
    }
  });

  it("round-trips through formatPath", () => {
    for (const path of [
      "mcp.gateway",
      "hooks.pre-tool-use[block-prod-db]",
      "skills[pr-review]",
    ]) {
      expect(formatPath(parsePath(path)!)).toBe(path);
    }
  });
});

describe("isValidLockPath", () => {
  it.each([
    "instructions",
    "instructions[payments-overview]",
    "skills[pr-review]",
    "knowledge[runbooks]",
    "metadata.labels",
    "metadata.labels.team",
    "mcp",
    "mcp.gateway",
    "mcp.servers",
    "mcp.servers.jira",
    "permissions",
    "permissions.deny",
    "permissions.deny[Bash(rm -rf:*)]",
    "hooks",
    "hooks.pre-tool-use",
    "hooks.pre-tool-use[block-prod-db]",
    "secrets.providers.vault",
    "targets.claude-code.model",
  ])("accepts %s", (path) => {
    expect(isValidLockPath(path)).toBe(true);
  });

  it.each([
    "permissions.denny",
    "permissions[Bash(x)]",
    "hooks.pre-tool-uze",
    "hooks[block-prod-db]",
    "mcp.gateway[x]",
    "mcp.servers.jira.command",
    "metadata.name",
    "locks",
    "extends",
    "instructions.foo",
  ])("rejects %s", (path) => {
    expect(isValidLockPath(path)).toBe(false);
  });
});
