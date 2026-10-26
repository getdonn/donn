import { describe, expect, it } from "vitest";
import { blockingFirst, declaredEntry } from "./agent-review";

describe("declaredEntry", () => {
  const after =
    "agents:\n  define:\n    bot:\n      target: local\n    helper:\n      template: eve:blank\n      target: local\nmodels: {}\n";
  it("takes the entry's lines, up to the next key", () => {
    expect(declaredEntry(after, "helper")).toBe(
      "    helper:\n      template: eve:blank\n      target: local",
    );
  });
  it("ignores a same-named key outside agents.define, and escapes the name", () => {
    const text =
      "mcp:\n  servers:\n    helper:\n      url: x\nagents:\n  define:\n    other:\n      target: local\n";
    expect(declaredEntry(text, "helper")).toBeUndefined();
    expect(declaredEntry(text, "o.her")).toBeUndefined();
  });
  it("is undefined for an absent name", () => {
    expect(declaredEntry(after, "nope")).toBeUndefined();
  });
});

it("blockingFirst keeps each group's order", () => {
  expect(
    blockingFirst([
      { id: 1, blocking: false },
      { id: 2, blocking: true },
      { id: 3, blocking: false },
    ]).map((e) => e.id),
  ).toEqual([2, 1, 3]);
});
