import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const gateway = createOpenAICompatible({
  name: "donn-gateway",
  baseURL: process.env.DONN_GATEWAY_URL ?? "http://127.0.0.1:4010/v1",
  apiKey: process.env.DONN_GATEWAY_KEY ?? "k",
  headers: { "x-donn": "1" },
  includeUsage: true,
});

export const model = gateway("some-model");
export const modelContextWindowTokens = 128000;
// Spike switch: SPIKE_PG=1 selects the postgres world (needs a database at start).
export const experimental = process.env.SPIKE_PG
  ? ({ workflow: { world: "@workflow/world-postgres" } } as const)
  : undefined;
