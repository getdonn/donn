import { describe, expect, it } from "vitest";
import {
  defineAdapter,
  renderBuild,
  renderCapabilities,
  type ActivationPlan,
  type CapabilityMatrix,
  type CompileOutput,
} from "./index.js";

const output: CompileOutput = {
  files: {
    "settings.json": { content: '{\n  "a": 1\n}' },
    "plugin/hooks/run.sh": { copyFrom: "org/hooks/run.sh", mode: 0o755 },
  },
  secretEnv: { DONN_SECRET_1: "secret://vault/db" },
  report: {
    adapter: "toy",
    irVersion: 0,
    mode: "relaunch",
    entries: [
      {
        path: "permissions.deny[Bash(curl:*)]",
        outcome: "advisory",
        reason: "rendered as text",
        lock: { path: "permissions.deny", layer: "org/base" },
      },
    ],
  },
};

const plan: ActivationPlan = {
  steps: [
    {
      kind: "launch",
      command: "toy",
      args: ["--settings", "/BUILD/settings.json"],
      env: { DONN_SECRET_1: "", A: "" },
    },
    { kind: "overlay", path: "AGENTS.md", content: "hello" },
  ],
};

describe("renderBuild", () => {
  it("renders files sorted, then secrets, report and plan", () => {
    expect(renderBuild(output, plan)).toBe(
      [
        "mode: relaunch",
        "files (2)",
        "  plugin/hooks/run.sh <- copy org/hooks/run.sh",
        "  settings.json (0644)",
        "    {",
        '      "a": 1',
        "    }",
        "secretEnv (1)",
        "  DONN_SECRET_1 = secret://vault/db",
        "report (1)",
        "  advisory  permissions.deny[Bash(curl:*)]  rendered as text  locked: permissions.deny by org/base",
        "plan (2)",
        "  launch toy --settings /BUILD/settings.json",
        "    env: A, DONN_SECRET_1",
        "  overlay AGENTS.md (5 chars)",
        "",
      ].join("\n"),
    );
  });

  it("is stable and omits empty sections", () => {
    const empty: CompileOutput = {
      files: {},
      secretEnv: {},
      report: { adapter: "toy", irVersion: 0, entries: [] },
    };
    expect(renderBuild(empty, { steps: [] })).toBe("mode: default\n");
    expect(renderBuild(output, plan)).toBe(renderBuild(output, plan));
  });
});

describe("renderCapabilities", () => {
  const toy = (id: string, fields: CapabilityMatrix["fields"]) =>
    defineAdapter({
      id,
      irVersions: [0],
      capabilities: () => ({ fields }),
      detect: async () => ({ installed: false, facts: {} }),
      compile: () => {
        throw new Error("unused");
      },
      activate: () => ({ steps: [] }),
    });

  it("renders one row per declared field, in contract order", () => {
    const a = toy("a", {
      instructions: { support: "native" },
      "hooks.stop": { support: "advisory" },
    });
    const b = toy("b", {
      instructions: { support: "none" },
      "targets.b": { support: "native" },
      "permissions.deny": { support: "approximated" },
    });
    expect(renderCapabilities([a, b])).toBe(
      [
        "| field | a | b |",
        "|---|---|---|",
        "| instructions | native | — |",
        "| permissions.deny | — | approximated |",
        "| hooks.stop | advisory | — |",
        "| targets.b | — | native |",
        "",
      ].join("\n"),
    );
  });

  it("shows an overlay's block", () => {
    expect(
      renderBuild(
        {
          files: {},
          secretEnv: {},
          report: { adapter: "x", irVersion: 0, entries: [] },
        },
        {
          steps: [
            {
              kind: "overlay",
              path: "AGENTS.md",
              content: "hi",
              block: "donn",
            },
          ],
        },
      ),
    ).toContain("  overlay AGENTS.md block donn (2 chars)");
  });
});
