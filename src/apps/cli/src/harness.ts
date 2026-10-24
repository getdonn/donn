import agentsMd from "@getdonn/adapter-agents-md";
import claudeCode from "@getdonn/adapter-claude-code";
import codex from "@getdonn/adapter-codex";
import type { HarnessAdapter } from "@getdonn/adapter-sdk";

/** First-party adapters by id. Third-party ones load from config: see plugins.ts. */
export const HARNESSES: Record<string, HarnessAdapter> = {
  "claude-code": claudeCode,
  "agents-md": agentsMd,
  codex,
};
