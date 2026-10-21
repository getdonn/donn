import { defineAdapter } from "@zzpersona/adapter-sdk";
import { capabilities } from "./capabilities.js";
import { detect } from "./detect.js";

// The Claude Code adapter. See docs/planning/05-adapter-sdk.md, section 5.

export default defineAdapter({
  id: "claude-code",
  irVersions: [0],
  capabilities,
  detect,
  compile: () => {
    throw new Error("compile: not implemented yet");
  },
  activate: () => {
    throw new Error("activate: not implemented yet");
  },
});
