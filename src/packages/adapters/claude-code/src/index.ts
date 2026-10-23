import { defineAdapter } from "@zzpersona/adapter-sdk";
import { activate } from "./activate.js";
import { capabilities } from "./capabilities.js";
import { compile } from "./compile.js";
import { detect } from "./detect.js";
import { compileManaged, managedInputs } from "./managed/compile.js";
import { KNOWN_MANAGED_KEYS } from "./managed/keys.js";
import { MANAGED_ROOTS } from "./managed/roots.js";

export { compileManaged, KNOWN_MANAGED_KEYS, managedInputs, MANAGED_ROOTS };

// The Claude Code adapter. See docs/planning/05-adapter-sdk.md, section 5.

const adapter = defineAdapter({
  id: "claude-code",
  irVersions: [0],
  capabilities,
  detect,
  compile: (input) => compile(input, adapter),
  activate,
  managed: {
    inputs: managedInputs,
    compile: compileManaged,
    roots: MANAGED_ROOTS,
  },
});

export default adapter;
