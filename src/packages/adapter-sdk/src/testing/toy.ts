import {
  annotateLocks,
  assertIrVersion,
  capabilityFields,
  requiredEntries,
  type CompileInput,
  type CompileOutput,
  type HarnessAdapter,
} from "../index.js";

// Test-only: a toy adapter that follows the contract. Not part of the build.

export const good: HarnessAdapter = {
  apiVersion: 1,
  id: "toy",
  irVersions: [0],
  capabilities: () => ({
    fields: Object.fromEntries(
      capabilityFields("toy").map((field) => [
        field,
        field === "instructions"
          ? { support: "native" }
          : { support: "none", note: "toy expresses instructions only" },
      ]),
    ),
  }),
  detect: async (probe) => {
    const result = await probe.run("toy", ["--version"]);
    return result.exitCode === 0
      ? { installed: true, version: result.stdout.trim(), facts: {} }
      : { installed: false, facts: {} };
  },
  compile(input: CompileInput): CompileOutput {
    assertIrVersion(good, input.ir);
    const prompt = input.ir.instructions
      .map((i) => ("file" in i ? input.texts[i.file] : i.inline))
      .join("\n\n");
    const entries = requiredEntries("toy", good.capabilities(), input.ir);
    return {
      files: { "prompt.md": { content: prompt } },
      secretEnv: {},
      report: annotateLocks(
        { adapter: "toy", irVersion: input.ir.irVersion, entries },
        input.ir,
      ),
    };
  },
  activate: ({ buildDir }) => ({
    steps: [
      {
        kind: "launch",
        command: "toy",
        args: ["--prompt", `${buildDir}/prompt.md`],
        env: {},
      },
    ],
  }),
};
