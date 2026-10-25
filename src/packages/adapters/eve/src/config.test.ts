import { corpus } from "@getdonn/adapter-sdk/conformance";
import type { AgentCompileInput } from "@getdonn/adapter-sdk";
import type { ResolvedPersona } from "@getdonn/spec";
import { describe, expect, it } from "vitest";
import adapter from "./index.js";

const base = corpus.find((c) => c.name === "minimal")!.ir;

type Agent = ResolvedPersona["agents"][string];

function input(
  patch: Partial<ResolvedPersona> = {},
  agent: Partial<Agent> = {},
  rest: Partial<AgentCompileInput> = {},
): AgentCompileInput {
  return {
    personaId: "team/solo",
    ir: {
      ...base,
      agents: {
        reviewer: {
          template: "eve:blank",
          target: "local",
          path: "agents/reviewer",
          env: {},
          ...agent,
        },
      },
      models: { default: "anthropic/claude-sonnet-5" },
      ...patch,
    },
    agent: "reviewer",
    frameworkVersion: "0.83.2",
    texts: {},
    project: { hasSandbox: false, existing: [] },
    ...rest,
  };
}

const file = (out: ReturnType<typeof adapter.compile>, path: string) =>
  (out.files[path] as { content: string }).content;
const config = (out: ReturnType<typeof adapter.compile>) =>
  file(out, "agent/lib/donn/config.ts");

