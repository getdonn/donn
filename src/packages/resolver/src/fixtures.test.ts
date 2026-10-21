import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ERROR_CODES,
  LAYERS,
  PersonaDocument,
  HistoryEntry,
  Provenance,
  ResolvedPersona,
  ResolveWarning,
  type Ref,
} from "@zzpersona/spec";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { explain, ResolveError, resolve, type PersonaSource } from "./index.js";

// Each fixture is checked twice: that it is well-formed and agrees with @zzpersona/spec, then
// that resolve() produces exactly what it expects and explain() renders it as explain.txt.
// See fixtures/README.md.

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const IR_FIELDS = Object.keys(ResolvedPersona.shape);

type Doc = Record<string, unknown>;

const readYaml = (path: string): Doc =>
  parse(readFileSync(path, "utf8")) as Doc;

const personaFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? personaFiles(path) : [path];
  });

const cases = readdirSync(FIXTURES).filter((entry) =>
  statSync(join(FIXTURES, entry)).isDirectory(),
);

describe("resolver fixtures", () => {
  it("found cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  describe.each(cases)("%s", (name) => {
    const dir = join(FIXTURES, name);
    const root = join(dir, "personas");
    const refPath = (ref: string) => join(root, `${ref}.yaml`);
    const spec = readYaml(join(dir, "case.yaml"));
    const exp = spec.expect as Doc;

    it("is named NNN-kebab-case", () => {
      expect(name).toMatch(/^\d{3}-[a-z0-9]+(-[a-z0-9]+)*$/);
    });

    it("has a well-formed case.yaml", () => {
      expect(typeof spec.description).toBe("string");
      expect(typeof spec.resolve).toBe("string");
      expect(existsSync(refPath(spec.resolve as string))).toBe(true);
      if (spec.overlay !== undefined) {
        expect(readYaml(refPath(spec.overlay as string)).kind).toBe(
          "PersonaOverlay",
        );
      }
      expect("resolved" in exp !== "error" in exp).toBe(true);
    });

    it("expects output that matches the spec", () => {
      if ("error" in exp) {
        expect(ERROR_CODES).toContain((exp.error as Doc).code);
        return;
      }
      const resolved = exp.resolved as Doc;
      for (const [field, value] of Object.entries(resolved)) {
        expect(IR_FIELDS, field).toContain(field);
        const schema =
          ResolvedPersona.shape[field as keyof typeof ResolvedPersona.shape];
        expect(schema.safeParse(value).error, field).toBeUndefined();
      }
      if (Object.keys(resolved).length === IR_FIELDS.length) {
        expect(ResolvedPersona.safeParse(resolved).error).toBeUndefined();
      }
      if (exp.provenance !== undefined) {
        expect(Provenance.safeParse(exp.provenance).error).toBeUndefined();
      }
      for (const entry of (exp.history as Doc[] | undefined) ?? []) {
        expect(HistoryEntry.safeParse(entry).error).toBeUndefined();
      }
      expect(Array.isArray(exp.warnings)).toBe(true);
      for (const w of exp.warnings as Doc[]) {
        expect(ResolveWarning.safeParse(w).error).toBeUndefined();
        expect(Object.keys(w).sort()).toEqual(["code", "layer", "path"]);
      }
    });

    it("has persona files that match the spec and whose extends refs exist", () => {
      const allowedMissing =
        "error" in exp && (exp.error as Doc).code === "missing-ref"
          ? (exp.error as Doc).ref
          : undefined;
      for (const file of personaFiles(root)) {
        const ref = relative(root, file).replace(/\.yaml$/, "");
        expect(LAYERS, ref).toContain(ref.split("/")[0]);
        const parsed = PersonaDocument.safeParse(readYaml(file));
        expect(parsed.error, ref).toBeUndefined();
        if (parsed.data?.kind !== "Persona") continue;
        for (const parent of parsed.data.extends ?? []) {
          if (parent !== allowedMissing) {
            expect(existsSync(refPath(parent)), `${ref} → ${parent}`).toBe(
              true,
            );
          }
        }
      }
    });

    it("resolves to the expected output", async () => {
      const source: PersonaSource = {
        load: async (ref) =>
          existsSync(refPath(ref)) ? readYaml(refPath(ref)) : undefined,
      };
      const run = resolve(spec.resolve as Ref, {
        source,
        overlay: spec.overlay as Ref | undefined,
      });

      if ("error" in exp) {
        const error = await run.then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(ResolveError);
        expect((error as ResolveError).toJSON()).toMatchObject(
          exp.error as Doc,
        );
        return;
      }

      const result = await run;
      const { ir, provenance, warnings } = result;
      for (const [field, value] of Object.entries(exp.resolved as Doc)) {
        expect(ir[field as keyof typeof ir], field).toStrictEqual(value);
      }
      for (const [path, layer] of Object.entries(
        (exp.provenance as Doc | undefined) ?? {},
      )) {
        expect(provenance[path], path).toBe(layer);
      }
      const key = (w: Doc) =>
        `${w.code as string} ${w.path as string} ${w.layer as string}`;
      expect(warnings.map(key).sort()).toEqual(
        (exp.warnings as Doc[]).map(key).sort(),
      );
      if (exp.history !== undefined) {
        const change = (h: Doc) =>
          `${h.path as string} ${h.layer as string} ${h.kind as string} ${h.from as string}`;
        expect(result.history.map(change).sort()).toEqual(
          (exp.history as Doc[]).map(change).sort(),
        );
      }
      await expect(explain(result)).toMatchFileSnapshot(
        join(dir, "explain.txt"),
      );
    });
  });
});
