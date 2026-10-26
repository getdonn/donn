import type { AgentQuestion } from "@getdonn/cli-schemas";
import { useId, useState, type FormEvent } from "react";
import {
  answersOf,
  editing,
  initialValues,
  type Answer,
  type FieldValues,
} from "@/lib/answers";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

// One of eve's setup questions as a form (docs/planning/25-agent-runner.md §6, docs/planning/
// 26-gui.md §3): confirm a switch, text an input, select radios, multi-select checkboxes,
// editable-select a select with an input for its typed option. A secret (`environment`) has no
// field at all: eve reads it from its variable, which is shown to copy and set.

function Secret({ question }: { question: AgentQuestion }) {
  const variable = question.variable ?? "its variable";
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(variable);
      setCopied(true);
    } catch {
      // No clipboard here: the name is on the page to select.
    }
  };
  return (
    <div className="grid gap-2 text-sm">
      <div className="flex items-center gap-2">
        <code className="rounded bg-muted px-1.5 py-0.5">{variable}</code>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void copy()}
        >
          Copy
        </Button>
        {copied && <span className="text-muted-foreground">Copied</span>}
      </div>
      <p className="text-muted-foreground">
        A secret is never typed here: eve reads it from {variable}. Set it in
        the keychain provider, or in the environment the donn daemon runs in,
        then add the item again.
      </p>
    </div>
  );
}

const hint = (option: NonNullable<AgentQuestion["options"]>[number]) =>
  option.disabled
    ? `unavailable${option.disabledReason ? `: ${option.disabledReason}` : ""}`
    : option.locked
      ? (option.lockedReason ?? "locked")
      : option.hint;

export type { Answer };

export function AgentQuestionForm({
  question,
  onAnswer,
}: {
  question: AgentQuestion;
  onAnswer: (answers: Answer[]) => void;
}) {
  const id = useId();
  const [values, setValues] = useState(() => initialValues(question));
  const set = <K extends keyof FieldValues>(field: K, value: FieldValues[K]) =>
    setValues((now) => ({ ...now, [field]: value }));
  const answers = answersOf(question, values);
  const options = question.options ?? [];
  const legend = (
    <legend className="mb-2 text-sm font-medium">{question.message}</legend>
  );
  const issue = question.issue && (
    <p role="alert" className="text-sm text-destructive">
      {question.issue.message}
    </p>
  );
  if (question.kind === "environment") {
    return (
      <fieldset className="grid gap-2 rounded-md border p-3">
        {legend}
        {issue}
        <Secret question={question} />
      </fieldset>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (answers !== undefined) onAnswer(answers);
  };
  return (
    <form onSubmit={submit} className="grid gap-3">
      <fieldset className="grid gap-2 rounded-md border p-3">
        {legend}
        {issue}
        {question.kind === "confirm" && (
          <div className="flex items-center gap-2">
            <Switch
              id={`${id}-confirm`}
              checked={values.flag}
              onCheckedChange={(checked) => set("flag", checked)}
            />
            <Label htmlFor={`${id}-confirm`}>
              {values.flag ? "Yes" : "No"}
            </Label>
          </div>
        )}
        {question.kind === "text" && (
          <Input
            aria-label={question.message}
            placeholder={question.placeholder}
            value={values.text}
            required={question.required}
            onChange={(event) => set("text", event.target.value)}
          />
        )}
        {question.kind === "select" && (
          <RadioGroup
            value={values.choice}
            onValueChange={(choice) => set("choice", choice)}
          >
            {options.map((option) => (
              <div key={option.id} className="flex items-start gap-2">
                <RadioGroupItem
                  id={`${id}-${option.id}`}
                  value={option.id}
                  disabled={option.disabled === true || option.locked === true}
                />
                <Label htmlFor={`${id}-${option.id}`} className="grid gap-1">
                  {option.label}
                  {hint(option) && (
                    <span className="font-normal text-muted-foreground">
                      {hint(option)}
                    </span>
                  )}
                </Label>
              </div>
            ))}
          </RadioGroup>
        )}
        {question.kind === "multi-select" &&
          options.map((option) => (
            <div key={option.id} className="flex items-start gap-2">
              <Checkbox
                id={`${id}-${option.id}`}
                checked={values.chosen.includes(option.id)}
                disabled={option.disabled === true || option.locked === true}
                onCheckedChange={(checked) => {
                  const others = values.chosen.filter((i) => i !== option.id);
                  set(
                    "chosen",
                    checked === true ? [...others, option.id] : others,
                  );
                }}
              />
              <Label htmlFor={`${id}-${option.id}`} className="grid gap-1">
                {option.label}
                {hint(option) && (
                  <span className="font-normal text-muted-foreground">
                    {hint(option)}
                  </span>
                )}
              </Label>
            </div>
          ))}
        {question.kind === "editable-select" && (
          <div className="grid gap-2">
            <Select
              value={values.choice}
              onValueChange={(choice) => set("choice", choice)}
            >
              <SelectTrigger aria-label={question.message} className="w-72">
                <SelectValue placeholder="Pick one" />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem
                    key={option.id}
                    value={option.id}
                    disabled={option.disabled === true}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {editing(question, values) && (
              <Input
                aria-label={question.editable!.label}
                value={values.typed}
                onChange={(event) => set("typed", event.target.value)}
              />
            )}
          </div>
        )}
      </fieldset>
      <div>
        <Button type="submit" disabled={answers === undefined}>
          Continue
        </Button>
      </div>
    </form>
  );
}
