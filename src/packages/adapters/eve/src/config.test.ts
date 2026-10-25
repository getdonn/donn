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
    expect(text).toContain('const model = gateway("gpt-5");');
    expect(out.secretEnv).toEqual({ DONN_SECRET_1: "secret://vault/key" });
  });

  it("anthropic gateway, named so eve does not take it for anthropic", () => {
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
    expect(text).toContain('name: "donn-gateway"');
    expect(text).toContain('baseURL: "https://a.corp"');
    expect(text).toContain('const model = gateway("claude-sonnet-5");');
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
    expect(a).toContain('const model = anthropic("claude-x");');
    const out = adapter.compile(input({ models: { default: "openai/gpt-5" } }));
    expect(config(out)).toContain(
      'import { openai } from "eve/models/openai";',
    );
    expect(config(out)).toContain('const model = openai("gpt-5");');
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

  it("reports the fallback when contextWindow is absent, and unknown keys", () => {
    const out = adapter.compile(input({ targets: { eve: { wat: 1 } } }));
    expect(config(out)).not.toContain("modelContextWindowTokens");
    expect(out.report.entries).toContainEqual({
      path: "targets.eve.contextWindow",
      outcome: "approximated",
      reason: expect.stringContaining("eve"),
    });
    expect(out.report.entries).toContainEqual({
      path: "targets.eve.wat",
      outcome: "dropped",
      reason: expect.stringContaining("unknown"),
    });
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
        },
        { target: "self-host", env: { REGION: "eu" } },
      ),
    );
    const text = file(out, "agent/lib/donn/env.ts");
    const read = [...text.matchAll(/process\.env\.(\w+)/g)].map((m) => m[1]);
    expect(read.sort()).toEqual(
      ["DONN_SECRET_1", "REGION", "WORKFLOW_POSTGRES_URL"].sort(),
    );
    expect(out.env).toEqual({ REGION: "eu" });
    expect(text).toContain("throw new Error");
    expect(config(out)).toContain('import "./env";');
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
});
