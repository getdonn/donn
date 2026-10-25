import { describe, expect, it } from "vitest";
import { jsonSchemas, ResolvedPersona } from "./index.js";

describe("jsonSchemas", () => {
  it("emits draft 2020-12 schemas that forbid unknown top-level keys", () => {
    for (const schema of Object.values(jsonSchemas())) {
      expect(schema.$schema).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
      expect(schema.additionalProperties).toBe(false);
    }
  });

  it("includes models in persona and overlay, agents in persona only", () => {
    const { persona, personaOverlay } = jsonSchemas();
    expect(persona.properties).toHaveProperty("models");
    expect(persona.properties).toHaveProperty("agents");
    expect(personaOverlay.properties).toHaveProperty("models");
    expect(personaOverlay.properties).not.toHaveProperty("agents");
  });
});

describe("ResolvedPersona", () => {
  it("defaults models and agents to empty", () => {
    const ir = ResolvedPersona.parse({
      irVersion: 0,
      layers: ["org/base"],
      metadata: { name: "base", labels: {} },
      instructions: [],
      skills: [],
      mcp: { servers: {} },
      permissions: { allow: [], deny: [], ask: [] },
      hooks: {},
      knowledge: [],
      secrets: { providers: {} },
      locks: [],
      targets: {},
    });
    expect(ir.models).toEqual({});
    expect(ir.agents).toEqual({});
  });
});
