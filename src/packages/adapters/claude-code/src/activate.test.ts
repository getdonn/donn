import type { Detection } from "@zzpersona/adapter-sdk";
import { corpus } from "@zzpersona/adapter-sdk/conformance";
import type { ResolvedPersona } from "@zzpersona/spec";
import { describe, expect, it } from "vitest";
import adapter from "./index.js";

const entry = (name: string) => corpus.find((e) => e.name === name)!;

const facts = {
  relaunch: {},
  partial: { sideloadBlocked: true, managedMcp: true },
  "relaunch-no-mcp": { managedMcp: true },
} as const;

function build(
  name: string,
  mode: keyof typeof facts,
  options: { ir?: ResolvedPersona; passthrough?: string[] } = {},
) {
  const { personaId, texts } = entry(name);
  const ir = options.ir ?? entry(name).ir;
  const detection: Detection = {
    installed: true,
    version: "2.1.306",
    facts: facts[mode],
  };
  const output = adapter.compile({ personaId, ir, texts, detection });
  const plan = adapter.activate({
    ir,
    output,
    buildDir: "/BUILD",
    detection,
    cwd: "/PROJECT",
    passthrough: options.passthrough ?? [],
  });
  return { output, plan, launch: plan.steps[0] };
}

const PLUGIN = ["--plugin-dir", "/BUILD/plugin"];
const SETTINGS = ["--settings", "/BUILD/settings.json"];
const MCP = ["--mcp-config", "/BUILD/mcp.json"];
const PROMPT = ["--append-system-prompt-file", "/BUILD/system-prompt.md"];

describe("activate", () => {
  it("launches claude with the full relaunch flags", () => {
    const { plan } = build("full", "relaunch");
    expect(plan).toEqual({
      steps: [
        {
          kind: "launch",
          command: "claude",
          args: [
            ...PLUGIN,
            ...MCP,
            "--strict-mcp-config",
            ...SETTINGS,
            ...PROMPT,
          ],
          env: {},
          cwd: "/PROJECT",
        },
      ],
    });
  });

  it("keeps only --settings and the prompt when sideload flags are blocked", () => {
    const { launch, output } = build("full", "partial");
    expect(launch).toMatchObject({ args: [...SETTINGS, ...PROMPT] });
    expect(output.report.mode).toBe("partial");
    expect(Object.keys(output.files).sort()).toEqual([
      "settings.json",
      "system-prompt.md",
    ]);
    expect(output.secretEnv).toEqual({});
  });

  it("omits the MCP flags when managed-mcp.json is deployed", () => {
    const { launch, output } = build("full", "relaunch-no-mcp");
    expect(launch).toMatchObject({ args: [...PLUGIN, ...SETTINGS, ...PROMPT] });
    expect(output.report.mode).toBe("relaunch-no-mcp");
    expect(output.files).not.toHaveProperty("mcp.json");
  });

  it("drops only --strict-mcp-config when strictMcp is false", () => {
    const { launch } = build("kitchen-sink", "relaunch");
    expect(launch).toMatchObject({
      args: [...PLUGIN, ...MCP, ...SETTINGS, ...PROMPT],
    });
  });

  it("passes the headed prompt file even with no instructions or knowledge", () => {
    const empty = { ...entry("minimal").ir, instructions: [] };
    const { launch, output } = build("minimal", "relaunch", { ir: empty });
    expect(output.files).toHaveProperty("system-prompt.md");
    expect(launch).toMatchObject({
      args: [
        ...PLUGIN,
        ...MCP,
        "--strict-mcp-config",
        ...SETTINGS,
        "--append-system-prompt-file",
        "/BUILD/system-prompt.md",
      ],
    });
  });

  it("appends passthrough args verbatim after its own", () => {
    const { launch } = build("full", "relaunch", {
      passthrough: ["--mcp-config", "extra.json"],
    });
    expect(launch).toMatchObject({
      args: [
        ...PLUGIN,
        ...MCP,
        "--strict-mcp-config",
        ...SETTINGS,
        ...PROMPT,
        "--mcp-config",
        "extra.json",
      ],
    });
  });
});

describe("degraded modes in the compile report", () => {
  it("partial mode drops skills, hooks and MCP servers with the reason", () => {
    const { output } = build("kitchen-sink", "partial");
    const reason = "disableSideloadFlags blocks --plugin-dir and --mcp-config";
    for (const path of [
      "skills[local-skill]",
      "skills[remote-skill]",
      "hooks.stop[stop-hook]",
      "mcp.servers.db",
      "mcp.servers.jira",
    ]) {
      expect(output.report.entries).toContainEqual(
        expect.objectContaining({ path, outcome: "dropped", reason }),
      );
    }
    expect(
      output.report.entries.filter((e) => e.path === "skills[remote-skill]"),
    ).toHaveLength(1);
  });

  it("relaunch-no-mcp drops MCP servers with the reason", () => {
    const { output } = build("kitchen-sink", "relaunch-no-mcp");
    expect(output.report.entries).toContainEqual(
      expect.objectContaining({
        path: "mcp.servers.db",
        outcome: "dropped",
        reason: "managed-mcp.json makes --mcp-config exit",
      }),
    );
    expect(output.secretEnv).toEqual({});
  });
});

describe("review fixes", () => {
  it("never leaves the variadic --mcp-config last before passthrough (I2)", () => {
    const empty = {
      ...entry("kitchen-sink").ir,
      instructions: [],
      knowledge: [],
    };
    const { launch } = build("kitchen-sink", "relaunch", {
      ir: empty,
      passthrough: ["explain this repo"],
    });
    if (launch?.kind !== "launch") throw new Error("expected launch");
    const prompt = launch.args.indexOf("explain this repo");
    expect(launch.args[prompt - 2]).not.toBe("--mcp-config");
    expect(launch.args.slice(-3)).toEqual([
      "--append-system-prompt-file",
      "/BUILD/system-prompt.md",
      "explain this repo",
    ]);
  });
});
