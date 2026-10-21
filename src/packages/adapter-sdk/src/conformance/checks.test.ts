import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "../index.js";
import { good } from "../testing/toy.js";
import { runConformance, type CheckName } from "./index.js";

// The toy adapter that follows the contract (testing/toy.ts), and one broken variant per check. Each variant must
// fail exactly its own check: that is what proves each check catches what it claims to.

const failedChecks = async (adapter: HarnessAdapter) =>
  [
    ...new Set(
      (await runConformance(adapter))
        .filter((r) => !r.passed)
        .map((r) => r.name),
    ),
  ].sort();

const broken: [CheckName, HarnessAdapter][] = [
  ["declaration", { ...good, id: "Bad_Id" }],
  [
    "rejects-unsupported-ir",
    {
      ...good,
      compile: (input) =>
        good.compile({ ...input, ir: { ...input.ir, irVersion: 0 } }),
    },
  ],
  [
    "deterministic",
    {
      ...good,
      compile: (input) => {
        const output = good.compile(input);
        return {
          ...output,
          files: {
            ...output.files,
            "nonce.txt": { content: String(Math.random()) },
          },
        };
      },
    },
  ],
  [
    "well-formed-output",
    {
      ...good,
      compile: (input) => {
        const output = good.compile(input);
        return {
          ...output,
          files: { ...output.files, "../escape.md": { content: "x" } },
        };
      },
    },
  ],
  [
    "no-secret-leaks",
    {
      ...good,
      compile: (input) => {
        const output = good.compile(input);
        const leaked = JSON.stringify(input.ir.mcp.servers);
        return {
          ...output,
          files: { ...output.files, "servers.json": { content: leaked } },
        };
      },
    },
  ],
  [
    "no-silent-loss",
    {
      ...good,
      // Omits permission entries only: dropping secret entries too would also, rightly,
      // fail no-secret-leaks.
      compile: (input) => {
        const output = good.compile(input);
        const entries = output.report.entries.filter(
          (e) => !e.path.startsWith("permissions."),
        );
        return { ...output, report: { ...output.report, entries } };
      },
    },
  ],
  [
    "detect-not-installed",
    {
      ...good,
      detect: async () => {
        throw new Error("toy is not installed");
      },
    },
  ],
  [
    "no-writes",
    {
      ...good,
      compile: (input) => {
        writeFileSync("leak.txt", "written during compile");
        return good.compile(input);
      },
    },
  ],
];

describe("runConformance", () => {
  it("passes an adapter that follows the contract", async () => {
    const results = await runConformance(good);
    expect(results.filter((r) => !r.passed)).toEqual([]);
    expect(results.length).toBeGreaterThan(8);
  });

  it.each(broken)(
    "fails exactly %s for the adapter that breaks it",
    async (check, adapter) => {
      expect(await failedChecks(adapter)).toEqual([check]);
    },
  );

  it("restores the working directory", async () => {
    const before = process.cwd();
    await runConformance(broken.at(-1)![1]);
    expect(process.cwd()).toBe(before);
  });
});
