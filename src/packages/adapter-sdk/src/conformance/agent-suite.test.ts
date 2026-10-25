import { goodAgent } from "../testing/toy-agent.js";
import { corpus } from "./corpus/index.js";
import { agentConformanceSuite } from "./suite.js";

// The vitest wrapper runs one test per check (and per case) against the good toy adapter.
agentConformanceSuite(goodAgent, [
  {
    name: "minimal",
    input: {
      personaId: "team/solo",
      ir: corpus[0]!.ir,
      agent: "reviewer",
      frameworkVersion: "1.2.3",
      texts: {},
      project: { hasSandbox: false, hasRouteAuth: false, existing: [] },
    },
  },
]);
