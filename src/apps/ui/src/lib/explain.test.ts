import type { ResolveOutput } from "@getdonn/cli-schemas";
import { describe, expect, it } from "vitest";
import { explainValue, fieldGroups, layerFile, layerKind } from "./explain";

// The presentation lookups over a `resolve --json` answer: which layer set a value, what it
// displaced, which lock covers it; the field groups; where a layer's file is.

type Result = Pick<ResolveOutput, "provenance" | "history" | "warnings"> & {
  ir: Pick<ResolveOutput["ir"], "locks">;
};

const result: Result = {
  provenance: {
    "permissions.deny[Bash(rm -rf:*)]": "org/base",
    "skills[pr-review]": "team/payments",
    "agents.bot": "team/payments",
  },
  history: [
    {
      path: "skills[pr-review]",
      layer: "team/payments",
      kind: "override",
      from: "org/base",
    },
    {
      path: "instructions[payments-overview]",
      layer: "project/persona",
      kind: "remove",
      from: "team/payments",
      replacedBy: "instructions[checkout-overview]",
    },
  ],
  warnings: [
    {
      code: "allow-shadowed-by-ask",
      path: "skills[pr-review]",
      layer: "team/payments",
    },
  ],
  ir: {
    locks: [
      { path: "permissions.deny", layer: "org/base" },
      { path: "agents.define.bot", layer: "org/base" },
    ],
  },
};

describe("explainValue", () => {
  it("names the layer, the overridden layer and a covering lock", () => {
    expect(explainValue(result, "permissions.deny[Bash(rm -rf:*)]")).toEqual({
      layer: "org/base",
      overrides: [],
      replaced: [],
      locks: [{ path: "permissions.deny", layer: "org/base" }],
      warnings: [],
    });
  });

  it("carries what a layer displaced and the warnings on the value", () => {
    const explained = explainValue(result, "skills[pr-review]");
    expect(explained.layer).toBe("team/payments");
    expect(explained.overrides).toEqual([result.history[0]]);
    expect(explained.warnings).toHaveLength(1);
    expect(explained.locks).toEqual([]);
  });

  it("finds the removal a value replaced", () => {
    expect(
      explainValue(result, "instructions[checkout-overview]").replaced,
    ).toEqual([result.history[1]]);
  });

  it("checks an agent against its definition's lock path", () => {
    expect(explainValue(result, "agents.bot").locks).toHaveLength(1);
  });

  it("has no layer for a value nobody set", () => {
    expect(explainValue(result, "skills[none]").layer).toBeUndefined();
  });
});

describe("layerFile", () => {
  it("is the project's persona file for the project layer only", () => {
    expect(layerFile("project/persona", "/code/api")).toBe(
      "/code/api/.donn/persona.yaml",
    );
    expect(layerFile("team/payments", "/code/api")).toBeUndefined();
    expect(layerFile("project/persona", undefined)).toBeUndefined();
  });

  it("splits a ref into its kind", () => {
    expect(layerKind("org/base")).toBe("org");
    expect(layerKind("user/overrides")).toBe("user");
  });
});

describe("fieldGroups", () => {
  const ir = {
    instructions: [{ id: "a", inline: "text" }],
    skills: [{ name: "s", source: "team/skills/s" }],
    mcp: {
      gateway: "bifrost://corp",
      servers: {
        db: { command: "npx", env: { TOKEN: "secret://vault/x" } },
        web: { url: "https://x.test" },
      },
    },
    permissions: { allow: ["Read(./**)"], deny: [], ask: ["Bash(git push:*)"] },
    hooks: { "pre-tool-use": [{ id: "h", run: "x.sh" }] },
    models: { default: "opus" },
    agents: {},
    secrets: { providers: { vault: { type: "hashicorp-vault" } } },
  };

  it("groups values with their paths, and shows only secret refs", () => {
    const groups = Object.fromEntries(
      fieldGroups(ir as never).map((g) => [g.id, g.items]),
    );
    expect(groups.instructions![0]).toMatchObject({ path: "instructions[a]" });
    expect(groups.mcp!.map((i) => i.path)).toEqual([
      "mcp.gateway",
      "mcp.servers.db",
      "mcp.servers.web",
    ]);
    expect(groups.permissions!.map((i) => i.path)).toEqual([
      "permissions.ask[Bash(git push:*)]",
      "permissions.allow[Read(./**)]",
    ]);
    expect(groups.hooks![0]!.path).toBe("hooks.pre-tool-use[h]");
    expect(groups.models![0]!.path).toBe("models.default");
    expect(groups.secrets!.map((i) => i.label)).toEqual([
      "vault",
      "secret://vault/x",
    ]);
    expect(groups.secrets![1]!.path).toBe("mcp.servers.db");
  });
});
