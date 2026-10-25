import { describe, expect, it } from "vitest";
import {
  InstructionFragment,
  Persona,
  PersonaDocument,
  PersonaOverlay,
} from "./persona.js";

const base = {
  apiVersion: "donn/v0",
  kind: "Persona",
  metadata: { name: "base" },
};

describe("Persona", () => {
  it("accepts a minimal persona", () => {
    expect(Persona.safeParse(base).success).toBe(true);
  });

  it("rejects unknown keys at every level", () => {
    expect(Persona.safeParse({ ...base, instructoins: [] }).success).toBe(
      false,
    );
    expect(
      Persona.safeParse({ ...base, permissions: { alow: [] } }).success,
    ).toBe(false);
    expect(
      Persona.safeParse({ ...base, hooks: { "pre-tool-uze": [] } }).success,
    ).toBe(false);
  });

  it("rejects a wrong apiVersion", () => {
    expect(Persona.safeParse({ ...base, apiVersion: "donn/v1" }).success).toBe(
      false,
    );
  });

  it("requires extends refs to start with a known layer", () => {
    expect(
      Persona.safeParse({ ...base, extends: ["org/base", "team/pay-ments"] })
        .success,
    ).toBe(true);
    expect(
      Persona.safeParse({ ...base, extends: ["division/base"] }).success,
    ).toBe(false);
    expect(Persona.safeParse({ ...base, extends: ["org"] }).success).toBe(
      false,
    );
  });

  it("accepts each MCP server form and rejects mixed ones", () => {
    const servers = {
      jira: { ref: "gateway://jira" },
      db: {
        command: "npx",
        args: ["-y", "@corp/db"],
        env: { TOKEN: "secret://vault/db" },
      },
      remote: { url: "https://mcp.corp/sse", transport: "sse" },
    };
    expect(Persona.safeParse({ ...base, mcp: { servers } }).success).toBe(true);
    const mixed = { ref: "gateway://jira", command: "npx" };
    expect(
      Persona.safeParse({ ...base, mcp: { servers: { x: mixed } } }).success,
    ).toBe(false);
  });

  it("checks hook removals are <event>[<id>]", () => {
    const ok = { remove: ["pre-tool-use[audit-log]"] };
    expect(Persona.safeParse({ ...base, hooks: ok }).success).toBe(true);
    const bad = { remove: ["audit-log"] };
    expect(Persona.safeParse({ ...base, hooks: bad }).success).toBe(false);
  });

  it("leaves lock path validity to the resolver", () => {
    // 079-invalid-lock-path must reach the resolver to be reported with its layer.
    expect(
      Persona.safeParse({ ...base, locks: ["permissions.denny"] }).success,
    ).toBe(true);
  });
});

describe("InstructionFragment", () => {
  it("takes exactly one of file or inline", () => {
    expect(
      InstructionFragment.safeParse({ id: "a", file: "./a.md" }).success,
    ).toBe(true);
    expect(
      InstructionFragment.safeParse({ id: "a", inline: "text" }).success,
    ).toBe(true);
    expect(InstructionFragment.safeParse({ id: "a" }).success).toBe(false);
    expect(
      InstructionFragment.safeParse({ id: "a", file: "./a.md", inline: "text" })
        .success,
    ).toBe(false);
  });

  it("accepts append, prepend and replace(<id>) positions only", () => {
    for (const position of [
      "append",
      "prepend",
      "replace(payments-overview)",
    ]) {
      expect(
        InstructionFragment.safeParse({ id: "a", inline: "x", position })
          .success,
      ).toBe(true);
    }
    for (const position of ["after", "replace()", "replace(Bad_Id)"]) {
      expect(
        InstructionFragment.safeParse({ id: "a", inline: "x", position })
          .success,
      ).toBe(false);
    }
  });
});

