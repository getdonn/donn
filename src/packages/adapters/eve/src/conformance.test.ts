import { corpus } from "@getdonn/adapter-sdk/conformance";
import { agentConformanceSuite } from "@getdonn/adapter-sdk/conformance/vitest";
import type { AgentConformanceCase } from "@getdonn/adapter-sdk/conformance";
import type { ResolvedPersona } from "@getdonn/spec";
import adapter from "./index.js";

// The shared agent conformance kit, over the SDK corpus personas with an agent added.
const agents: ResolvedPersona["agents"] = {
  reviewer: {
    template: "eve:blank",
    target: "local",
    path: "agents/reviewer",
    env: {},
  },
};

const cases: AgentConformanceCase[] = corpus.map(
  ({ name, personaId, ir, texts }) => ({
    name,
    input: {
      personaId,
      ir: { ...ir, agents },
      agent: "reviewer",
      frameworkVersion: "0.83.2",
      texts: {
        ...texts,
        "team/skills/local-skill/SKILL.md": "---\ndescription: A skill\n---\n",
        "team/skills/run-payment-sim/SKILL.md":
          "---\ndescription: A skill\n---\n",
      },
      project: { hasSandbox: false, existing: [] },
    },
  }),
);

agentConformanceSuite(adapter, cases);
