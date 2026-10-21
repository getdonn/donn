import { defineAdapter } from "@zzpersona/adapter-sdk";

// Test-only: a file harness whose overlay owns a whole file (no block).

export default defineAdapter({
  id: "whole-file",
  irVersions: [0],
  capabilities: () => ({ fields: { instructions: { support: "native" } } }),
  detect: async () => ({ installed: true, version: "n/a", facts: {} }),
  compile: (input) => ({
    files: {},
    secretEnv: {},
    report: {
      adapter: "whole-file",
      irVersion: input.ir.irVersion,
      entries: [],
    },
  }),
  activate: () => ({
    steps: [
      {
        kind: "overlay",
        path: ".github/copilot-instructions.md",
        content: "mine\n",
      },
    ],
  }),
});