describe("policy", () => {
  it("accepts a policy block", () => {
    const policy = {
      permissions: "exclusive",
      hooks: "exclusive",
      mcp: "exclusive",
      bypassPermissions: "disabled",
    };
    expect(Persona.parse({ ...base, policy }).policy).toEqual(policy);
    expect(Persona.safeParse({ ...base, policy: {} }).success).toBe(true);
  });

  it("rejects unknown policy keys and values", () => {
    expect(
      Persona.safeParse({ ...base, policy: { permissions: "shared" } }).success,
    ).toBe(false);
    expect(
      Persona.safeParse({ ...base, policy: { network: "exclusive" } }).success,
    ).toBe(false);
  });

  it("an overlay cannot carry policy", () => {
    const overlay = { apiVersion: "donn/v0", kind: "PersonaOverlay" };
    expect(
      PersonaOverlay.safeParse({ ...overlay, policy: { mcp: "exclusive" } })
        .success,
    ).toBe(false);
  });
});

describe("models", () => {
  const gw = {
    type: "openai-compatible",
    baseURL: "https://llm.corp/v1",
    apiKey: "secret://vault/llm/gateway-key",
    headers: { "x-bf-vk": "secret://vault/llm/virtual-key" },
  };
  const parse = (models: unknown) => Persona.safeParse({ ...base, models });

  it("accepts the spec 23 §1 example", () => {
    const models = { gateway: gw, default: "anthropic/claude-sonnet-5-5" };
    expect(Persona.parse({ ...base, models }).models).toEqual(models);
  });

  it("baseURL is required for openai-compatible and anthropic, refused for vercel-ai-gateway", () => {
    expect(parse({ gateway: { type: "openai-compatible" } }).success).toBe(
      false,
    );
    expect(parse({ gateway: { type: "anthropic" } }).success).toBe(false);
    expect(
      parse({ gateway: { type: "anthropic", baseURL: "https://a.io" } })
        .success,
    ).toBe(true);
    expect(
      parse({
        gateway: { type: "vercel-ai-gateway", baseURL: "https://a.io" },
      }).success,
    ).toBe(false);
    expect(parse({ gateway: { type: "vercel-ai-gateway" } }).success).toBe(
      true,
    );
  });

  it("baseURL is http or https only", () => {
    for (const baseURL of [
      "ftp://a.io",
      "file:///etc/passwd",
      "javascript:x",
    ]) {
      expect(
        parse({ gateway: { type: "anthropic", baseURL } }).success,
        baseURL,
      ).toBe(false);
    }
    expect(
      parse({ gateway: { type: "anthropic", baseURL: "http://a.io" } }).success,
    ).toBe(true);
  });

  it("header names are HTTP tokens", () => {
    expect(
      parse({ gateway: { ...gw, headers: { "bad name": "x" } } }).success,
    ).toBe(false);
    expect(parse({ gateway: { ...gw, headers: { "a:b": "x" } } }).success).toBe(
      false,
    );
    expect(
      parse({ gateway: { ...gw, headers: { "X-Api_1": "x" } } }).success,
    ).toBe(true);
  });

  it("apiKey must be a secret ref", () => {
    expect(parse({ gateway: { ...gw, apiKey: "sk-live-123" } }).success).toBe(
      false,
    );
  });

  it("apiKey needs something after the scheme", () => {
    expect(parse({ gateway: { ...gw, apiKey: "secret://" } }).success).toBe(
      false,
    );
  });

  it("unknown gateway type is refused", () => {
    expect(parse({ gateway: { type: "bedrock" } }).success).toBe(false);
  });

  it("an overlay may carry models", () => {
    const overlay = { apiVersion: "donn/v0", kind: "PersonaOverlay" };
    expect(
      PersonaOverlay.safeParse({ ...overlay, models: { default: "a/b" } })
        .success,
    ).toBe(true);
  });
});

