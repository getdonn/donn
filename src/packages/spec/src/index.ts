import { z } from "zod";
import { ResolvedPersona } from "./ir.js";
import { Persona, PersonaOverlay } from "./persona.js";

export * from "./common.js";
export * from "./ir.js";
export * from "./path.js";
export * from "./persona.js";

/** JSON Schemas for editors, docs and non-TypeScript consumers. Input mode: what authors write. */
export function jsonSchemas() {
  return {
    persona: z.toJSONSchema(Persona, { io: "input" }),
    personaOverlay: z.toJSONSchema(PersonaOverlay, { io: "input" }),
    resolvedPersona: z.toJSONSchema(ResolvedPersona),
  };
}
