import {
  AdapterInputError,
  type CompileInput,
  type CompileOutput,
} from "@zzpersona/adapter-sdk";
import { corpus } from "@zzpersona/adapter-sdk/conformance";
import { describe, expect, it } from "vitest";
import adapter from "./index.js";

const entry = (name: string) => corpus.find((e) => e.name === name)!;

const input = (
  name: string,
  overrides: Partial<CompileInput> = {},
): CompileInput => {
  const { personaId, ir, texts } = entry(name);
  return {
    personaId,
    ir,
    texts,
    detection: { installed: true, version: "2.1.306", facts: {} },
    ...overrides,
  };
};

const json = (output: CompileOutput, path: string): unknown => {
  const file = output.files[path];
  if (!file || !("content" in file)) throw new Error(`no file ${path}`);
  return JSON.parse(file.content);
};

describe("compile (relaunch)", () => {
  const full = adapter.compile(input("full"));
  const kitchen = adapter.compile(input("kitchen-sink"));

  it("reports relaunch mode", () => {
    expect(full.report.mode).toBe("relaunch");
  });

  it("writes instructions in order, then knowledge pointers, to system-prompt.md", () => {
    expect(full.files["system-prompt.md"]).toEqual({
      content:
        [
          "Review code the way you would want yours reviewed.",
          "Never paste credentials, tokens or customer data into prompts.",
          "This area is PCI-DSS scoped. Treat card data as restricted.",
          "The checkout API settles card payments. Settlement code lives in src/settlement.",
          "Use the shared error envelope. Never log PANs.",
          "This repo is the checkout API. Run `pnpm sim` before touching settlement code.",
          "## Knowledge sources\n" +
            "- pci-handbook: mcp://confluence?space=PCI\n" +
            "- payments-runbooks: mcp://confluence?space=PAY\n" +
            "- schema-docs: https://docs.corp/payments/schema",
        ].join("\n\n") + "\n",
    });
  });

  it("names the plugin after the persona id", () => {
    expect(json(full, "plugin/.claude-plugin/plugin.json")).toEqual({
      name: "zzp-project-checkout-api",
      version: "0.0.0",
      description: "Persona checkout-api",
    });
    const nested = adapter.compile(
      input("minimal", { personaId: "team/platform/payments" }),
    );
    expect(json(nested, "plugin/.claude-plugin/plugin.json")).toMatchObject({
      name: "zzp-team-platform-payments",
    });
  });

  it("copies local skills and drops registry skills", () => {
    expect(kitchen.files["plugin/skills/local-skill"]).toEqual({
      copyFrom: "team/skills/local-skill",
    });
    expect(kitchen.files).not.toHaveProperty("plugin/skills/remote-skill");
    expect(kitchen.report.entries).toContainEqual({
      path: "skills[remote-skill]",
      outcome: "dropped",
      reason: "skill registries are not supported in v0",
    });
  });

  it("maps all nine hook events and copies their scripts", () => {
    const hooks = (
      json(kitchen, "plugin/hooks/hooks.json") as {
        hooks: Record<
          string,
          { matcher?: string; hooks: { command: string }[] }[]
        >;
      }
    ).hooks;
    expect(Object.keys(hooks).sort()).toEqual(
      [
        "Notification",
        "PostToolUse",
        "PreCompact",
        "PreToolUse",
        "SessionEnd",
        "SessionStart",
        "Stop",
        "SubagentStop",
        "UserPromptSubmit",
      ].sort(),
    );
    expect(hooks.PreToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command:
              "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/pre-tool-use-hook-pre-tool-use.sh",
          },
        ],
      },
    ]);
    expect(hooks.Stop![0]).not.toHaveProperty("matcher");
    expect(
      kitchen.files["plugin/hooks/scripts/pre-tool-use-hook-pre-tool-use.sh"],
    ).toEqual({ copyFrom: "org/hooks/pre-tool-use.sh", mode: 0o755 });
  });

  it("writes MCP servers with secret placeholders, reusing one per distinct ref", () => {
    expect(kitchen.secretEnv).toEqual({
      ZZP_SECRET_1: "secret://vault/db/token",
      ZZP_SECRET_2: "secret://vault/db/url",
    });
    expect(json(kitchen, "mcp.json")).toEqual({
      mcpServers: {
        db: {
          command: "npx",
          args: ["-y", "@corp/db-mcp"],
          env: {
            LOG_LEVEL: "debug",
            TOKEN: "${ZZP_SECRET_1}",
            TOKEN_AGAIN: "${ZZP_SECRET_1}",
            URL: "${ZZP_SECRET_2}",
          },
        },
        remote: {
          type: "sse",
          url: "https://mcp.corp/sse",
          headers: { "X-Team": "kitchen" },
        },
      },
    });
  });

  it("drops gateway refs, noting the lock that covers them", () => {
    expect(kitchen.report.entries).toContainEqual({
      path: "mcp.servers.jira",
      outcome: "dropped",
      reason:
        "gateway:// refs need gateway resolution, which is not available yet",
      lock: { path: "mcp.servers", layer: "org/base" },
    });
  });

  it("writes permissions and claude-code targets to settings.json, minus adapter keys", () => {
    expect(json(kitchen, "settings.json")).toEqual({
      permissions: {
        allow: ["Read(./**)"],
        deny: ["Bash(rm -rf:*)"],
        ask: ["Bash(git push:*)"],
      },
      model: "opus",
    });
  });

  it("reports knowledge as advisory", () => {
    expect(full.report.entries).toContainEqual({
      path: "knowledge[pci-handbook]",
      outcome: "advisory",
      reason: "rendered as text in the system prompt",
    });
  });

  it("throws AdapterInputError when an instruction file's text is missing", () => {
    expect(() => adapter.compile(input("full", { texts: {} }))).toThrow(
      AdapterInputError,
    );
  });
});
