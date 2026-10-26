import { defineConfig, devices } from "@playwright/test";

// The app against the real CLI (docs/planning/26-gui.md §4): each worker starts a daemon on a
// temporary home with fixture personas and opens `donn ui` (e2e/fixtures.ts). Needs the built
// CLI with its dist/ui: `pnpm turbo run build --filter=@getdonn/cli` first.

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  reporter: process.env.CI !== undefined ? "github" : "list",
  timeout: 30_000,
  use: {
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
