import { defineAdapter } from "@getdonn/adapter-sdk";

// Test-only: an installed harness whose detect never settles.

export default defineAdapter({
  id: "hanging",
  irVersions: [0],
  capabilities: () => ({ fields: { instructions: { support: "native" } } }),
  detect: () => new Promise(() => {}),
  compile: () => {
    throw new Error("unreachable");
  },
  activate: () => ({ steps: [] }),
});
