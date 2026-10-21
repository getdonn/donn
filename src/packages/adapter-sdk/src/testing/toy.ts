import {
  annotateLocks,
  assertIrVersion,
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
  capabilities: () => ({ fields: { instructions: { support: "native" } } }),
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
    const entries = requiredEntries("toy", good.capabilities(), input.ir).map(
      (required) => ({
        ...required,
        reason: "toy expresses instructions only",
      }),
    );
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
