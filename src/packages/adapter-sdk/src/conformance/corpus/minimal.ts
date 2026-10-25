import type { CorpusEntry } from "./index.js";

/** Resolver fixture 001: one persona, no parents, every other field empty. */
export const minimal: CorpusEntry = {
  name: "minimal",
  personaId: "team/solo",
  texts: {},
  ir: {
    irVersion: 0,
    layers: ["team/solo"],
    metadata: {
      name: "solo",
      description: "A persona with no parents",
      labels: {},
    },
    instructions: [{ id: "hello", inline: "Be concise." }],
    skills: [],
    mcp: { servers: {} },
    permissions: { allow: ["Read(./**)"], deny: [], ask: [] },
    hooks: {},
    knowledge: [],
    secrets: { providers: {} },
    locks: [],
    targets: {},
    policy: {},
    models: {},
    agents: {},
  },
};
