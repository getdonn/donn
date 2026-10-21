import {
  AdapterInputError,
  type CompileInput,
  type CompileOutput,
} from "@zzpersona/adapter-sdk";
import { corpus } from "@zzpersona/adapter-sdk/conformance";
import { describe, expect, it } from "vitest";
import { pluginName } from "./compile.js";
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
          "## zzpersona persona: project/checkout-api",
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

  it("heads the instructions with the persona", () => {
    const file = full.files["system-prompt.md"];
    expect(file && "content" in file && file.content.split("\n")[0]).toBe(
      "## zzpersona persona: project/checkout-api",
    );
  });

  it("writes the heading when a persona has no instructions", () => {
    const { ir } = entry("minimal");
    const bare = adapter.compile(
      input("minimal", { ir: { ...ir, instructions: [], knowledge: [] } }),
    );
    expect(bare.files["system-prompt.md"]).toEqual({
      content: `## zzpersona persona: ${entry("minimal").personaId}\n`,
    });
  });

  it("names the plugin after the persona id", () => {
    expect(json(full, "plugin/.claude-plugin/plugin.json")).toEqual({
      name: "zzp-project--checkout-api",
      version: "0.0.0",
      description: "Persona checkout-api",
    });
    const nested = adapter.compile(
      input("minimal", { personaId: "team/platform/payments" }),
    );
    expect(json(nested, "plugin/.claude-plugin/plugin.json")).toMatchObject({
      name: "zzp-team--platform--payments",
    });
  });

  it("keeps nested and hyphenated refs apart in plugin names", () => {
    expect(pluginName("team/platform-payments")).toBe(
      "zzp-team--platform-payments",
    );
    expect(pluginName("team/platform/payments")).toBe(
      "zzp-team--platform--payments",
    );
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
              "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/pre-tool-use-pre-tool-use-hook-pre-tool-use.sh",
          },
        ],
      },
    ]);
    expect(hooks.Stop![0]).not.toHaveProperty("matcher");
    expect(
      kitchen.files[
        "plugin/hooks/scripts/pre-tool-use-pre-tool-use-hook-pre-tool-use.sh"
      ],
    ).toEqual({ copyFrom: "org/hooks/pre-tool-use.sh", mode: 0o755 });
  });

  it("writes MCP servers with secret placeholders, reusing one per distinct ref", () => {
    expect(kitchen.secretEnv).toEqual({
      ZZP_SECRET_1: "secret://vault/db/token",
      ZZP_SECRET_2: "secret://vault/db/url",
      ZZP_SECRET_3: "secret://vault/remote/key",
    });
    expect(json(kitchen, "mcp.json")).toEqual({
      mcpServers: {
        db: {
          command: "npx",
          args: ["-y", "@corp/db-mcp", "--token", "${ZZP_SECRET_1}"],
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
          headers: {
            Authorization: "${ZZP_SECRET_3}",
            "X-Team": "kitchen",
          },
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

describe("review fixes", () => {
  const minimal = entry("minimal");
  const compileIr = (ir: CompileInput["ir"]) =>
    adapter.compile(input("minimal", { ir }));

  it("never lets targets replace the persona's permission rules (C1)", () => {
    const output = compileIr({
      ...minimal.ir,
      permissions: { allow: [], deny: ["Bash(rm:*)"], ask: [] },
      locks: [{ path: "permissions.deny", layer: "org/base" }],
      targets: {
        "claude-code": {
          permissions: { defaultMode: "acceptEdits", allow: ["Bash(*)"] },
        },
      },
    });
    expect(json(output, "settings.json")).toEqual({
      permissions: {
        defaultMode: "acceptEdits",
        allow: [],
        deny: ["Bash(rm:*)"],
        ask: [],
      },
    });
    expect(output.report.entries).toContainEqual({
      path: "targets.claude-code.permissions.allow",
      outcome: "dropped",
      reason:
        "permission rules come from the persona's permissions, not targets",
    });
  });

  it("names hook scripts by event so equal ids in two events do not collide (I3)", () => {
    const output = compileIr({
      ...minimal.ir,
      hooks: {
        "pre-tool-use": [{ id: "lint", run: "org/a/check.sh" }],
        "post-tool-use": [{ id: "lint", run: "team/b/check.sh" }],
      },
    });
    expect(
      output.files["plugin/hooks/scripts/pre-tool-use-lint-check.sh"],
    ).toEqual({ copyFrom: "org/a/check.sh", mode: 0o755 });
    expect(
      output.files["plugin/hooks/scripts/post-tool-use-lint-check.sh"],
    ).toEqual({ copyFrom: "team/b/check.sh", mode: 0o755 });
  });

  it("replaces secret refs in args and url too, and drops them from targets (I4)", () => {
    const output = compileIr({
      ...minimal.ir,
      mcp: {
        servers: {
          db: { command: "npx", args: ["--token", "secret://v/t"] },
          remote: { url: "secret://v/u" },
        },
      },
      targets: {
        "claude-code": { env: { API_KEY: "secret://v/k", LEVEL: "1" } },
      },
    });
    expect(json(output, "mcp.json")).toEqual({
      mcpServers: {
        db: { command: "npx", args: ["--token", "${ZZP_SECRET_1}"] },
        remote: { type: "http", url: "${ZZP_SECRET_2}" },
      },
    });
    expect(output.secretEnv).toEqual({
      ZZP_SECRET_1: "secret://v/t",
      ZZP_SECRET_2: "secret://v/u",
    });
    expect(json(output, "settings.json")).toMatchObject({
      env: { LEVEL: "1" },
    });
    expect(JSON.stringify(json(output, "settings.json"))).not.toContain(
      "secret://",
    );
    expect(output.report.entries).toContainEqual({
      path: "targets.claude-code.env.API_KEY",
      outcome: "dropped",
      reason:
        "secret refs in targets are not resolved; pass secrets through an MCP server's env",
    });
  });

  it("rejects skill and hook sources outside the personas root (I5)", () => {
    expect(() =>
      compileIr({
        ...minimal.ir,
        skills: [{ name: "ssh", source: "../.ssh" }],
      }),
    ).toThrow(AdapterInputError);
    expect(() =>
      compileIr({
        ...minimal.ir,
        hooks: { stop: [{ id: "x", run: "/etc/x.sh" }] },
      }),
    ).toThrow(AdapterInputError);
  });

  it("describes each mode's losses in its matrix (I6)", () => {
    const partial = adapter.capabilities({
      installed: true,
      facts: { sideloadBlocked: true },
    }).fields;
    expect(partial.skills?.support ?? "none").toBe("none");
    expect(partial["mcp.servers"]?.support ?? "none").toBe("none");
    expect(partial["hooks.stop"]?.support ?? "none").toBe("none");
    expect(partial.instructions?.support).toBe("native");
    const noMcp = adapter.capabilities({
      installed: true,
      facts: { managedMcp: true },
    }).fields;
    expect(noMcp["mcp.servers"]?.support ?? "none").toBe("none");
    expect(noMcp.skills?.support).toBe("native");
  });
});

describe("spec 08 hardening", () => {
  const minimal = entry("minimal");
  const compileIr = (ir: CompileInput["ir"]) =>
    adapter.compile(input("minimal", { ir }));

  it("rejects a non-boolean strictMcp", () => {
    expect(() =>
      compileIr({
        ...minimal.ir,
        targets: { "claude-code": { strictMcp: "false" } },
      }),
    ).toThrow("targets.claude-code.strictMcp must be true or false");
  });

  it("drops an object left empty by removing its secrets", () => {
    const settings = json(
      compileIr({
        ...minimal.ir,
        targets: {
          "claude-code": {
            model: "opus",
            env: { TOKEN: "secret://env/T" },
            keep: {},
          },
        },
      }),
      "settings.json",
    ) as Record<string, unknown>;
    expect(settings).not.toHaveProperty("env");
    expect(settings.keep).toEqual({});
    expect(settings.model).toBe("opus");
  });
});
