import type { AgentQuestion } from "@getdonn/cli-schemas";

// What the fields of one of eve's setup questions answer (docs/planning/25-agent-runner.md §6,
// eve 0.83.2's wire shape): confirm a boolean, text a string, select an option id, multi-select
// option ids, editable-select an option id plus, for its editable option, the typed value under
// `editable.key`. A secret (`environment`) is never answered: eve reads its variable.

/** An answer as eve's `--answer key=<JSON>` takes it, before the JSON. */
export interface Answer {
  key: string;
  value: unknown;
}

/** The fields' values: one per kind, eve's recommendation first. */
export interface FieldValues {
  flag: boolean;
  text: string;
  choice: string;
  chosen: string[];
  typed: string;
}

export function initialValues(question: AgentQuestion): FieldValues {
  const { recommended } = question;
  return {
    flag: recommended === true,
    text: "",
    choice: typeof recommended === "string" ? recommended : "",
    chosen: Array.isArray(recommended) ? recommended : [],
    typed: question.editable?.recommended ?? "",
  };
}

/** Whether an editable-select has its editable option picked, so its value is typed. */
export function editing(question: AgentQuestion, values: FieldValues): boolean {
  return (
    question.kind === "editable-select" &&
    question.editable !== undefined &&
    values.choice === question.editable.optionId
  );
}

/** The answers the values make; undefined while a required one is missing, or for a secret. */
export function answersOf(
  question: AgentQuestion,
  values: FieldValues,
): Answer[] | undefined {
  const { key, required } = question;
  switch (question.kind) {
    case "confirm":
      return [{ key, value: values.flag }];
    case "text":
      if (required && values.text.trim() === "") return undefined;
      return [{ key, value: values.text }];
    case "select":
    case "editable-select": {
      if (values.choice === "") return undefined;
      const answers: Answer[] = [{ key, value: values.choice }];
      if (editing(question, values))
        answers.push({ key: question.editable!.key, value: values.typed });
      return answers;
    }
    case "multi-select":
      if (required && values.chosen.length === 0) return undefined;
      return [{ key, value: values.chosen }];
    case "environment":
      return undefined;
  }
}
