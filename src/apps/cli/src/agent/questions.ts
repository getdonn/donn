import { createInterface } from "node:readline/promises";
import { CliError } from "../errors.js";

// eve's setup questions (`eve add`'s headless protocol) as donn passes them on: eve's own wire
// shape, an answer as eve's `--answer key=<JSON>`, and a minimal terminal prompt per kind.
// See docs/planning/25-agent-runner.md §6 and docs/planning/26-gui.md (2026-10-25 amendment);
// the shapes are eve 0.83.2's `setup/setup-question-wire.ts`.

export const QUESTION_KINDS = [
  "confirm",
  "text",
  "environment",
  "select",
  "multi-select",
  "editable-select",
] as const;

export type QuestionKind = (typeof QUESTION_KINDS)[number];

export interface QuestionOption {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  disabledReason?: string;
  locked?: boolean;
  lockedReason?: string;
}

/** eve's question; a secret is `kind: "environment"` with the `variable` eve reads it from. */
export interface AgentQuestion {
  key: string;
  message: string;
  kind: QuestionKind;
  required: boolean;
  options?: QuestionOption[];
  /** confirm: a boolean; select: an option id; multi-select: option ids. */
  recommended?: unknown;
  placeholder?: string;
  variable?: string;
  /** editable-select: the option that takes a typed value, answered under its own key. */
  editable?: {
    key: string;
    optionId: string;
    label: string;
    recommended: string;
  };
  /** Set when eve refused the last answer. */
  issue?: { code: string; message: string };
}

/**
 * A question's key: `[a-z][a-z0-9-]*` parts, any case, joined by `.` (spec 25 §6's example key
 * is `github.app`). Nothing a flag parser or eve could read as more than a key.
 */
export const ANSWER_KEY = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/i;

/** `key=<value>` as eve's `[key, <JSON>]`; a value that is not JSON becomes a JSON string. */
export function parseAnswer(text: string): [string, string] {
  const at = text.indexOf("=");
  const key = at === -1 ? text : text.slice(0, at);
  if (at === -1 || !ANSWER_KEY.test(key)) {
    throw new CliError(
      "invalid-answer",
      "an answer is key=<JSON>, the key a question's: letters, digits and -, in .-separated parts",
      { fix: "--answer 'github-events=[\"pull_request\"]'" },
    );
  }
  const value = text.slice(at + 1);
  try {
    JSON.parse(value);
    return [key, value];
  } catch {
    return [key, JSON.stringify(value)];
  }
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const obj = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function option(value: unknown): QuestionOption | undefined {
  const o = obj(value);
  const id = str(o?.id);
  const label = str(o?.label);
  if (o === undefined || id === undefined || label === undefined)
    return undefined;
  return {
    id,
    label,
    ...(str(o.hint) !== undefined && { hint: str(o.hint)! }),
    ...(typeof o.disabled === "boolean" && { disabled: o.disabled }),
    ...(str(o.disabledReason) !== undefined && {
      disabledReason: str(o.disabledReason)!,
    }),
    ...(typeof o.locked === "boolean" && { locked: o.locked }),
    ...(str(o.lockedReason) !== undefined && {
      lockedReason: str(o.lockedReason)!,
    }),
  };
}

/** eve's wire question, keeping the fields donn knows; undefined when it is not one. */
export function readQuestion(
  value: unknown,
  issue?: unknown,
): AgentQuestion | undefined {
  const q = obj(value);
  const key = str(q?.key);
  const message = str(q?.message);
  const kind = str(q?.kind) as QuestionKind | undefined;
  if (
    q === undefined ||
    key === undefined ||
    message === undefined ||
    kind === undefined ||
    !QUESTION_KINDS.includes(kind)
  )
    return undefined;
  const options = Array.isArray(q.options)
    ? q.options.map(option).filter((o) => o !== undefined)
    : undefined;
  const editable = obj(q.editable);
  const problem = obj(issue);
  return {
    key,
    message,
    kind,
    required: q.required === true,
    ...(options && { options }),
    ...(q.recommended !== undefined && { recommended: q.recommended }),
    ...(str(q.placeholder) !== undefined && {
      placeholder: str(q.placeholder)!,
    }),
    ...(str(q.variable) !== undefined && { variable: str(q.variable)! }),
    ...(editable &&
      str(editable.key) !== undefined &&
      str(editable.optionId) !== undefined && {
        editable: {
          key: str(editable.key)!,
          optionId: str(editable.optionId)!,
          label: str(editable.label) ?? "",
          recommended: str(editable.recommended) ?? "",
        },
      }),
    ...(problem &&
      str(problem.message) !== undefined && {
        issue: {
          code: str(problem.code) ?? "invalid_answer",
          message: str(problem.message)!,
        },
      }),
  };
}

/** A line typed on the terminal; undefined when stdin is not one. */
export async function promptLine(prompt: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(prompt);
  } catch {
    return undefined;
  } finally {
    rl.close();
  }
}