describe("lib/donn/config.ts, one row per spec 24 table line", () => {
  it("openai-compatible gateway", () => {
    const out = adapter.compile(
      input({
        models: {
          gateway: {
            type: "openai-compatible",
            baseURL: "https://llm.corp/v1",
            apiKey: "secret://vault/key",
            headers: { "x-team": "payments" },
          },
          default: "gpt-5",
        },
        targets: { eve: { contextWindow: 128000 } },
      }),
    );
    const text = config(out);
    expect(text).toContain(
      'import { createOpenAICompatible } from "@ai-sdk/openai-compatible";',
    );
    expect(text).toContain('name: "donn-gateway"');
    expect(text).toContain('baseURL: "https://llm.corp/v1"');
    expect(text).toContain("apiKey: process.env.DONN_SECRET_1!");
    expect(text).toContain('"x-team": "payments"');
    expect(text).toContain("includeUsage: true");
    expect(text).toContain('const base = gateway("gpt-5");');
    expect(text).toContain(
      "wrapLanguageModel({ model: base, middleware: guard })",
    );
    expect(text).toContain('import { missingEnv } from "./env";');
    expect(out.secretEnv).toEqual({ DONN_SECRET_1: "secret://vault/key" });
  });

  it("anthropic gateway, the id unchanged and no provider name", () => {
    const text = config(
      adapter.compile(
        input({
          models: {
            gateway: { type: "anthropic", baseURL: "https://a.corp" },
            default: "anthropic/claude-sonnet-5",
          },
        }),
      ),
    );
    expect(text).toContain(
      'import { createAnthropic } from "@ai-sdk/anthropic";',
    );
    expect(text).not.toContain("name:");
    expect(text).toContain('baseURL: "https://a.corp"');
    expect(text).toContain(
      'const base = gateway("anthropic/claude-sonnet-5");',
    );
    expect(text).not.toContain("apiKey");
  });

  it("vercel-ai-gateway is the plain string, key in AI_GATEWAY_API_KEY", () => {
    const out = adapter.compile(
      input({
        models: {
          gateway: { type: "vercel-ai-gateway", apiKey: "secret://vault/v" },
          default: "anthropic/claude-sonnet-5",
        },
      }),
    );
    expect(config(out)).toContain('const model = "anthropic/claude-sonnet-5";');
    expect(config(out)).not.toContain("wrapLanguageModel");
    expect(file(out, "agent/lib/donn/env.ts")).toContain("AI_GATEWAY_API_KEY");
    expect(out.secretEnv).toEqual({ AI_GATEWAY_API_KEY: "secret://vault/v" });
    expect(file(out, "agent/lib/donn/env.ts")).toContain(
      "process.env.AI_GATEWAY_API_KEY",
    );
  });

  it("vercel-ai-gateway on vercel needs no key (OIDC)", () => {
    const out = adapter.compile(
      input(
        {
          models: {
            gateway: { type: "vercel-ai-gateway" },
            default: "openai/gpt-5",
          },
        },
        { target: "vercel" },
      ),
    );
    expect(file(out, "agent/lib/donn/env.ts")).not.toContain(
      "AI_GATEWAY_API_KEY",
    );
  });

  it("direct anthropic and openai providers", () => {
    const a = config(
      adapter.compile(input({ models: { default: "anthropic/claude-x" } })),
    );
    expect(a).toContain('import { anthropic } from "eve/models/anthropic";');
    expect(a).toContain('const base = anthropic("claude-x");');
    expect(a).toContain('typeof base === "string"');
    const out = adapter.compile(
      input({ models: { default: "openai/gpt-5" } }, { target: "self-host" }),
    );
    expect(config(out)).toContain(
      'import { openai } from "eve/models/openai";',
    );
    expect(config(out)).toContain('const base = openai("gpt-5");');
    expect(file(out, "agent/lib/donn/env.ts")).toContain(
      "process.env.OPENAI_API_KEY",
    );
  });

  it("refuses another provider without a gateway", () => {
    expect(() =>
      adapter.compile(input({ models: { default: "google/gemini-3" } })),
    ).toThrow(
      /model-needs-gateway: set models.gateway, or use an anthropic\/ or openai\/ model/,
    );
  });

  it("prefers agents.<name>.model over models.default", () => {
    const text = config(
      adapter.compile(
        input({ models: { default: "anthropic/a" } }, { model: "openai/b" }),
      ),
    );
    expect(text).toContain('openai("b")');
  });

  it("refuses with a clear message when no model is set anywhere", () => {
    const run = () => adapter.compile(input({ models: {} }));
    expect(run).toThrow(/model-needs-gateway: .*no model/);
    expect(run).toThrow(/agents\.reviewer\.model.*models\.default/);
  });

  it("exports exactly the allowed keys and never undefined", () => {
    const text = config(
      adapter.compile(input({ models: { default: "anthropic/a" } })),
    );
    expect(
      [...text.matchAll(/^export (?:const )?(\w+)/gm)].map((m) => m[1]),
    ).toEqual(["donn"]);
    expect(text).not.toContain("undefined");
    expect(text).toMatch(/export const donn = \{\n  model,\n\};/);
  });
});

