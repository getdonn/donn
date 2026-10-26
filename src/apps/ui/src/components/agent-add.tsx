import { useQueryClient } from "@tanstack/react-query";
import type { AgentAddOutput } from "@getdonn/cli-schemas";
import { useState } from "react";
import { AgentQuestionForm, type Answer } from "@/components/agent-question";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBridge } from "@/app/providers";
import { jobOutput, type JobHandle } from "@/lib/bridge";

// "Add a channel or connection" on the agent page (docs/planning/26-gui.md §3): `donn agent add
// <name> <item>` as a job, eve's questions answered in the page through the job's /answer (spec
// 25 §6), a secret question as the variable to set, a prerequisite with the CLI's fix.

type Asked = Extract<AgentAddOutput, { status: "needs-answer" }>;

type Step =
  | { at: "idle" }
  | { at: "running" }
  | { at: "question"; job: JobHandle; asked: Asked }
  | {
      at: "prerequisite";
      out: Extract<AgentAddOutput, { status: "needs-prerequisite" }>;
    }
  | { at: "completed"; out: Extract<AgentAddOutput, { status: "completed" }> }
  | { at: "failed"; error: unknown };

/** `donn agent add <name> <item>` as a job, eve's questions answered in the page. */
export function AddConnection({
  project,
  name,
}: {
  project: string;
  name: string;
}) {
  const bridge = useBridge();
  const queries = useQueryClient();
  const [item, setItem] = useState("");
  const [step, setStep] = useState<Step>({ at: "idle" });
  const [line, setLine] = useState<string>();

  const follow = async (start: () => Promise<JobHandle>) => {
    setStep({ at: "running" });
    setLine(undefined);
    try {
      const job = await start();
      job.on((event) => {
        if (event.type === "job.progress") setLine(event.line);
      });
      const out = jobOutput("agent add", await job.done, { accept: [0, 2] });
      if (out.status === "needs-answer")
        setStep({ at: "question", job, asked: out });
      else if (out.status === "needs-prerequisite")
        setStep({ at: "prerequisite", out });
      else setStep({ at: "completed", out });
    } catch (error) {
      setStep({ at: "failed", error });
    } finally {
      void queries.invalidateQueries({ queryKey: ["run"] });
    }
  };
  /** A continuation the CLI printed: a new job of it, in this project. */
  const again = (argv: string[]) => () => bridge.job(argv, project);

  const answer = (answers: Answer[]) => {
    if (step.at !== "question") return;
    const { job, asked } = step;
    const [first] = answers;
    if (first === undefined) return;
    // One answer goes through the job's /answer. An editable-select's typed value is a second
    // answer, which /answer cannot carry: both go on the continuation the CLI printed, as
    // `--answer=<key>=<JSON>` tokens (never a secret: those have no field).
    void follow(
      answers.length === 1
        ? () => job.answer(first.key, first.value)
        : again([
            ...asked.continue,
            ...answers.map(
              (a) => `--answer=${a.key}=${JSON.stringify(a.value)}`,
            ),
          ]),
    );
  };
  const running = step.at === "running";

  return (
    <div className="grid gap-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const wanted = item.trim();
          if (wanted !== "") void follow(again(["agent", "add", name, wanted]));
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="registry-item">Registry item</Label>
          <Input
            id="registry-item"
            className="w-72"
            placeholder="channel/github"
            value={item}
            disabled={running || step.at === "question"}
            onChange={(event) => setItem(event.target.value)}
          />
        </div>
        <Button
          type="submit"
          disabled={running || step.at === "question" || item.trim() === ""}
        >
          Add
        </Button>
        {(step.at === "question" || step.at === "prerequisite") && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setStep({ at: "idle" })}
          >
            Cancel
          </Button>
        )}
      </form>
      {running && (
        <p className="truncate text-sm text-muted-foreground">
          {line ?? "Running eve add…"}
        </p>
      )}
      {step.at === "question" && (
        <div className="grid gap-2">
          <AgentQuestionForm
            key={step.job.id}
            question={step.asked.question}
            onAnswer={answer}
          />
          {step.asked.question.kind === "environment" && (
            <div>
              <Button
                variant="outline"
                onClick={() => void follow(again(step.asked.continue))}
              >
                Try again
              </Button>
            </div>
          )}
        </div>
      )}
      {step.at === "prerequisite" && (
        <div className="grid gap-2 text-sm">
          <p>{step.out.prerequisite.message}</p>
          <p className="text-muted-foreground">{step.out.fix}</p>
          <div>
            <Button
              variant="outline"
              onClick={() => void follow(again(step.out.continue))}
            >
              Done, continue
            </Button>
          </div>
        </div>
      )}
      {step.at === "completed" && (
        <p role="status" className="text-sm">
          Added {step.out.item}
          {step.out.deploymentRequired &&
            `; deploy ${name} for it to take effect`}
        </p>
      )}
      {step.at === "failed" && <ErrorText error={step.error} />}
    </div>
  );
}
