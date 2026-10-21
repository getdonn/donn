import { describe, expect, it } from "vitest";
import { jsonSchemas } from "./index.js";

describe("jsonSchemas", () => {
  it("emits draft 2020-12 schemas that forbid unknown top-level keys", () => {
    for (const schema of Object.values(jsonSchemas())) {
      expect(schema.$schema).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
      expect(schema.additionalProperties).toBe(false);
    }
  });
});