describe("targets.eve and the world", () => {
  it("contextWindow sets modelContextWindowTokens", () => {
    const out = adapter.compile(
      input({ targets: { eve: { contextWindow: 200000 } } }),
    );
    expect(config(out)).toContain("modelContextWindowTokens: 200000,");
    expect(out.report.entries.map((e) => e.path)).not.toContain(
      "targets.eve.contextWindow",
    );
  });

  it("reports unknown keys and adds no context window entry for direct providers", () => {
    const out = adapter.compile(input({ targets: { eve: { wat: 1 } } }));
    expect(config(out)).not.toContain("modelContextWindowTokens");
    expect(out.report.entries.map((e) => e.path)).not.toContain(
      "targets.eve.contextWindow",
    );
    expect(out.report.entries).toContainEqual({
      path: "targets.eve.wat",
      outcome: "dropped",
      reason: expect.stringContaining("unknown"),
    });
  });

  it("requires contextWindow for an openai-compatible gateway", () => {
    const run =
      (targets: ResolvedPersona["targets"] = {}) =>
      () =>
        adapter.compile(
          input({
            targets,
            models: {
              gateway: { type: "openai-compatible", baseURL: "https://g/v1" },
              default: "m",
            },
          }),
        );
    expect(run()).toThrow(
      /context-window-required: set targets\.eve\.contextWindow: eve cannot look up a custom gateway's model in the AI Gateway catalog/,
    );
    expect(run({ eve: { contextWindow: 0 } })).toThrow(
      /context-window-required/,
    );
  });

  it("advises on contextWindow for an anthropic gateway, once and at the model", () => {
    const gateway = { type: "anthropic", baseURL: "https://a.corp" } as const;
    const out = adapter.compile(
      input({ models: { gateway, default: "anthropic/claude-x" } }),
    );
    expect(
      out.report.entries.filter((e) => e.path.startsWith("models.default")),
    ).toEqual([
      {
        path: "models.default",
        outcome: "advisory",
        reason: expect.stringContaining("AI Gateway catalog"),
      },
    ]);
    const agentModel = adapter.compile(
      input({ models: { gateway } }, { model: "anthropic/claude-y" }),
    );
    expect(agentModel.report.entries.map((e) => e.path)).toContain(
      "agents.reviewer.model",
    );
    const set = adapter.compile(
      input({
        models: { gateway, default: "anthropic/claude-x" },
        targets: { eve: { contextWindow: 200000 } },
      }),
    );
    expect(set.report.entries.map((e) => e.path)).not.toContain(
      "models.default",
    );
  });

  it("reports a vercel-ai-gateway with headers as dropped, without a window entry", () => {
    const out = adapter.compile(
      input({
        models: {
          gateway: { type: "vercel-ai-gateway", headers: { "x-a": "1" } },
          default: "openai/gpt-5",
        },
      }),
    );
    expect(out.report.entries).toContainEqual({
      path: "models.gateway.headers",
      outcome: "dropped",
      reason: expect.any(String),
    });
    expect(out.report.entries.map((e) => e.path)).not.toContain(
      "models.default",
    );
  });

  it("rejects a non-positive contextWindow with a report entry", () => {
    const out = adapter.compile(
      input({ targets: { eve: { contextWindow: "big" } } }),
    );
    expect(config(out)).not.toContain("modelContextWindowTokens");
    expect(out.report.entries).toContainEqual({
      path: "targets.eve.contextWindow",
      outcome: "dropped",
      reason: expect.stringContaining("positive integer"),
    });
    expect(
      out.report.entries.filter((e) => e.path === "targets.eve.contextWindow"),
    ).toHaveLength(1);
  });

  it("uses the postgres world for self-host only", () => {
    const self = adapter.compile(input({}, { target: "self-host" }));
    expect(config(self)).toContain(
      'experimental: { workflow: { world: "@workflow/world-postgres" } },',
    );
    expect(file(self, "agent/lib/donn/env.ts")).toContain(
      "process.env.WORKFLOW_POSTGRES_URL",
    );
    for (const target of ["local", "vercel"] as const) {
      const out = adapter.compile(input({}, { target }));
      expect(config(out)).not.toContain("experimental");
      expect(file(out, "agent/lib/donn/env.ts")).not.toContain("WORKFLOW");
    }
  });
});

describe("sandbox.ts", () => {
  it("is written for self-host without a template sandbox", () => {
    const out = adapter.compile(input({}, { target: "self-host" }));
    expect(file(out, "agent/sandbox.ts")).toBe(
      [
        'import { defineSandbox } from "eve/sandbox";',
        'import { DockerSandbox } from "eve/sandbox/docker";',
        "",
        "export const environment = DockerSandbox.environment();",
        'export default defineSandbox(() => environment.open({ networkPolicy: "allow-all" }));',
        "",
      ].join("\n"),
    );
  });

  it("is not written when the template has one, or for other targets", () => {
    expect(
      adapter.compile(
        input(
          {},
          { target: "self-host" },
          { project: { hasSandbox: true, existing: [] } },
        ),
      ).files["agent/sandbox.ts"],
    ).toBeUndefined();
    for (const target of ["local", "vercel"] as const) {
      expect(
        adapter.compile(input({}, { target })).files["agent/sandbox.ts"],
      ).toBeUndefined();
    }
  });
});

