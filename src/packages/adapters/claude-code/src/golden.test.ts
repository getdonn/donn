import { renderBuild, type Detection } from "@getdonn/adapter-sdk";
import { corpus } from "@getdonn/adapter-sdk/conformance";
import { describe, expect, it } from "vitest";
import adapter from "./index.js";

// One golden build per corpus entry and mode, so any change to the adapter's output is a
// reviewable diff. Regenerate with `vitest run -u` after an intended change.

const MODES: Record<string, Detection["facts"]> = {
  relaunch: {},
  partial: { sideloadBlocked: true },
  "relaunch-no-mcp": { managedMcp: true },
};

describe("golden builds", () => {
  for (const { name, personaId, ir, texts } of corpus) {
    for (const [mode, facts] of Object.entries(MODES)) {
      it(`${name} (${mode})`, async () => {
        const detection: Detection = {
          installed: true,
          version: "2.1.306",
          facts,
        };
        const output = adapter.compile({ personaId, ir, texts, detection });
        const plan = adapter.activate({
          ir,
          output,
          buildDir: "/BUILD",
          detection,
          cwd: "/PROJECT",
          passthrough: [],
        });
        await expect(renderBuild(output, plan)).toMatchFileSnapshot(
          `../test/golden/${name}.${mode}.txt`,
        );
      });
    }
  }
});
