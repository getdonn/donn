import { defineAdapter } from "@zzpersona/adapter-sdk";
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
  activate: () => {
    throw new Error("activate: not implemented yet");
  },
});

export default adapter;
