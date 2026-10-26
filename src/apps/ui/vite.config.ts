import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The app the daemon's bridge serves from the CLI's dist/ui (docs/planning/26-gui.md §4). The
// bridge's CSP allows only 'self': no inline scripts, no CDN, no fonts from elsewhere.

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    // One zod for the app and @getdonn/cli-schemas: its config (lib/jitless.ts) is global.
    dedupe: ["zod"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Inlined assets would be data: URLs; the CSP allows them for images only.
    assetsInlineLimit: 0,
    // Served from loopback, never over a network: one bundle is fine.
    chunkSizeWarningLimit: 1024,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
