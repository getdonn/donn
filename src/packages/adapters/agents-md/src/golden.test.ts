import { renderBuild, type Detection } from "@zzpersona/adapter-sdk";
import { corpus } from "@zzpersona/adapter-sdk/conformance";
import { describe, expect, it } from "vitest";
import adapter from "./index.js";

// One golden build per corpus entry, so any change to the block is a reviewable diff.
// Regenerate with `vitest run -u` after an intended change.

describe("golden builds", () => {
  for (const { name, personaId, ir, texts } of corpus) {
    it(name, async () => {
      const detection: Detection = {
        installed: true,
        version: "n/a",
        facts: {},
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
        `../test/golden/${name}.txt`,
      );
    });
  }
});
