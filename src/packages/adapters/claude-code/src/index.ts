import { defineAdapter } from "@zzpersona/adapter-sdk";
import { activate } from "./activate.js";
import { capabilities } from "./capabilities.js";
import { compile } from "./compile.js";
import { detect } from "./detect.js";

// The Claude Code adapter. See docs/planning/05-adapter-sdk.md, section 5.

const adapter = defineAdapter({
  id: "claude-code",
  irVersions: [0],
  capabilities,
  detect,
  compile: (input) => compile(input, adapter),
  activate,
});

export default adapter;
