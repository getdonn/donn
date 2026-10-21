import claudeCode from "@zzpersona/adapter-claude-code";
import type { HarnessAdapter } from "@zzpersona/adapter-sdk";

/** First-party adapters by id. Loading third-party adapters from config is spec 07. */
export const HARNESSES: Record<string, HarnessAdapter> = {
  "claude-code": claudeCode,
};