describe("env.ts", () => {
  it("lists exactly the names the generated files read", () => {
    const out = adapter.compile(
      input(
        {
          models: {
            gateway: {
              type: "openai-compatible",
              baseURL: "https://llm.corp/v1",
              apiKey: "secret://vault/k",
            },
            default: "m",
          },
          targets: { eve: { contextWindow: 128000 } },
        },
        { target: "self-host", env: { REGION: "eu", EMPTY: "" } },
      ),
    );
    const text = file(out, "agent/lib/donn/env.ts");
    const read = [...text.matchAll(/process\.env\.(\w+)/g)].map((m) => m[1]);
    expect(read.sort()).toEqual(
      [
        "DATABASE_URL",
        "DONN_SECRET_1",
        "EMPTY",
        "REGION",
        "WORKFLOW_POSTGRES_URL",
      ].sort(),
    );
    expect(out.env).toEqual({ REGION: "eu", EMPTY: "" });
    // Loading never throws (eve build evaluates it); only the model call refuses.
    expect(text).not.toContain("throw");
    expect(text).toContain("console.warn");
    expect(text).toContain("export function missingEnv");
    expect(text).toContain("=== undefined");
    expect(config(out)).toContain("throw new Error(");
    expect(config(out)).toContain("donn: missing environment variables");
  });

  it("does not require the direct provider key for local, but does elsewhere", () => {
    const names = (target: "local" | "self-host" | "vercel") =>
      file(adapter.compile(input({}, { target })), "agent/lib/donn/env.ts");
    expect(names("local")).not.toContain("ANTHROPIC_API_KEY");
    expect(names("self-host")).toContain("process.env.ANTHROPIC_API_KEY");
    expect(names("vercel")).toContain("process.env.ANTHROPIC_API_KEY");
  });
});

