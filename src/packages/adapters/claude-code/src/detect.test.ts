import type { Probe } from "@zzpersona/adapter-sdk";
import { HOOK_EVENTS } from "@zzpersona/spec";
import { describe, expect, it } from "vitest";
import adapter from "./index.js";

const DARWIN = "/Library/Application Support/ClaudeCode";

/** A probe over an in-memory file system. `dirs` maps a directory to its entry names. */
function fakeProbe(
  options: {
    platform?: NodeJS.Platform;
    version?: string | null;
    files?: Record<string, string>;
    dirs?: Record<string, string[]>;
  } = {},
): Probe {
  const { version = "2.1.306 (Claude Code)", files = {}, dirs = {} } = options;
  return {
    platform: options.platform ?? "darwin",
    run: async (command, args) => {
      expect([command, ...args]).toEqual(["claude", "--version"]);
      return version === null
        ? { exitCode: 127, stdout: "", stderr: "command not found: claude" }
        : { exitCode: 0, stdout: `${version}\n`, stderr: "" };
    },
    readFile: async (path) => files[path],
    listDir: async (path) => dirs[path],
  };
}

describe("capabilities", () => {
  it("declares every field native except knowledge, which is advisory", () => {
    const { fields } = adapter.capabilities();
    expect(fields.knowledge).toEqual({
      support: "advisory",
      note: expect.any(String),
    });
    const native = [
      "instructions",
      "skills",
      "mcp.servers",
      "secrets",
      "permissions.allow",
      "permissions.deny",
      "permissions.ask",
      "targets.claude-code",
      ...HOOK_EVENTS.map((event) => `hooks.${event}`),
    ];
    for (const field of native) {
      expect(fields[field as keyof typeof fields]?.support, field).toBe(
        "native",
      );
    }
  });
});

describe("detect", () => {
  it("reports the installed version", async () => {
    expect(await adapter.detect(fakeProbe())).toEqual({
      installed: true,
      version: "2.1.306",
      facts: { sideloadBlocked: false, managedMcp: false },
    });
  });

  it("reports not installed without throwing", async () => {
    expect(await adapter.detect(fakeProbe({ version: null }))).toEqual({
      installed: false,
      facts: { sideloadBlocked: false, managedMcp: false },
    });
  });

  it("finds disableSideloadFlags in managed-settings.json", async () => {
    const probe = fakeProbe({
      files: {
        [`${DARWIN}/managed-settings.json`]: '{"disableSideloadFlags": true}',
      },
    });
    expect((await adapter.detect(probe)).facts.sideloadBlocked).toBe(true);
  });

  it("finds disableSideloadFlags in a managed-settings.d drop-in", async () => {
    const probe = fakeProbe({
      dirs: {
        [`${DARWIN}/managed-settings.d`]: [
          "10-base.json",
          "50-team.json",
          "README",
        ],
      },
      files: {
        [`${DARWIN}/managed-settings.d/10-base.json`]: '{"model": "opus"}',
        [`${DARWIN}/managed-settings.d/50-team.json`]:
          '{"disableSideloadFlags": true}',
      },
    });
    expect((await adapter.detect(probe)).facts.sideloadBlocked).toBe(true);
  });

  it("detects a deployed managed-mcp.json", async () => {
    const probe = fakeProbe({
      files: { [`${DARWIN}/managed-mcp.json`]: "{}" },
    });
    expect((await adapter.detect(probe)).facts.managedMcp).toBe(true);
  });

  it("reads the Linux and Windows managed directories", async () => {
    const linux = fakeProbe({
      platform: "linux",
      files: { "/etc/claude-code/managed-mcp.json": "{}" },
    });
    expect((await adapter.detect(linux)).facts.managedMcp).toBe(true);
    const windows = fakeProbe({
      platform: "win32",
      files: {
        "C:\\Program Files\\ClaudeCode\\managed-settings.json":
          '{"disableSideloadFlags": true}',
      },
    });
    expect((await adapter.detect(windows)).facts.sideloadBlocked).toBe(true);
  });

  it("ignores a malformed managed settings file", async () => {
    const probe = fakeProbe({
      files: { [`${DARWIN}/managed-settings.json`]: "{ not json" },
    });
    expect((await adapter.detect(probe)).facts.sideloadBlocked).toBe(false);
  });
});
