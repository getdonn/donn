import type { Ref, ResolvedPersona } from "@zzpersona/spec";
import fullIr from "./full.json" with { type: "json" };
import { kitchenSink } from "./kitchen-sink.js";
import { minimal } from "./minimal.js";

// Sample resolved personas every adapter is checked against. See
// docs/planning/05-adapter-sdk.md, section 3.

export interface CorpusEntry {
  name: "minimal" | "full" | "kitchen-sink";
  personaId: Ref;
  ir: ResolvedPersona;
  /** Text for every instruction `file`, as the CLI would supply it. */
  texts: Record<string, string>;
}

const full: CorpusEntry = {
  name: "full",
  personaId: "project/checkout-api",
  ir: fullIr as ResolvedPersona,
  texts: {
    "org/instructions/conduct.md":
      "Review code the way you would want yours reviewed.",
    "project/instructions/checkout-overview.md":
      "The checkout API settles card payments. Settlement code lives in src/settlement.",
  },
};

export const corpus: readonly CorpusEntry[] = [minimal, full, kitchenSink];
