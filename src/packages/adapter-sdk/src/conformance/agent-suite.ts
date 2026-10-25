import { describe, expect, it } from "vitest";
import type { AgentAdapter } from "../agent.js";
import {
  AGENT_CHECK_NAMES,
  AGENT_PER_CASE_CHECKS,
  runAgentConformance,
  type AgentConformanceCase,
  type AgentConformanceResult,
} from "./agent.js";

// runAgentConformance() as vitest tests: one per check, and one per case for per-case checks.
// Exported from the ./conformance/vitest subpath, so teams on other runners never import vitest.

export function agentConformanceSuite(
  adapter: AgentAdapter,
  cases: readonly AgentConformanceCase[],
): void {
  describe(`agent conformance: ${adapter.id}`, () => {
    let results: AgentConformanceResult[] | undefined;
    const run = () => (results ??= runAgentConformance(adapter, cases));

    for (const name of AGENT_CHECK_NAMES) {
      const entries = AGENT_PER_CASE_CHECKS.includes(name)
        ? cases.map((c) => c.name)
        : [undefined];
      for (const entry of entries) {
        it(entry ? `${name} (${entry})` : name, () => {
          const result = run().find((r) => r.name === name && r.case === entry);
          expect(result, "check did not run").toBeDefined();
          expect(result!.reason ?? "").toBe("");
          expect(result!.passed).toBe(true);
        });
      }
    }
  });
}
