import agentsMd from "@zzpersona/adapter-agents-md";
import claudeCode from "@zzpersona/adapter-claude-code";
import type { HarnessAdapter } from "@zzpersona/adapter-sdk";

/** First-party adapters by id. Third-party ones load from config: see plugins.ts. */
export const HARNESSES: Record<string, HarnessAdapter> = {
  "claude-code": claudeCode,
  "agents-md": agentsMd,
};
