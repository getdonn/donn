import { corpus } from "@getdonn/adapter-sdk/conformance";
import type { AgentCompileInput } from "@getdonn/adapter-sdk";
import type { ResolvedPersona } from "@getdonn/spec";
import { describe, expect, it } from "vitest";
import { patchSubagentTs } from "./agent-ts.js";
import { EveCompileError } from "./errors.js";
import adapter from "./index.js";

// Subagents through the gateway: each `agent/subagents/<name>/agent.ts` spreads its
// `donnSubagent` entry. See docs/planning/24-adapter-eve.md, section 2.

const base = corpus.find((c) => c.name === "minimal")!.ir;

const RESEARCHER = `import { defineAgent } from "eve";

export default defineAgent({
  description: "Research a topic.",
  model: "openai/gpt-5.6-terra",
  tool: false,
});
`;
const WRITER = `import { defineAgent } from "eve";
import { openai } from "eve/models/openai";

export default defineAgent({ description: "Write.", model: openai("gpt-5") });
`;

const gateway: ResolvedPersona["models"] = {
  gateway: {
    type: "openai-compatible",
    baseURL: "http://localhost:4000/v1",
    apiKey: "secret://keychain/litellm",
  },
  default: "claude-sonnet-5-5",
};

function input(
  patch: Partial<ResolvedPersona> = {},
  subagents: Record<string, string> = { researcher: RESEARCHER },
  project: { edited?: string[]; existing?: string[] } = {},
): AgentCompileInput {
  const texts = Object.fromEntries(
    Object.entries(subagents).map(([name, text]) => [
      `agent/subagents/${name}/agent.ts`,
      text,
    ]),
  );
  return {
    personaId: "project/persona",
    ir: {
      ...base,
      agents: {
        kody: {
          template: "project/templates/kody",
          target: "local",
          path: "agents/kody",
          env: {},
        },
      },
      models: gateway,
      targets: { eve: { contextWindow: 200000 } },
      ...patch,
    },
    agent: "kody",
    frameworkVersion: "0.83.3",
    texts: {},
    project: {
      hasSandbox: false,
      hasRouteAuth: false,
      existing: [...Object.keys(texts), ...(project.existing ?? [])],
      texts,
      ...(project.edited && { edited: project.edited }),
    },
  };
}

const config = (out: ReturnType<typeof adapter.compile>) =>
  (out.files["agent/lib/donn/config.ts"] as { content: string }).content;
const about = (out: ReturnType<typeof adapter.compile>, word: string) =>
  out.report.entries.filter(
    (e) => e.path.includes(word) || e.reason.includes(word),
  );

