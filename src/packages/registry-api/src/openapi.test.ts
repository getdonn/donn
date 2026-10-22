import { describe, expect, it } from "vitest";
import { buildOpenApi } from "./openapi.js";
import { ROUTES } from "./routes.js";
import { PROBLEM_CODES } from "./schemas.js";

describe("buildOpenApi", () => {
  it("openapi.json is current", async () => {
    await expect(
      JSON.stringify(buildOpenApi(), null, 2) + "\n",
    ).toMatchFileSnapshot("../openapi.json");
  });

  it("every route is in the document with bearer security", () => {
    const doc = buildOpenApi() as {
      openapi: string;
      paths: Record<string, Record<string, { security: unknown }>>;
      components: { securitySchemes: { bearer: unknown } };
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.components.securitySchemes.bearer).toEqual({
      type: "http",
      scheme: "bearer",
    });
    for (const route of Object.values(ROUTES)) {
      const operation = doc.paths[route.path]?.[route.method.toLowerCase()];
      expect(operation?.security).toEqual(
        "auth" in route ? [] : [{ bearer: [] }],
      );
    }
  });

  it("documents every problem code and closes the response objects", () => {
    const doc = buildOpenApi() as {
      components: { schemas: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const { Problem, Whoami } = doc.components.schemas;
    expect(Problem.properties.problems.items.properties.code.enum).toEqual([
      ...PROBLEM_CODES,
    ]);
    expect(PROBLEM_CODES).toHaveLength(15);
    expect(Problem.properties.problems.items.additionalProperties).toBe(false);
    expect(Whoami.additionalProperties).toBe(false);
  });
});
