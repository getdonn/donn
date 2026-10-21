import { defineAdapter } from "@zzpersona/adapter-sdk";
import { activate } from "./activate.js";
import { capabilities } from "./capabilities.js";
import { compile } from "./compile.js";
import { detect } from "./detect.js";

// The Codex adapter: a persona as `-c` overrides on the `codex` command line.
// See docs/planning/12-codex.md.

const adapter = defineAdapter({
  id: "codex",
  irVersions: [0],
  capabilities,
  detect,
  compile: (input) => compile(input, adapter),
  activate,
});

export default adapter;
