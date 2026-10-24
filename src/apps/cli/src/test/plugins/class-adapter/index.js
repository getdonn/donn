import {
  annotateLocks,
  assertIrVersion,
  defineAdapter,
  capabilityFields,
  requiredEntries,
} from "@getdonn/adapter-sdk";

// Test-only: a third-party adapter written as a class, as an outside author might. Its methods
// live on the prototype and use `this`.

class FakeAdapter {
  id = "fake";
  irVersions = [0];
  command = "fake";

  capabilities() {
    return {
      fields: Object.fromEntries(
        capabilityFields(this.id).map((field) => [
          field,
          field === "instructions"
            ? { support: "native" }
            : { support: "none", note: "fake expresses instructions only" },
        ]),
      ),
    };
  }

  async detect(probe) {
    const result = await probe.run(this.command, ["--version"]);
    return result.exitCode === 0
      ? { installed: true, version: result.stdout.trim(), facts: {} }
      : { installed: false, facts: {} };
  }

  compile(input) {
    assertIrVersion(this, input.ir);
    const prompt = input.ir.instructions
      .map((i) => ("file" in i ? input.texts[i.file] : i.inline))
      .join("\n\n");
    const entries = requiredEntries(this.id, this.capabilities(), input.ir);
    return {
      files: { "prompt.md": { content: prompt } },
      secretEnv: {},
      report: annotateLocks(
        { adapter: this.id, irVersion: input.ir.irVersion, entries },
        input.ir,
      ),
    };
  }

  activate({ buildDir }) {
    return {
      steps: [
        {
          kind: "launch",
          command: this.command,
          args: ["--prompt", `${buildDir}/prompt.md`],
          env: {},
        },
      ],
    };
  }
}

export default defineAdapter(new FakeAdapter());
