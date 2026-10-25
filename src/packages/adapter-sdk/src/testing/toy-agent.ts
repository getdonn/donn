import {
  annotateLocks,
  capabilityFields,
  type AgentAdapter,
  type AgentCompileInput,
  type AgentCompileOutput,
} from "../index.js";

// Test-only: a toy agent adapter that follows the contract. Not part of the build.

export const goodAgent: AgentAdapter = {
  apiVersion: 1,
  id: "toy-agent",
  irVersions: [0],
  frameworkRange: ">=1.2.3 <1.3.0",
  providerEnv: ["TOY_API_KEY"],
  capabilities: () => ({
    fields: Object.fromEntries(
      capabilityFields("toy-agent").map((field) => [
        field,
        field === "instructions"
          ? { support: "native" }
          : { support: "none", note: "toy expresses instructions only" },
      ]),
    ),
  }),
  templates: () => [
    { slug: "toy-template", title: "Toy", services: ["sandbox"] },
    { slug: "other-template", title: "Other", services: [] },
  ],
  compile(input: AgentCompileInput): AgentCompileOutput {
    return {
      files: {
        "agent/instructions/donn.md": { content: "Be concise." },
        "agent/skills/donn-notes": { copyFrom: "skills/notes" },
        "agent/connections/donn-db.ts": {
          content: `export default { description: "db", token: process.env.DONN_SECRET_0, key: process.env.TOY_API_KEY, mode: process.env["TOY_MODE"] };\n`,
        },
      },
      secretEnv: { DONN_SECRET_0: "secret://vault/k" },
      env: { TOY_MODE: "x" },
      report: annotateLocks(
        { adapter: "toy-agent", irVersion: input.ir.irVersion, entries: [] },
        input.ir,
      ),
      portability: [],
    };
  },
};
