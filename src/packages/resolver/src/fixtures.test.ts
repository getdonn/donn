import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Structural checks only: the fixtures must be well-formed before the resolver is written
// against them. Resolution itself is `it.todo` until `resolve()` exists. See fixtures/README.md.

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const LAYERS = new Set(["org", "area", "team", "project", "user"]);
const WARNING_CODES = new Set([
  "allow-shadowed-by-deny",
  "ask-shadowed-by-deny",
  "allow-shadowed-by-ask",
  "security-removal",
  "remove-unmatched",
  "overlay-lock-ignored",
]);
const ERROR_CODES = new Set([
  "missing-ref",
  "cycle",
  "linearization-conflict",
  "replace-target-missing",
  "lock-violation",
  "invalid-lock-path",
  "user-layer-lock",
]);

type Doc = Record<string, unknown>;

const readYaml = (path: string): Doc => parse(readFileSync(path, "utf8")) as Doc;

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
        expect(readYaml(refPath(spec.overlay as string)).kind).toBe("PersonaOverlay");
      }
      expect("resolved" in exp !== "error" in exp).toBe(true);
    });

    it("expects only known codes", () => {
      if ("error" in exp) {
        expect(ERROR_CODES).toContain((exp.error as Doc).code);
        return;
      }
      expect(Array.isArray(exp.warnings)).toBe(true);
      for (const w of exp.warnings as Doc[]) {
        expect(WARNING_CODES).toContain(w.code);
        expect(Object.keys(w).sort()).toEqual(["code", "layer", "path"]);
      }
    });

    it("has valid persona files whose extends refs exist", () => {
      const allowedMissing =
        "error" in exp && (exp.error as Doc).code === "missing-ref"
          ? (exp.error as Doc).ref
          : undefined;
      for (const file of personaFiles(root)) {
        const ref = relative(root, file).replace(/\.yaml$/, "");
        const doc = readYaml(file);
        expect(LAYERS, ref).toContain(ref.split("/")[0]);
        expect(doc.apiVersion, ref).toBe("zzpersona/v0");
        if (doc.kind === "PersonaOverlay") {
          for (const key of ["metadata", "extends", "locks"]) expect(doc, ref).not.toHaveProperty(key);
          continue;
        }
        expect(doc.kind, ref).toBe("Persona");
        expect(typeof (doc.metadata as Doc | undefined)?.name, ref).toBe("string");
        for (const parent of (doc.extends as string[] | undefined) ?? []) {
          if (parent !== allowedMissing) expect(existsSync(refPath(parent)), `${ref} → ${parent}`).toBe(true);
        }
      }
    });

    it.todo("resolves to the expected output");
  });
});