describe("subagents with a gateway", () => {
  it("routes each one: a donnSubagent entry and an advisory naming both models", () => {
    const out = adapter.compile(input());
    expect(config(out)).toContain(
      [
        "export const donnSubagent = {",
        "  researcher: {",
        "    model,",
        "    modelContextWindowTokens: 200000,",
        "  },",
        "};",
      ].join("\n"),
    );
    expect(about(out, "subagent")).toEqual([
      {
        path: "models.default",
        outcome: "advisory",
        reason:
          "subagent researcher's own model openai/gpt-5.6-terra is replaced by the gateway's claude-sonnet-5-5",
      },
    ]);
  });

  it("says 'its own model' when the model is not a literal, and names a subagent without one", () => {
    const out = adapter.compile(
      input(
        {},
        {
          writer: WRITER,
          plain:
            'import { defineAgent } from "eve";\nexport default defineAgent({ description: "d" });\n',
        },
      ),
    );
    expect(about(out, "subagent").map((e) => e.reason)).toEqual([
      "subagent plain, which sets no model, gets the gateway's claude-sonnet-5-5",
      "subagent writer's own model is replaced by the gateway's claude-sonnet-5-5",
    ]);
  });

  it("an already patched subagent reads the same", () => {
    const patched = patchSubagentTs(RESEARCHER, "researcher");
    if (!patched.ok) throw new Error(patched.hint);
    const before = adapter.compile(input());
    const after = adapter.compile(input({}, { researcher: patched.text }));
    expect(after.files).toEqual(before.files);
    expect(after.report).toEqual(before.report);
  });

  it("targets.eve.subagents.<name>.model picks another gateway model, same window", () => {
    const out = adapter.compile(
      input({
        targets: {
          eve: {
            contextWindow: 200000,
            subagents: { researcher: { model: "gpt-5.6-mini" } },
          },
        },
      }),
    );
    expect(config(out)).toContain(
      [
        "  researcher: {",
        "    model: wrapLanguageModel({",
        '      model: gateway("gpt-5.6-mini"),',
        "      middleware: guard,",
        "    }),",
        "    modelContextWindowTokens: 200000,",
        "  },",
      ].join("\n"),
    );
    expect(about(out, "subagent")).toEqual([
      {
        path: "targets.eve.subagents.researcher.model",
        outcome: "advisory",
        reason:
          "subagent researcher's own model openai/gpt-5.6-terra is replaced by the gateway's gpt-5.6-mini",
      },
    ]);
  });

  it("a vercel-ai-gateway override is the plain id", () => {
    const out = adapter.compile(
      input({
        models: {
          gateway: { type: "vercel-ai-gateway" },
          default: "anthropic/claude-sonnet-5",
        },
        targets: {
          eve: { subagents: { researcher: { model: "openai/gpt-5-mini" } } },
        },
      }),
    );
    expect(config(out)).toContain(
      '  researcher: {\n    model: "openai/gpt-5-mini",\n  },',
    );
  });

  it("reports an override for no subagent, a bad model and an unknown key", () => {
    const out = adapter.compile(
      input({
        targets: {
          eve: {
            contextWindow: 200000,
            subagents: {
              ghost: { model: "x" },
              researcher: { model: "", window: 1 },
            },
          },
        },
      }),
    );
    expect(about(out, "targets.eve.subagents")).toEqual([
      {
        path: "targets.eve.subagents.ghost",
        outcome: "dropped",
        reason:
          "names no subagent: the template has no agent/subagents/ghost/agent.ts",
      },
      {
        path: "targets.eve.subagents.researcher.model",
        outcome: "dropped",
        reason:
          "must be a non-empty string; the subagent gets the gateway's default model",
      },
      {
        path: "targets.eve.subagents.researcher.window",
        outcome: "dropped",
        reason: "unknown key; only model is read",
      },
    ]);
  });

  it("reports targets.eve.subagents that is not a map", () => {
    const out = adapter.compile(
      input({ targets: { eve: { contextWindow: 200000, subagents: 3 } } }),
    );
    expect(about(out, "targets.eve.subagents")).toEqual([
      {
        path: "targets.eve.subagents",
        outcome: "dropped",
        reason: "targets.eve.subagents must map a subagent name to { model }",
      },
    ]);
  });

  it("refuses a subagent agent.ts it cannot edit, naming the file", () => {
    const dynamic =
      'import { defineAgent, defineDynamic } from "eve";\nexport default defineDynamic({ events: {} });\n';
    let error: unknown;
    try {
      adapter.compile(input({}, { researcher: dynamic }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EveCompileError);
    expect((error as EveCompileError).code).toBe("agent-ts-unrecognised");
    expect((error as Error).message).toContain(
      "agent/subagents/researcher/agent.ts",
    );
    expect((error as Error).message).toContain(
      'import { donnSubagent } from "../../lib/donn/config";',
    );
  });
});

describe("a subagent the user changed after donn's edit", () => {
  const FILE = "agent/subagents/researcher/agent.ts";
  const IMPORT = 'import { donnSubagent } from "../../lib/donn/config";';
  const shadowed = `import { defineAgent } from "eve";\n${IMPORT}\nexport default defineAgent({\n  description: "d",\n  ...donnSubagent.researcher,\n  model: "openai/x",\n});\n`;
  const bypass = (why: string) => ({
    path: "models.default",
    outcome: "dropped",
    reason: `subagent researcher ${why}, so its model bypasses the gateway; put \`...donnSubagent.researcher\` last in ${FILE} to route it`,
  });

  it("a spread a later model overrides is refused when donn has not edited the file", () => {
    expect(() => adapter.compile(input({}, { researcher: shadowed }))).toThrow(
      /agent-ts-unrecognised: agent\/subagents\/researcher\/agent\.ts: .*model or modelContextWindowTokens/,
    );
  });

  it("is reported, never refused or replaced, when donn edited it", () => {
    const out = adapter.compile(
      input({}, { researcher: shadowed }, { edited: [FILE] }),
    );
    expect(about(out, "subagent researcher")).toEqual([
      bypass(
        "spreads its donnSubagent entry before a model or modelContextWindowTokens that overrides it",
      ),
    ]);
  });

  it("a removed spread is reported when donn edited the file", () => {
    const out = adapter.compile(
      input({}, { researcher: RESEARCHER }, { edited: [FILE] }),
    );
    expect(about(out, "subagent researcher")).toEqual([
      bypass("no longer spreads its donnSubagent entry"),
    ]);
  });

  it("a file the edit no longer recognises is reported, not refused, when donn edited it", () => {
    const out = adapter.compile(
      input(
        {},
        { researcher: "export default defineDynamic({});\n" },
        { edited: [FILE] },
      ),
    );
    expect(about(out, "subagent researcher")).toEqual([
      bypass("is no longer a file donn can edit"),
    ]);
  });
});

describe("subagents donn does not edit", () => {
  it("reports each nested or other agent file under subagents/, with a gateway", () => {
    const out = adapter.compile(
      input({}, undefined, {
        existing: [
          "agent/subagents/researcher/subagents/checker/agent.ts",
          "agent/subagents/scout/agent.js",
          "agent/extensions/crm/subagents/reviewer/agent.ts",
          "agent/subagents/researcher/instructions.md",
        ],
      }),
    );
    expect(
      out.report.entries.filter((e) => e.reason.includes("donn edits")),
    ).toEqual(
      [
        "agent/extensions/crm/subagents/reviewer/agent.ts",
        "agent/subagents/researcher/subagents/checker/agent.ts",
        "agent/subagents/scout/agent.js",
      ].map((path) => ({
        path: "models.default",
        outcome: "advisory",
        reason: `${path} is not routed through the gateway; donn edits top-level agent/subagents/<name>/agent.ts only`,
      })),
    );
  });

  it("says nothing of them without a gateway", () => {
    const out = adapter.compile(
      input(
        { models: { default: "anthropic/claude-sonnet-5" }, targets: {} },
        undefined,
        { existing: ["agent/subagents/a/subagents/b/agent.ts"] },
      ),
    );
    expect(
      out.report.entries.filter((e) => e.reason.includes("donn edits")),
    ).toEqual([]);
  });
});

describe("subagents without a gateway", () => {
  const direct = {
    models: { default: "anthropic/claude-sonnet-5" },
    targets: {},
  };

  it("changes nothing: no donnSubagent, no entry", () => {
    const out = adapter.compile(input(direct));
    const none = adapter.compile(input(direct, {}));
    expect(out.files).toEqual(none.files);
    expect(out.report).toEqual(none.report);
    expect(config(out)).not.toContain("donnSubagent");
  });

  it("does not refuse a subagent it could not edit", () => {
    expect(() =>
      adapter.compile(
        input(direct, { researcher: "export default defineDynamic({});\n" }),
      ),
    ).not.toThrow();
  });

  it("keeps an empty entry for a subagent patched under an earlier gateway", () => {
    const patched = patchSubagentTs(RESEARCHER, "researcher");
    if (!patched.ok) throw new Error(patched.hint);
    const out = adapter.compile(input(direct, { researcher: patched.text }));
    expect(config(out)).toContain(
      "// No gateway: each subagent keeps its own model.\nexport const donnSubagent = {\n  researcher: {},\n};\n",
    );
    expect(about(out, "subagent")).toEqual([]);
  });

  it("drops an override: it needs the gateway", () => {
    const out = adapter.compile(
      input({
        ...direct,
        targets: { eve: { subagents: { researcher: { model: "x" } } } },
      }),
    );
    expect(about(out, "targets.eve.subagents")).toEqual([
      {
        path: "targets.eve.subagents.researcher.model",
        outcome: "dropped",
        reason:
          "applies only with models.gateway; without one the subagent keeps its own model",
      },
    ]);
  });
});
