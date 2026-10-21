import { defineAdapter } from "@zzpersona/adapter-sdk";
import { activate } from "./activate.js";
import { capabilities } from "./capabilities.js";
import { compile } from "./compile.js";
import { detect } from "./detect.js";

// The agents-md adapter: the project persona as a marked block of the repo's AGENTS.md.
// See docs/planning/11-agents-md.md.

const adapter = defineAdapter({
  id: "agents-md",
  irVersions: [0],
  capabilities,
  detect,
  compile: (input) => compile(input, adapter),
  activate,
});

export default adapter;
