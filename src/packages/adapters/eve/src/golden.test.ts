import type {
  AgentCompileInput,
  AgentCompileOutput,
} from "@getdonn/adapter-sdk";
import { corpus } from "@getdonn/adapter-sdk/conformance";
import type { ResolvedPersona } from "@getdonn/spec";
import { describe, expect, it } from "vitest";
import adapter from "./index.js";

// One golden build per case, so any change to the adapter's output is a reviewable diff.
// Regenerate with `vitest run -u` after an intended change.

const base = corpus.find((c) => c.name === "minimal")!.ir;
const server = { url: "https://mcp.example.com/mcp" };
const skillMd = "---\nname: x\ndescription: A skill\n---\nBody\n";

interface Case {
  name: string;
  ir?: Partial<ResolvedPersona>;
  target?: "local" | "self-host" | "vercel";
  env?: Record<string, string>;
  model?: string;
  texts?: Record<string, string>;
  hasSandbox?: boolean;
}

const claude = { default: "anthropic/claude-sonnet-5" };

const cases: Case[] = [
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
];

function render(output: AgentCompileOutput): string {
  const lines: string[] = [];
  const section = (title: string, body: string[]) => {
    if (body.length > 0) lines.push(title, ...body);
  };
  const files = Object.entries(output.files).sort(([a], [b]) =>
    a < b ? -1 : 1,
  );
  section(
    `files (${files.length})`,
    files.flatMap(([path, file]) =>
      "copyFrom" in file
        ? [`  ${path} <- copy ${file.copyFrom}`]
        : [
            `  ${path}`,
            ...file.content.split("\n").map((line) => `    ${line}`),
          ],
    ),
  );
  const secrets = Object.entries(output.secretEnv);
  section(
    `secretEnv (${secrets.length})`,
    secrets.map(([name, ref]) => `  ${name} = ${ref}`),
  );
  const env = Object.entries(output.env);
  section(
    `env (${env.length})`,
    env.map(([name, value]) => `  ${name}=${value}`),
  );
  const { entries } = output.report;
  section(
    `report (${entries.length})`,
    entries.map((e) => `  ${e.outcome}  ${e.path}  ${e.reason}`),
  );
  return `${lines.join("\n")}\n`;
}

describe("golden builds", () => {
  for (const c of cases) {
    it(c.name, async () => {
      const input: AgentCompileInput = {
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
            },
          },
        },
        agent: "reviewer",
        frameworkVersion: "0.83.2",
        texts: c.texts ?? {},
        project: { hasSandbox: c.hasSandbox ?? false, existing: [] },
      };
      await expect(render(adapter.compile(input))).toMatchFileSnapshot(
        `../test/golden/eve/${c.name}.txt`,
      );
    });
  }

  it("covers every case once", () => {
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
  });
});
