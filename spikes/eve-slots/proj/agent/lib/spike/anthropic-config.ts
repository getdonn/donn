import { createAnthropic } from "@ai-sdk/anthropic";

const gateway = createAnthropic({
  baseURL: process.env.DONN_GATEWAY_URL ?? "http://127.0.0.1:4010/v1",
  apiKey: process.env.DONN_GATEWAY_KEY ?? "k",
  headers: { "x-donn": "1" },
});

export const model = gateway("claude-sonnet-5");
export const modelContextWindowTokens = 200000;