describe("connections", () => {
  const url = "https://example.com/mcp";
  const withServers = (servers: ResolvedPersona["mcp"]["servers"]) =>
    input({ mcp: { servers } });

  it("writes a description default and the targets.eve override", () => {
    const out = adapter.compile(
      input({
        mcp: { servers: { a: { url }, b: { url } } },
        targets: {
          eve: { connections: { b: { description: "Docs search" } } },
        },
      }),
    );
    expect(file(out, "agent/connections/donn-a.ts")).toContain(
      'description: "a MCP server from persona team/solo"',
    );
    expect(file(out, "agent/connections/donn-b.ts")).toContain(
      'description: "Docs search"',
    );
    expect(file(out, "agent/connections/donn-a.ts")).not.toContain("transport");
  });

  it("secrets in headers: bearer to auth.getToken, Basic and plain stay headers", () => {
    const out = adapter.compile(
      withServers({
        bearer: { url, headers: { Authorization: "Bearer secret://vault/k" } },
        basic: {
          url,
          headers: {
            Authorization: "Basic secret://vault/b",
            "X-Api-Key": "secret://vault/x",
            "X-Plain": "hello",
          },
        },
      }),
    );
    const bearer = file(out, "agent/connections/donn-bearer.ts");
    expect(bearer).toContain(
      "auth: { getToken: async () => ({ token: process.env.DONN_SECRET_3! }) },",
    );
    expect(bearer).not.toContain("headers");
    const basic = file(out, "agent/connections/donn-basic.ts");
    expect(basic).not.toContain("getToken");
    expect(basic).toContain(
      "Authorization: `Basic ${process.env.DONN_SECRET_1}`",
    );
    expect(basic).toContain('"X-Api-Key": process.env.DONN_SECRET_2!');
    expect(basic).toContain('"X-Plain": "hello"');
    expect(out.secretEnv).toEqual({
      DONN_SECRET_1: "secret://vault/b",
      DONN_SECRET_2: "secret://vault/x",
      DONN_SECRET_3: "secret://vault/k",
    });
    for (const f of Object.values(out.files))
      expect((f as { content?: string }).content ?? "").not.toContain(
        "secret://",
      );
  });

  it("numbers secrets in walk order and reuses a ref's number", () => {
    const out = adapter.compile(
      input({
        models: {
          gateway: {
            type: "openai-compatible",
            baseURL: "https://g",
            apiKey: "secret://g/key",
            headers: { "x-b": "secret://g/b", "x-a": "secret://g/a" },
          },
          default: "m",
        },
        targets: { eve: { contextWindow: 128000 } },
        mcp: {
          servers: {
            z: { url, headers: { "X-K": "secret://g/a" } },
            a: { url, headers: { "X-K": "secret://g/new" } },
          },
        },
      }),
    );
    expect(out.secretEnv).toEqual({
      DONN_SECRET_1: "secret://g/key",
      DONN_SECRET_2: "secret://g/a",
      DONN_SECRET_3: "secret://g/b",
      DONN_SECRET_4: "secret://g/new",
    });
  });

  it("drops stdio and gateway:// servers with their reasons", () => {
    const out = adapter.compile(
      withServers({
        local: { command: "npx" },
        remote: { ref: "gateway://corp/db" },
        ok: { url },
      }),
    );
    expect(
      Object.keys(out.files).filter((p) => p.includes("connections")),
    ).toEqual(["agent/connections/donn-ok.ts"]);
    expect(out.report.entries).toContainEqual({
      path: "mcp.servers.local",
      outcome: "dropped",
      reason: "eve connects to HTTP MCP and OpenAPI only",
    });
    expect(out.report.entries).toContainEqual({
      path: "mcp.servers.remote",
      outcome: "dropped",
      reason: expect.stringContaining("gateway"),
    });
  });

  it("keeps a secret ref out of the gateway baseURL", () => {
    const out = adapter.compile(
      input({
        targets: { eve: { contextWindow: 1000 } },
        models: {
          gateway: {
            type: "openai-compatible",
            baseURL: "https://g/v1?key=secret://g/q&x=1",
          },
          default: "m",
        },
      }),
    );
    expect(config(out)).toContain(
      "baseURL: `https://g/v1?key=${process.env.DONN_SECRET_1}&x=1`",
    );
    expect(config(out)).not.toContain("secret://");
    expect(out.secretEnv).toEqual({ DONN_SECRET_1: "secret://g/q" });
  });

  it("ends a ref at a character a header or URL uses", () => {
    const out = adapter.compile(
      withServers({
        a: { url, headers: { "X-K": "k=secret://g/a;v=1,secret://g/b)" } },
      }),
    );
    expect(out.secretEnv).toEqual({
      DONN_SECRET_1: "secret://g/a",
      DONN_SECRET_2: "secret://g/b",
    });
    expect(file(out, "agent/connections/donn-a.ts")).toContain(
      "`k=${process.env.DONN_SECRET_1};v=1,${process.env.DONN_SECRET_2})`",
    );
  });

  it("refuses two Authorization headers that both carry a bearer secret", () => {
    expect(() =>
      adapter.compile(
        withServers({
          a: {
            url,
            headers: {
              Authorization: "Bearer secret://g/a",
              authorization: "Bearer secret://g/b",
            },
          },
        }),
      ),
    ).toThrow(/two Authorization headers/);
  });

  it("reports malformed or unmatched targets.eve.connections entries", () => {
    const out = adapter.compile(
      input({
        mcp: {
          servers: { a: { url }, local: { command: "npx" }, b: { url } },
        },
        targets: {
          eve: {
            connections: {
              a: { description: "", extra: 1 },
              b: "text",
              local: { description: "x" },
              nope: { description: "x" },
            },
          },
        },
      }),
    );
    const dropped = Object.fromEntries(
      out.report.entries
        .filter((e) => e.path.startsWith("targets.eve.connections"))
        .map((e) => [e.path, e.outcome]),
    );
    expect(dropped).toEqual({
      "targets.eve.connections.a.description": "dropped",
      "targets.eve.connections.a.extra": "dropped",
      "targets.eve.connections.b": "dropped",
      "targets.eve.connections.local": "dropped",
      "targets.eve.connections.nope": "dropped",
    });
    expect(
      out.report.entries.filter((e) => e.path === "targets.eve.connections"),
    ).toEqual([]);
    const bad = adapter.compile(
      input({ targets: { eve: { connections: "x" } } }),
    );
    expect(bad.report.entries.map((e) => e.path)).toContain(
      "targets.eve.connections",
    );
  });
});

