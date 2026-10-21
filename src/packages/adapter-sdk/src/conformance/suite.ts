import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "../types.js";
import {
  CHECK_NAMES,
  PER_ENTRY_CHECKS,
  runConformance,
  type CheckResult,
  type ConformanceOptions,
} from "./checks.js";
import { corpus } from "./corpus/index.js";

// runConformance() as vitest tests: one per check, and one per corpus entry for per-entry checks.
// A separate subpath (./conformance/vitest) so teams on other runners never import vitest.

export function conformanceSuite(
  adapter: HarnessAdapter,
  options: ConformanceOptions = {},
): void {
  describe(`conformance: ${adapter.id}`, () => {
    let results: Promise<CheckResult[]> | undefined;
    const run = () => (results ??= runConformance(adapter, options));

    for (const name of CHECK_NAMES) {
      const entries = PER_ENTRY_CHECKS.includes(name)
        ? corpus.map((entry) => entry.name)
        : [undefined];
      for (const entry of entries) {
        it(entry ? `${name} (${entry})` : name, async () => {
          const result = (await run()).find(
            (r) => r.name === name && r.corpusEntry === entry,
          );
          expect(result, "check did not run").toBeDefined();
          expect(result!.reason ?? "").toBe("");
          expect(result!.passed).toBe(true);
        });
      }
    }
  });
}
