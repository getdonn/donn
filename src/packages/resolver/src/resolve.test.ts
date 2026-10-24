import type { Ref } from "@getdonn/spec";
import { describe, expect, it } from "vitest";
import { ResolveError, resolve, type PersonaSource } from "./index.js";

// Paths the fixture suite cannot cover, because every fixture file must be a valid persona.

const persona = (name: string, extra: object = {}) => ({
  apiVersion: "donn/v0",
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
      "user/overrides": { apiVersion: "donn/v0", kind: "PersonaOverlay" },
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
  it("a source's dir() places a layer's relative paths", async () => {
    const docs = {
      "org/a": persona("a", {
        instructions: [{ id: "x", file: "./instructions/x.md" }],
        hooks: {
          "pre-tool-use": [{ id: "h", run: "./hooks/h.sh" }],
        },
      }),
    };
    const plain = await resolve("org/a", { source: memory(docs).source });
    expect(plain.ir.instructions[0]).toMatchObject({
      file: "org/instructions/x.md",
    });
    const source: PersonaSource = {
      load: async (ref) => docs[ref as keyof typeof docs],
      dir: (ref) => `.registry/${ref}`,
    };
    const { ir } = await resolve("org/a", { source });
    expect(ir.instructions[0]).toMatchObject({
      file: ".registry/org/a/instructions/x.md",
    });
    expect(ir.hooks["pre-tool-use"]![0]!.run).toBe(
      ".registry/org/a/hooks/h.sh",
    );
  });

  describe("managed keys", () => {
    const managed = (value: unknown) => ({
      targets: { "claude-code": { managed: value } },
    });

    it("does not mutate documents, so a second resolve checks the same", async () => {
      const docs = {
        "org/base": persona("base", managed({ deniedModels: ["x"] })),
        "project/p": persona("p", { extends: ["org/base"], ...managed({}) }),
        "team/t": persona("t", { extends: ["org/base"] }),
      };
      const { source } = memory(docs);
      for (let i = 0; i < 2; i++) {
        const ok = await resolve("team/t", { source });
        expect(ok.ir.targets).toStrictEqual({
          "claude-code": { managed: { deniedModels: ["x"] } },
        });
        const error = await failure(resolve("project/p", { source }));
        expect(error).toMatchObject({
          code: "policy-in-lower-layer",
          layer: "project/p",
        });
      }
    });

    it("rejects a managed value that is not an object, naming layer and path", async () => {
      const { source } = memory({ "org/base": persona("base", managed("x")) });
      expect(await failure(resolve("org/base", { source }))).toMatchObject({
        code: "invalid-persona",
        layer: "org/base",
        path: "targets.claude-code.managed",
      });
    });
  });
});
