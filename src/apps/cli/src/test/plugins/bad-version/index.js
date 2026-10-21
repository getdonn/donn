// Test-only: an adapter built for a future contract version.
export default {
  apiVersion: 2,
  id: "future",
  irVersions: [0],
  capabilities: () => ({ fields: {} }),
  detect: async () => ({ installed: false, facts: {} }),
  compile: () => ({
    files: {},
    secretEnv: {},
    report: { adapter: "future", irVersion: 0, entries: [] },
  }),
  activate: () => ({ steps: [] }),
};
