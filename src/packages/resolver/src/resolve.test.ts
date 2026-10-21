import type { Ref } from "@zzpersona/spec";
import { describe, expect, it } from "vitest";
import { ResolveError, resolve, type PersonaSource } from "./index.js";

// Paths the fixture suite cannot cover, because every fixture file must be a valid persona.

const persona = (name: string, extra: object = {}) => ({
  apiVersion: "zzpersona/v0",
  kind: "Persona",
  metadata: { name },
  ...extra,
});

const memory = (docs: Record<string, unknown>) => {
  const loads: Ref[] = [];
  const source: PersonaSource = {
    load: async (ref) => {
      loads.push(ref);
      return docs[ref];
    },
  };
  return { source, loads };
};

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => expect.fail("expected resolve() to throw"),
    (error: unknown) => (error as ResolveError).toJSON(),
  );

describe("resolve", () => {
  it("reports a file that fails the schema as invalid-persona, naming the layer", async () => {
    const { source } = memory({
      "org/base": persona("base", { permisions: {} }),
      "team/t": persona("t", { extends: ["org/base"] }),
    });
    const error = await failure(resolve("team/t", { source }));
    expect(error).toMatchObject({ code: "invalid-persona", layer: "org/base" });
    expect(String(error.issues)).toContain("permisions");
  });

  it("reports a missing target without a from", async () => {
    const { source } = memory({});
    expect(await failure(resolve("team/t", { source }))).toEqual({
      code: "missing-ref",
      ref: "team/t",
    });
  });

  it("rejects an overlay that is not a PersonaOverlay", async () => {
    const { source } = memory({
      "team/t": persona("t"),
      "user/overrides": persona("overrides"),
    });
    expect(
      await failure(resolve("team/t", { source, overlay: "user/overrides" })),
    ).toMatchObject({ code: "invalid-persona", layer: "user/overrides" });
  });

  it("rejects an overlay as an extends target", async () => {
    const { source } = memory({
      "team/t": persona("t", { extends: ["user/overrides"] }),
      "user/overrides": { apiVersion: "zzpersona/v0", kind: "PersonaOverlay" },
    });
    expect(await failure(resolve("team/t", { source }))).toMatchObject({
      code: "invalid-persona",
      layer: "user/overrides",
    });
  });

  it("loads a shared ancestor once", async () => {
    const { source, loads } = memory({
      "org/base": persona("base"),
      "area/a": persona("a", { extends: ["org/base"] }),
      "area/b": persona("b", { extends: ["org/base"] }),
      "team/t": persona("t", { extends: ["area/a", "area/b"] }),
    });
    await resolve("team/t", { source });
    expect(loads.filter((ref) => ref === "org/base")).toHaveLength(1);
  });
});
