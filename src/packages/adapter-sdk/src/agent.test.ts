import { describe, expect, it } from "vitest";
import {
  AdapterDeclarationError,
  defineAgentAdapter,
  isSemverRange,
  type AgentAdapter,
} from "./index.js";
import { goodAgent } from "./testing/toy-agent.js";

const { apiVersion: _, ...declaration } = goodAgent;
const define = (overrides: Partial<AgentAdapter> = {}) =>
  defineAgentAdapter({ ...declaration, ...overrides });

describe("defineAgentAdapter", () => {
  it("stamps apiVersion 1 and keeps the declaration", () => {
    const adapter = define();
    expect(adapter.apiVersion).toBe(1);
    expect(adapter.frameworkRange).toBe(">=1.2.3 <1.3.0");
    expect(adapter.providerEnv).toEqual(["TOY_API_KEY"]);
    expect(adapter.templates()).toHaveLength(2);
  });

  it("keeps the methods of a class-based adapter", () => {
    class Toy {
      id = "toy-agent";
      irVersions = [0];
      frameworkRange = "^1.0.0";
      capabilities = () => goodAgent.capabilities();
      templates() {
        return [];
      }
      compile = goodAgent.compile;
    }
    expect(defineAgentAdapter(new Toy()).templates()).toEqual([]);
  });

  it("rejects a bad id", () => {
    expect(() => define({ id: "Bad_Id" })).toThrow(AdapterDeclarationError);
  });

  it("rejects no IR versions", () => {
    expect(() => define({ irVersions: [] })).toThrow(/IR version/);
  });

  it("rejects a missing fixed field", () => {
    const { skills: _missing, ...fields } = goodAgent.capabilities().fields;
    expect(() => define({ capabilities: () => ({ fields }) })).toThrow(
      /missing field skills/,
    );
  });

  it("rejects an unknown capability field", () => {
    expect(() =>
      define({
        capabilities: () => ({
          fields: {
            ...goodAgent.capabilities().fields,
            bogus: { support: "native" },
          } as never,
        }),
      }),
    ).toThrow(/unknown capability field "bogus"/);
  });

  it("rejects a non-native field without a note", () => {
    expect(() =>
      define({
        capabilities: () => ({
          fields: {
            ...goodAgent.capabilities().fields,
            skills: { support: "none" },
          },
        }),
      }),
    ).toThrow(/skills is none without a note/);
  });

  it.each([
    "",
    "latest",
    ">=0.83",
    "1.x",
    ">=0.83.2 <",
    "^a.b.c",
    "01.2.3",
    "1.2.3 || 2.0.0",
    "1.02.3",
  ])("rejects the range %j", (frameworkRange) => {
    expect(() => define({ frameworkRange })).toThrow(/semver range/);
  });
});

describe("isSemverRange", () => {
  it.each([
    ">=0.83.2 <0.84.0",
    "^1.2.3",
    "~1.2.3",
    "1.2.3",
    " >1.0.0  <=2.0.0 ",
  ])("accepts %j", (range) => expect(isSemverRange(range)).toBe(true));
});
