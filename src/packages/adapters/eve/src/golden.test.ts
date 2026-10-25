import type { AgentCompileOutput } from "@getdonn/adapter-sdk";
import { describe, expect, it } from "vitest";
import { goldenCases, goldenInput } from "./testing/golden-cases.js";
import adapter from "./index.js";

// One golden build per case, so any change to the adapter's output is a reviewable diff.
// Regenerate with `vitest run -u` after an intended change.

function render(output: AgentCompileOutput): string {
  const lines: string[] = [];
  const section = (title: string, body: string[]) => {
    if (body.length > 0) lines.push(title, ...body);
  };
  const files = Object.entries(output.files).sort(([a], [b]) =>
    a < b ? -1 : 1,
  );
  section(
    `files (${files.length})`,
    files.flatMap(([path, file]) =>
      "copyFrom" in file
        ? [`  ${path} <- copy ${file.copyFrom}`]
        : [
            `  ${path}`,
            ...file.content.split("\n").map((line) => `    ${line}`),
          ],
    ),
  );
  const secrets = Object.entries(output.secretEnv);
  section(
    `secretEnv (${secrets.length})`,
    secrets.map(([name, ref]) => `  ${name} = ${ref}`),
  );
  const env = Object.entries(output.env);
  section(
    `env (${env.length})`,
    env.map(([name, value]) => `  ${name}=${value}`),
  );
  const { entries } = output.report;
  section(
    `report (${entries.length})`,
    entries.map((e) => `  ${e.outcome}  ${e.path}  ${e.reason}`),
  );
  return `${lines.join("\n")}\n`;
}

describe("golden builds", () => {
  for (const c of goldenCases) {
    it(c.name, async () => {
      await expect(render(adapter.compile(goldenInput(c)))).toMatchFileSnapshot(
        `../test/golden/eve/${c.name}.txt`,
      );
    });
  }

  it("covers every case once", () => {
    expect(new Set(goldenCases.map((c) => c.name)).size).toBe(
      goldenCases.length,
    );
  });
});
