import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentCompileOutput } from "../index.js";
import { goodAgent } from "../testing/toy-agent.js";
import { corpus } from "./corpus/index.js";
import {
  runAgentConformance,
  type AgentCheckName,
  type AgentConformanceCase,
} from "./agent.js";

// The toy agent adapter that follows the contract, and one broken variant per check. Each
// variant must fail exactly its own check.

const ir = {
  ...corpus[0]!.ir,
  targets: { "toy-agent": { token: "secret://vault/other" } },
};
const cases: AgentConformanceCase[] = [
  {
    name: "basic",
    input: {
      personaId: "team/solo",
      ir,
      agent: "reviewer",
      frameworkVersion: "1.2.3",
      texts: {},
      project: { hasSandbox: false, existing: [] },
    },
  },
];

const failedChecks = (adapter: AgentAdapter) =>
  [
    ...new Set(
      runAgentConformance(adapter, cases)
        .filter((r) => !r.passed)
        .map((r) => r.name),
    ),
  ].sort();

/** The good adapter, its output changed. */
const outputting = (
  change: (output: AgentCompileOutput) => Partial<AgentCompileOutput>,
): AgentAdapter => ({
  ...goodAgent,
  compile: (input) => {
    const output = goodAgent.compile(input);
    return { ...output, ...change(output) };
  },
});
const withFile = (path: string, content: string) =>
  outputting((o) => ({ files: { ...o.files, [path]: { content } } }));

let calls = 0;
const broken: [AgentCheckName, AgentAdapter][] = [
  [
    "complete-matrix",
    {
      ...goodAgent,
      capabilities: () => {
        const { skills: _missing, ...fields } = goodAgent.capabilities().fields;
        return { fields };
      },
    },
  ],
  [
    "complete-matrix",
    {
      ...goodAgent,
      capabilities: () => ({
        fields: {
          ...goodAgent.capabilities().fields,
          skills: { support: "none" },
        },
      }),
    },
  ],
  [
    "unique-templates",
    {
      ...goodAgent,
      templates: () => [
        { slug: "a", title: "A", services: [] },
        { slug: "a", title: "B", services: [] },
      ],
    },
  ],
  [
    "deterministic",
    {
      ...goodAgent,
      compile: (input) => {
        const output = goodAgent.compile(input);
        return { ...output, env: { TOY_MODE: String(calls++) } };
      },
    },
  ],
  ["no-secrets", withFile("agent/lib/donn/config.ts", "// secret://vault/k\n")],
  [
    "no-secrets",
    withFile("agent/lib/donn/config.ts", "// secret://vault/other\n"),
  ],
  ["paths-inside", withFile("agent/../escape.ts", "x")],
  ["paths-inside", withFile("/abs/file.ts", "x")],
  ["paths-inside", withFile("agent/lib/./donn/config.ts", "x")],
  [
    "paths-inside",
    outputting((o) => ({
      files: { ...o.files, "agent/skills/donn-x": { copyFrom: "../x" } },
    })),
  ],
  [
    "env-declared",
    withFile(
      "agent/lib/donn/config.ts",
      "export const k = process.env.NOT_DECLARED;\n",
    ),
  ],
  [
    "env-declared",
    withFile(
      "agent/lib/donn/config.ts",
      'export const k = process.env["NOPE"];\n',
    ),
  ],
  ["donn-names", withFile("agent/connections/db.ts", "description: 'x'")],
  ["donn-names", withFile("agent/connections/donn-DB.ts", "description: 'x'")],
  [
    "donn-names",
    withFile(`agent/connections/donn-${"a".repeat(60)}.ts`, "description: 'x'"),
  ],
  [
    "donn-names",
    outputting((o) => ({
      files: { ...o.files, "agent/skills/notes/SKILL.md": { content: "x" } },
    })),
  ],
  [
    "donn-names",
    outputting((o) => ({
      files: { ...o.files, "agent/skills/donn-bad name.md": { content: "x" } },
    })),
  ],
  ["paths-inside", withFile("lib/donn/config.ts", "x")],
  ["no-secrets", withFile("agent/lib/donn/config.ts", "// vault/k\n")],
  ["no-secrets", withFile("agent/lib/donn/config.ts", "// vault/other\n")],
  [
    "deterministic",
    {
      ...goodAgent,
      compile: (input) => {
        const output = goodAgent.compile(input);
        const [first, ...rest] = Object.entries(output.files);
        return {
          ...output,
          files: Object.fromEntries(
            calls++ % 2 ? [...rest, first!] : [first!, ...rest],
          ),
        };
      },
    },
  ],
  [
    "deterministic",
    {
      ...goodAgent,
      compile: (input) => {
        input.texts["leak"] = "x";
        return goodAgent.compile(input);
      },
    },
  ],
  ["donn-names", withFile("agent/connections/donn-.ts", "description: 'x'")],
  ["donn-names", withFile("agent/skills/donn-.md", "x")],
  [
    "connection-description",
    withFile(
      "agent/connections/donn-x.ts",
      'export default { description: "" };',
    ),
  ],
  [
    "connection-description",
    withFile(
      "agent/connections/donn-x.ts",
      "export default { description: '  ' };",
    ),
  ],
  ...[
    "const { X } = process.env;",
    "process.env?.X",
    "process.env[name]",
    "const e = process.env;",
  ].map((code): [AgentCheckName, AgentAdapter] => [
    "env-declared",
    withFile("agent/lib/donn/config.ts", code),
  ]),
  [
    "connection-description",
    withFile("agent/connections/donn-x.ts", "export {};"),
  ],
];

describe("agent conformance kit", () => {
  it("passes the good toy adapter on every check", () => {
    const results = runAgentConformance(goodAgent, cases);
    expect(results.filter((r) => !r.passed)).toEqual([]);
    expect(new Set(results.map((r) => r.name))).toEqual(
      new Set([
        "complete-matrix",
        "unique-templates",
        "deterministic",
        "no-secrets",
        "paths-inside",
        "env-declared",
        "donn-names",
        "connection-description",
      ]),
    );
  });

  it("reports a throwing compile on each per-case check", () => {
    const adapter = {
      ...goodAgent,
      compile: () => {
        throw new Error("boom");
      },
    };
    const failed = runAgentConformance(adapter, cases).filter((r) => !r.passed);
    expect(failed).toHaveLength(6);
    expect(failed[0]!.reason).toBe("threw: boom");
  });

  it.each(broken.map((b, i) => [`${b[0]} #${i}`, ...b] as const))(
    "%s fails exactly its own check",
    (_label, name, adapter) => {
      expect(failedChecks(adapter)).toEqual([name]);
    },
  );
});