describe("final review fixes", () => {
  const selfHost = { target: "self-host" as const };
  const servers = (
    s: Record<string, { url: string; headers?: Record<string, string> }>,
  ) => input({ mcp: { servers: s } });

  describe("sandbox.ts is never overwritten or shadowed (I1)", () => {
    it.each([
      "agent/sandbox.ts",
      "agent/sandbox.mts",
      "agent/sandbox.js",
      "agent/sandbox.mjs",
      "agent/sandbox.cjs",
      "agent/sandbox/index.ts",
      "sandbox/default.ts",
    ])(
      "refuses an existing %s when donn would write sandbox.ts",
      (existing) => {
        const run = () =>
          adapter.compile(
            input({}, selfHost, {
              project: { hasSandbox: false, existing: [existing] },
            }),
          );
        expect(run).toThrow(/slot-collision/);
        expect(run).toThrow(existing);
      },
    );

    it("does not object when donn writes no sandbox", () => {
      const existing = ["agent/sandbox.ts"];
      expect(() =>
        adapter.compile(
          input({}, selfHost, { project: { hasSandbox: true, existing } }),
        ),
      ).not.toThrow();
      expect(() =>
        adapter.compile(
          input({}, {}, { project: { hasSandbox: false, existing } }),
        ),
      ).not.toThrow();
    });
  });

  describe("agent env (I2)", () => {
    it("moves a whole secret ref to secretEnv under its own name", () => {
      const out = adapter.compile(
        input({}, { env: { TOKEN: "secret://vault/t", REGION: "eu" } }),
      );
      expect(out.env).toEqual({ REGION: "eu" });
      expect(out.secretEnv.TOKEN).toBe("secret://vault/t");
    });

    it("refuses an env name that the gateway key already sets from another ref", () => {
      const run = () =>
        adapter.compile(
          input(
            {
              models: {
                gateway: { type: "vercel-ai-gateway", apiKey: "secret://v/a" },
                default: "anthropic/claude-sonnet-5",
              },
            },
            { env: { AI_GATEWAY_API_KEY: "secret://v/b" } },
          ),
        );
      expect(run).toThrow(/env-collision/);
      expect(run).toThrow("secret://v/a");
      expect(run).toThrow("secret://v/b");
    });

    it("accepts the same ref twice, and refuses a plain value on a secret name", () => {
      const models = {
        gateway: { type: "vercel-ai-gateway" as const, apiKey: "secret://v/a" },
        default: "anthropic/claude-sonnet-5",
      };
      expect(() =>
        adapter.compile(
          input({ models }, { env: { AI_GATEWAY_API_KEY: "secret://v/a" } }),
        ),
      ).not.toThrow();
      expect(() =>
        adapter.compile(
          input({ models }, { env: { AI_GATEWAY_API_KEY: "plain" } }),
        ),
      ).toThrow(/env-collision/);
    });
  });

  describe("whole-value secret refs (I3)", () => {
    it.each(["secret://vault/a,b", "secret://v/x?y=1"])(
      "keeps %s whole in a header and a bearer",
      (ref) => {
        const out = adapter.compile(
          servers({
            plain: { url: "https://x.example/mcp", headers: { "X-K": ref } },
            bearer: {
              url: "https://x.example/mcp",
              headers: { Authorization: `Bearer ${ref}` },
            },
          }),
        );
        expect(Object.values(out.secretEnv)).toEqual([ref]);
        const plain = file(out, "agent/connections/donn-plain.ts");
        expect(plain).toContain('"X-K": process.env.DONN_SECRET_1!');
        expect(file(out, "agent/connections/donn-bearer.ts")).toContain(
          "token: process.env.DONN_SECRET_1!",
        );
      },
    );

    it("still stops an embedded ref at a delimiter", () => {
      const out = adapter.compile(
        servers({
          a: { url: "https://x.example/mcp?key=secret://v/k&b=1" },
        }),
      );
      expect(Object.values(out.secretEnv)).toEqual(["secret://v/k"]);
      expect(file(out, "agent/connections/donn-a.ts")).toContain(
        "`https://x.example/mcp?key=${process.env.DONN_SECRET_1}&b=1`",
      );
    });
  });

  it("a vercel-ai-gateway with an anthropic/ model needs no thinking advisory (M4)", () => {
    const out = adapter.compile(
      input(
        {
          models: {
            gateway: { type: "vercel-ai-gateway" },
            default: "anthropic/claude-sonnet-5",
          },
        },
        { template: "eve:personal-agent-template" },
      ),
    );
    expect(
      out.report.entries.filter((e) => e.reason.includes("providerOptions")),
    ).toEqual([]);
  });

  it("compares skill and connection names case-insensitively", () => {
    const skills = {
      skills: [{ name: "x", source: "team/skills/x" }],
    };
    const texts = { "team/skills/x/SKILL.md": "---\ndescription: x\n---\n" };
    for (const existing of [
      "agent/skills/Donn-X/SKILL.md",
      "agent/connections/Donn-X.ts",
    ]) {
      expect(() =>
        adapter.compile(
          input(
            {
              ...skills,
              mcp: { servers: { x: { url: "https://x.example" } } },
            },
            {},
            { texts, project: { hasSandbox: false, existing: [existing] } },
          ),
        ),
      ).toThrow(/slot-collision/);
    }
  });

  it("names the scripts caveat's Docker need (M5)", () => {
    const out = adapter.compile(
      input(
        { skills: [{ name: "r", source: "team/skills/r" }] },
        {},
        {
          texts: {
            "team/skills/r/SKILL.md": "---\ndescription: x\n---\n",
            "team/skills/r/scripts/a.sh": "echo",
          },
        },
      ),
    );
    expect(
      out.report.entries.find((e) => e.path === "skills[r]")?.reason,
    ).toContain("locally that needs Docker running when eve builds");
  });

  it("self-host's world needs WORKFLOW_POSTGRES_URL or DATABASE_URL (M6)", () => {
    const text = file(
      adapter.compile(input({}, selfHost)),
      "agent/lib/donn/env.ts",
    );
    expect(text).toContain("DATABASE_URL: process.env.DATABASE_URL");
    expect(text).toContain(
      "WORKFLOW_POSTGRES_URL: process.env.WORKFLOW_POSTGRES_URL",
    );
    expect(text).toContain('join(" or ")');
    // The values object, which must all be set, holds neither.
    const values = text.slice(text.indexOf("const values"), text.indexOf("};"));
    expect(values).not.toContain("DATABASE_URL");
  });

  it("refuses a framework version outside the adapter's range (M9)", () => {
    for (const frameworkVersion of ["0.84.0", "0.83.1", "1.0.0", "x"]) {
      expect(() =>
        adapter.compile(input({}, {}, { frameworkVersion })),
      ).toThrow(/framework-version/);
    }
    expect(() =>
      adapter.compile(input({}, {}, { frameworkVersion: "0.83.9" })),
    ).not.toThrow();
  });
});
