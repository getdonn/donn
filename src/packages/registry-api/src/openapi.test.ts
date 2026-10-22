import { describe, expect, it } from "vitest";
import { buildOpenApi } from "./openapi.js";
import { ROUTES } from "./routes.js";

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
});
