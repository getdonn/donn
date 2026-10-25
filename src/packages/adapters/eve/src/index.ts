import { defineAgentAdapter } from "@getdonn/adapter-sdk";
import { capabilities } from "./capabilities.js";
import { compile } from "./compile.js";
import { TEMPLATES_AT, templates } from "./templates.js";

// The eve adapter: a persona as the files of an eve agent's own slots.
// See docs/planning/24-adapter-eve.md.

export { connectionName, skillName } from "./names.js";
export {
  createdAgentTs,
  patchAgentTs,
  type AgentTsResult,
} from "./agent-ts.js";
export { CHANNEL_FILE, ROUTE_AUTH_FILE, ROUTE_TOKEN_ENV } from "./channel.js";
export { COPY_PENDING, manifestFiles } from "./manifest.js";
export { TEMPLATES_AT };
export { portability } from "./portability.js";
export { EveCompileError, type EveErrorCode } from "./errors.js";

const adapter = defineAgentAdapter({
  id: "eve",
  irVersions: [0],
  frameworkRange: ">=0.83.2 <0.84.0",
  // Read by generated files although the agent does not set them: model provider keys, eve's
  // gateway key and a self-hosted world's connection variable.
  providerEnv: [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "AI_GATEWAY_API_KEY",
    "WORKFLOW_POSTGRES_URL",
    "DATABASE_URL",
  ],
  capabilities,
  templates,
  compile: (input) => compile(input, adapter),
});

export default adapter;