describe("agents", () => {
  const agent = {
    template: "eve:github-project-maintainer",
    target: "self-host",
    path: "agents/pr-reviewer",
    model: "anthropic/claude-opus-5-5",
    env: {
      GITHUB_APP_ID: "123456",
      GITHUB_APP_PRIVATE_KEY: "secret://vault/gh/reviewer-key",
    },
  };
  const define = (name: string, over: Record<string, unknown> = {}) =>
    Persona.safeParse({
      ...base,
      agents: { define: { [name]: { ...agent, ...over } } },
    });

  it("accepts the spec 23 §2 example", () => {
    const agents = {
      define: { "pr-reviewer": agent },
      remove: ["old-triage-bot"],
    };
    expect(Persona.parse({ ...base, agents }).agents).toEqual(agents);
  });

  it("agent name rules", () => {
    expect(define("PR-Reviewer").success).toBe(false);
    expect(define("a".repeat(65)).success).toBe(false);
    expect(define("a".repeat(64)).success).toBe(true);
    expect(
      Persona.safeParse({ ...base, agents: { remove: ["Bad Name"] } }).success,
    ).toBe(false);
  });

  it("target is local, self-host or vercel", () => {
    expect(define("a", { target: "lambda" }).success).toBe(false);
    expect(define("a", { target: "vercel" }).success).toBe(true);
  });

  it("path rules", () => {
    for (const path of [
      "./agents/../..",
      "/abs",
      ".donn/x",
      ".donn",
      "agents/../.donn/x",
      ".DONN/x",
      ".Donn",
      ".git/hooks",
      ".GIT",
      "a\\..\\..\\x",
      "C:/x",
      "..",
      "../x",
      ".",
      "./",
      "a/..",
    ]) {
      expect(define("a", { path }).success, path).toBe(false);
    }
    for (const path of ["agents/./pr", "agents/pr", ".donnx/a"]) {
      expect(define("a", { path }).success, path).toBe(true);
    }
  });

  it("env names are uppercase and DONN_ is reserved", () => {
    expect(define("a", { env: { lower: "x" } }).success).toBe(false);
    expect(define("a", { env: { "1A": "x" } }).success).toBe(false);
    expect(define("a", { env: { DONN_HOME: "x" } }).success).toBe(false);
    expect(define("a", { env: { A_1: "x" } }).success).toBe(true);
    expect(define("a", { env: { "A\n": "x" } }).success).toBe(false);
  });

  it("template is eve:<slug> or a relative path", () => {
    expect(define("a", { template: "eve:blank" }).success).toBe(true);
    expect(define("a", { template: "templates/reviewer" }).success).toBe(true);
    for (const template of [
      "eve:Bad Slug",
      "/abs",
      "../x",
      "a/../../x",
      "",
      ".",
      "a/..",
      "eve:",
      "eve:a/b",
      "Eve:blank",
      "https://x.io/t",
      "langgraph:x",
      "a\\..\\..\\x",
      "C:/x",
    ]) {
      expect(define("a", { template }).success, template).toBe(false);
    }
  });

  it("an overlay cannot carry agents", () => {
    const overlay = { apiVersion: "donn/v0", kind: "PersonaOverlay" };
    expect(
      PersonaOverlay.safeParse({
        ...overlay,
        agents: { define: { a: agent } },
      }).success,
    ).toBe(false);
  });
});

describe("PersonaOverlay", () => {
  it("cannot carry metadata, extends or locks", () => {
    const overlay = { apiVersion: "donn/v0", kind: "PersonaOverlay" };
    expect(PersonaOverlay.safeParse(overlay).success).toBe(true);
    for (const key of ["metadata", "extends", "locks"]) {
      expect(PersonaOverlay.safeParse({ ...overlay, [key]: [] }).success).toBe(
        false,
      );
    }
  });

  it("is selected by kind in PersonaDocument", () => {
    const doc = PersonaDocument.parse({
      apiVersion: "donn/v0",
      kind: "PersonaOverlay",
    });
    expect(doc.kind).toBe("PersonaOverlay");
  });
});
