import { describe, expect, it } from "vitest";
import { PersonaDocument, type Persona } from "@zzpersona/spec";
import { bundleDigest, referencedPaths } from "./bundle.js";

const file = (path: string, text: string) => ({
  path,
  content: Buffer.from(text).toString("base64"),
});

describe("bundleDigest", () => {
  it("digest ignores file order", () => {
    const a = file("a.md", "a");
    const b = file("b.md", "b");
    expect(bundleDigest("x: 1", [a, b])).toBe(bundleDigest("x: 1", [b, a]));
    expect(bundleDigest("x: 1", [a, b])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("digest changes with any byte", () => {
    const base = bundleDigest("x: 1", [file("a.md", "a")]);
    expect(bundleDigest("x: 2", [file("a.md", "a")])).not.toBe(base);
    expect(bundleDigest("x: 1", [file("a.md", "b")])).not.toBe(base);
    expect(bundleDigest("x: 1", [file("c.md", "a")])).not.toBe(base);
  });
});

describe("referencedPaths", () => {
  it("referencedPaths lists instruction files, local skill folders and hook scripts", () => {
    const doc = PersonaDocument.parse({
      apiVersion: "zzpersona/v0",
      kind: "Persona",
      metadata: { name: "web" },
      instructions: [
        { id: "a", file: "./instructions/a.md" },
        { id: "b", inline: "text" },
      ],
      skills: {
        include: ["./skills/x", "registry://org/skills/pr-review@^2"],
      },
      hooks: {
        "session-start": [{ id: "h", run: "./hooks/h.sh" }],
        "pre-tool-use": [{ id: "inline", run: "echo hi" }],
      },
    }) as Persona;
    expect(referencedPaths(doc)).toEqual({
      files: ["instructions/a.md", "hooks/h.sh"],
      dirs: ["skills/x"],
    });
  });
});
