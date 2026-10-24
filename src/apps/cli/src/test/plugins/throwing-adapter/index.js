import { defineAdapter } from "@getdonn/adapter-sdk";

// Test-only: an installed harness whose compile always fails.

export default defineAdapter({
  id: "throwing",
  irVersions: [0],
  capabilities: () => ({ fields: { instructions: { support: "native" } } }),
  detect: async () => ({ installed: true, version: "n/a", facts: {} }),
  compile: () => {
    throw new Error("boom");
  },
  activate: () => ({ steps: [] }),
});
