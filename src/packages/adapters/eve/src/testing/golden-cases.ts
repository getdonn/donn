import type { AgentCompileInput } from "@getdonn/adapter-sdk";
import { corpus } from "@getdonn/adapter-sdk/conformance";
import type { ResolvedPersona } from "@getdonn/spec";

// The golden-build cases, as compile inputs: the golden test snapshots their output and the
// conformance test feeds them to the shared kit, so it sees secretEnv, auth.getToken, a written
// sandbox.ts and the gateway key too.

const base: ResolvedPersona = corpus.find((c) => c.name === "minimal")!.ir;
const server = { url: "https://mcp.example.com/mcp" };
const skillMd = "---\nname: x\ndescription: A skill\n---\nBody\n";

export interface GoldenCase {
  name: string;
  ir?: Partial<ResolvedPersona>;
  target?: "local" | "self-host" | "vercel";
  env?: Record<string, string>;
  model?: string;
  texts?: Record<string, string>;
  hasSandbox?: boolean;
  hasRouteAuth?: boolean;
  world?: "local" | "postgres";
}

const claude = { default: "anthropic/claude-sonnet-5" };

export const goldenCases: GoldenCase[] = [
  {
    name: "gateway-openai-compatible",
    ir: {
      instructions: [{ id: "role", inline: "Review pull requests." }],
      models: {
        gateway: {
          type: "openai-compatible",
          baseURL: "https://llm.corp/v1",
          apiKey: "secret://vault/llm/key",
          headers: { "x-team": "payments" },
        },
        default: "gpt-5",
      },
      targets: { eve: { contextWindow: 128000 } },
    },
  },
  {
    name: "gateway-anthropic",
    ir: {
      models: {
        gateway: {
          type: "anthropic",
          baseURL: "https://anthropic.corp",
          apiKey: "secret://vault/anthropic/key",
        },
        default: "anthropic/claude-sonnet-5",
      },
    },
  },
  {
    name: "gateway-vercel-ai",
    ir: {
      models: {
        gateway: { type: "vercel-ai-gateway", apiKey: "secret://vault/v/key" },
        default: "anthropic/claude-sonnet-5",
      },
    },
    target: "self-host",
  },
  { name: "direct-anthropic", ir: { models: claude } },
  { name: "direct-openai", ir: { models: { default: "openai/gpt-5" } } },
  {
    name: "agent-model-wins",
    ir: { models: claude },
    model: "openai/gpt-5-mini",
    env: { REGION: "eu", LOG_LEVEL: "info" },
  },
  {
    name: "servers-stdio-gateway-url",
    ir: {
      models: claude,
      mcp: {
        servers: {
          local_db: { command: "npx", args: ["-y", "db-mcp"] },
          corp: { ref: "gateway://corp/search" },
          docs: server,
        },
      },
    },
  },
  {
    name: "server-names-and-descriptions",
    ir: {
      models: claude,
      mcp: {
        servers: {
          my_db: server,
          "Search-API": {
            url: "https://search.example.com/sse",
            transport: "sse",
          },
          "bad.name": server,
        },
      },
      knowledge: [{ id: "db", source: "mcp://my_db" }],
      targets: {
        eve: {
          connections: { my_db: { description: "Query the orders database" } },
        },
      },
    },
  },
  {
    name: "headers-bearer-and-api-key",
    ir: {
      models: claude,
      mcp: {
        servers: {
          github: {
            url: "https://api.github.example/mcp",
            headers: {
              Authorization: "Bearer secret://vault/github/token",
              "X-GitHub-Api-Version": "2026-01-01",
            },
          },
          search: {
            url: "https://search.example.com/mcp",
            headers: { "X-Api-Key": "secret://vault/search/key" },
          },
        },
      },
    },
  },
  {
    name: "skills-with-scripts",
    ir: {
      models: claude,
      skills: [{ name: "run-sim", source: "team/skills/run-sim" }],
    },
    texts: {
      "team/skills/run-sim/SKILL.md": skillMd,
      "team/skills/run-sim/scripts/run.sh": "#!/bin/sh\n",
    },
  },
  {
    name: "knowledge-pointers",
    ir: {
      models: claude,
      instructions: [{ id: "role", inline: "Answer from the sources." }],
      knowledge: [
        { id: "wiki", source: "https://wiki.example.com" },
        { id: "docs", source: "mcp://docs" },
        { id: "gone", source: "mcp://missing" },
      ],
      mcp: { servers: { docs: server } },
    },
  },
  {
    name: "agent-env-secret-ref",
    ir: { models: claude },
    env: { REGION: "eu", API_TOKEN: "secret://vault/api/token" },
  },
  {
    name: "self-host-no-template-sandbox",
    ir: { models: claude },
    target: "self-host",
  },
  {
    name: "self-host-template-sandbox",
    ir: { models: claude },
    target: "self-host",
    hasSandbox: true,
  },
  {
    name: "self-host-postgres-world",
    ir: { models: claude },
    target: "self-host",
    world: "postgres",
  },
  {
    name: "local-template-route-auth",
    ir: { models: claude },
    hasRouteAuth: true,
  },
  { name: "vercel-no-channel", ir: { models: claude }, target: "vercel" },
];

export function goldenInput(c: GoldenCase): AgentCompileInput {
  return {
    personaId: "team/solo",
    ir: {
      ...base,
      ...c.ir,
      agents: {
        reviewer: {
          template: "eve:blank",
          target: c.target ?? "local",
          path: "agents/reviewer",
          env: c.env ?? {},
          ...(c.model && { model: c.model }),
          ...(c.world && { world: c.world }),
        },
      },
    },
    agent: "reviewer",
    frameworkVersion: "0.83.2",
    texts: c.texts ?? {},
    project: {
      hasSandbox: c.hasSandbox ?? false,
      hasRouteAuth: c.hasRouteAuth ?? false,
      existing: [],
    },
  };
}
