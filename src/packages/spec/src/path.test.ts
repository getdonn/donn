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
    "models",
    "models.gateway",
    "models.default",
    "agents.define",
    "agents.define.pr-reviewer",
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
    "models.gateway.baseURL",
    "models.other",
    "models[x]",
    "agents",
    "agents.remove",
    "agents.define.x.env",
    "agents.define[x]",
    "agents.define.Bad_Name",
  ])("rejects %s", (path) => {
    expect(isValidLockPath(path)).toBe(false);
  });
});
