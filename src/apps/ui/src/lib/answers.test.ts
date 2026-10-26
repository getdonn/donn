import type { AgentQuestion } from "@getdonn/cli-schemas";
import { describe, expect, it } from "vitest";
import { answersOf, editing, initialValues } from "./answers";

// eve's questions as the agent page's fields fill them (docs/planning/25-agent-runner.md §6):
// each kind's value, eve's recommendation first, as the answers `--answer key=<JSON>` takes.

const ask = (question: Partial<AgentQuestion>): AgentQuestion => ({
  key: "q",
  message: "Which?",
  kind: "text",
  required: true,
  ...question,
});

const OPTIONS = [
  { id: "a", label: "A" },
  { id: "b", label: "B" },
  { id: "custom", label: "Other" },
];

describe("answersOf", () => {
  it("confirm: a boolean, eve's recommendation by default", () => {
    const q = ask({ kind: "confirm", recommended: true });
    expect(answersOf(q, initialValues(q))).toEqual([{ key: "q", value: true }]);
    expect(answersOf(q, { ...initialValues(q), flag: false })).toEqual([
      { key: "q", value: false },
    ]);
  });

  it("text: the string; none while a required one is empty", () => {
    const q = ask({ kind: "text" });
    expect(answersOf(q, initialValues(q))).toBeUndefined();
    expect(answersOf(q, { ...initialValues(q), text: "hi" })).toEqual([
      { key: "q", value: "hi" },
    ]);
    const optional = ask({ kind: "text", required: false });
    expect(answersOf(optional, initialValues(optional))).toEqual([
      { key: "q", value: "" },
    ]);
  });

  it("select: an option id, the recommended one by default", () => {
    const q = ask({ kind: "select", options: OPTIONS, recommended: "b" });
    expect(answersOf(q, initialValues(q))).toEqual([{ key: "q", value: "b" }]);
    const none = ask({ kind: "select", options: OPTIONS });
    expect(answersOf(none, initialValues(none))).toBeUndefined();
  });

  it("multi-select: option ids, the recommended ones by default", () => {
    const q = ask({
      kind: "multi-select",
      options: OPTIONS,
      recommended: ["a"],
    });
    expect(answersOf(q, initialValues(q))).toEqual([
      { key: "q", value: ["a"] },
    ]);
    expect(answersOf(q, { ...initialValues(q), chosen: [] })).toBeUndefined();
  });

  it("editable-select: the option, and the typed value under its own key when it is the editable one", () => {
    const q = ask({
      kind: "editable-select",
      options: OPTIONS,
      recommended: "a",
      editable: {
        key: "q.name",
        optionId: "custom",
        label: "Name",
        recommended: "donn-bot",
      },
    });
    const values = initialValues(q);
    expect(editing(q, values)).toBe(false);
    expect(answersOf(q, values)).toEqual([{ key: "q", value: "a" }]);
    const custom = { ...values, choice: "custom" };
    expect(editing(q, custom)).toBe(true);
    expect(answersOf(q, custom)).toEqual([
      { key: "q", value: "custom" },
      { key: "q.name", value: "donn-bot" },
    ]);
  });

  it("environment: never an answer", () => {
    const q = ask({ kind: "environment", variable: "SECRET" });
    expect(answersOf(q, { ...initialValues(q), text: "x" })).toBeUndefined();
  });
});