export interface AskIo {
  stderr: { write(text: string): unknown };
  ask?: (prompt: string) => Promise<string | undefined>;
}

const TRIES = 5;

/** The option `token` names: its number in the list or its id; never a disabled one. */
function pick(options: QuestionOption[], token: string): string | undefined {
  const n = /^\d+$/.test(token) ? Number(token) : NaN;
  const found = Number.isInteger(n)
    ? options[n - 1]
    : options.find((o) => o.id === token);
  return found && !found.disabled ? found.id : undefined;
}

/**
 * Asks `question` on the terminal; its answers as eve's `[key, <JSON>]` pairs (two for an
 * editable-select's typed value). Undefined when there is no terminal, after five unreadable
 * answers, or for a secret (`environment`), which donn never asks: eve reads its variable.
 */
export async function askAnswers(
  io: AskIo,
  question: AgentQuestion,
): Promise<[string, string][] | undefined> {
  if (question.kind === "environment") return undefined;
  const ask = io.ask ?? promptLine;
  const options = question.options ?? [];
  const recommended = question.recommended;
  const lines = [question.message];
  if (question.issue) lines.push(`  ${question.issue.message}`);
  options.forEach((o, i) => {
    const marks = [
      o.hint,
      o.disabled
        ? `unavailable${o.disabledReason ? `: ${o.disabledReason}` : ""}`
        : undefined,
      (
        Array.isArray(recommended)
          ? recommended.includes(o.id)
          : recommended === o.id
      )
        ? "recommended"
        : undefined,
    ].filter(Boolean);
    lines.push(
      `  ${i + 1}) ${o.label}${marks.length ? ` (${marks.join("; ")})` : ""}`,
    );
  });
  io.stderr.write(`${lines.join("\n")}\n`);

  const read = async (
    prompt: string,
    parse: (line: string) => unknown,
  ): Promise<unknown> => {
    for (let i = 0; i < TRIES; i++) {
      const line = await ask(prompt);
      if (line === undefined) return undefined;
      const value = parse(line.trim());
      if (value !== undefined) return value;
      io.stderr.write("not an answer to this question; try again\n");
    }
    return undefined;
  };

  let value: unknown;
  switch (question.kind) {
    case "confirm": {
      const fallback =
        typeof recommended === "boolean" ? recommended : undefined;
      value = await read(fallback === true ? "[Y/n] " : "[y/N] ", (line) =>
        line === ""
          ? (fallback ?? false)
          : /^y(es)?$/i.test(line)
            ? true
            : /^no?$/i.test(line)
              ? false
              : undefined,
      );
      break;
    }
    case "text":
      value = await read(
        question.placeholder ? `(${question.placeholder}) > ` : "> ",
        (line) => (line === "" && question.required ? undefined : line),
      );
      break;
    case "select":
    case "editable-select":
      value = await read(`1-${options.length} or an id > `, (line) =>
        line === "" ? str(recommended) : pick(options, line),
      );
      break;
    case "multi-select":
      value = await read("numbers or ids, comma-separated > ", (line) => {
        if (line === "") {
          if (Array.isArray(recommended)) return recommended;
          return question.required ? undefined : [];
        }
        const ids = line.split(",").map((t) => pick(options, t.trim()));
        return ids.every((id) => id !== undefined) ? ids : undefined;
      });
      break;
  }
  if (value === undefined) return undefined;
  const answers: [string, string][] = [[question.key, JSON.stringify(value)]];
  const editable = question.editable;
  if (
    question.kind === "editable-select" &&
    editable &&
    value === editable.optionId
  ) {
    const typed = await read(
      `${editable.label} (${editable.recommended}) > `,
      (line) => (line === "" ? editable.recommended : line),
    );
    if (typed === undefined) return undefined;
    answers.push([editable.key, JSON.stringify(typed)]);
  }
  return answers;
}

/** One shell word: as is when nothing in it needs quoting, else single-quoted. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", "'\\''")}'`;
}
