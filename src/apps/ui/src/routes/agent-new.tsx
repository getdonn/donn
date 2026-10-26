import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentCreateOutput, AgentListOutput } from "@getdonn/cli-schemas";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ErrorText } from "@/components/error-text";
import { Review } from "@/components/agent-review";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { useBridge, useProject, useRun } from "@/app/providers";
import { jobOutput } from "@/lib/bridge";

// Screen 5, the agent builder (docs/planning/26-gui.md §3 item 5): template, persona, target,
// a review from `agent create --dry-run`, then `agent create` as a job. This is the app's one
// write to the persona, and it is the CLI's: `create` adds `agents.define.<name>`. The name is
// checked here only so the button says why it is off; the CLI is the authority.

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const validName = (name: string) => name.length <= 64 && NAME.test(name);

const TARGETS: { id: AgentTarget; label: string; hint: string }[] = [
  { id: "local", label: "Local", hint: "runs on this machine with eve" },
  {
    id: "self-host",
    label: "Self-host",
    hint: "builds a Dockerfile and env.json you run yourself",
  },
  { id: "vercel", label: "Vercel", hint: "deploys to your Vercel account" },
];

const STEPS = ["Template", "Persona", "Target", "Review"] as const;
type AgentTarget = AgentListOutput["agents"][number]["target"];
type Dry = Extract<AgentCreateOutput, { dryRun: true }>;

function createArgs(name: string, template: string, target: AgentTarget) {
  return [name, "--template", template, "--target", target];
}

function TemplateStep({
  template,
  setTemplate,
  name,
  setName,
}: {
  template: string;
  setTemplate(template: string): void;
  name: string;
  setName(name: string): void;
}) {
  const templates = useRun("agent templates");
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="agent-name">Agent name</Label>
        <Input
          id="agent-name"
          className="w-72"
          value={name}
          aria-invalid={name !== "" && !validName(name)}
          onChange={(event) => setName(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Lowercase letters, digits and hyphens, up to 64.
        </p>
      </div>
      {templates.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : templates.isError ? (
        <ErrorText error={templates.error} />
      ) : (
        <RadioGroup
          aria-label="Template"
          value={template}
          onValueChange={setTemplate}
        >
          {[
            ...templates.data.templates.filter((t) => t.slug === "blank"),
            ...templates.data.templates.filter((t) => t.slug !== "blank"),
          ].map((t) => {
            const id = `template-${t.slug}`;
            return (
              <div key={t.slug} className="flex items-start gap-2">
                <RadioGroupItem id={id} value={`eve:${t.slug}`} />
                <Label htmlFor={id} className="grid gap-0.5 font-normal">
                  <span className="flex flex-wrap items-center gap-2">
                    {t.slug === "blank" ? "Blank agent" : t.title}
                    {t.vercelOnly && (
                      <Badge variant="outline">Vercel-only</Badge>
                    )}
                    {t.inRepo && (
                      <Badge variant="secondary">in eve's repo</Badge>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    <code>eve:{t.slug}</code>
                    {t.services.length > 0 && ` uses ${t.services.join(", ")}`}
                  </span>
                </Label>
              </div>
            );
          })}
        </RadioGroup>
      )}
    </div>
  );
}

function TargetStep({
  name,
  target,
  setTarget,
}: {
  name: string;
  target: AgentTarget;
  setTarget(target: AgentTarget): void;
}) {
  return (
    <div className="grid gap-3">
      <RadioGroup
        aria-label="Target"
        value={target}
        onValueChange={(v) => setTarget(v as AgentTarget)}
      >
        {TARGETS.map((t) => (
          <div key={t.id} className="flex items-start gap-2">
            <RadioGroupItem id={`target-${t.id}`} value={t.id} />
            <Label
              htmlFor={`target-${t.id}`}
              className="grid gap-0.5 font-normal"
            >
              {t.label}
              <span className="text-xs text-muted-foreground">{t.hint}</span>
            </Label>
          </div>
        ))}
      </RadioGroup>
      {target === "self-host" && (
        <p data-testid="world-note" className="text-sm text-muted-foreground">
          The agent's workflow state is kept in a local folder. To use Postgres,
          set <code>agents.define.{name}.world</code> in the persona after
          creating it; <code>agent create</code> has no flag for it.
        </p>
      )}
    </div>
  );
}

function ReviewStep({
  project,
  name,
  template,
  target,
  accepted,
  setAccepted,
  onReady,
}: {
  project: string;
  name: string;
  template: string;
  target: AgentTarget;
  accepted: boolean;
  setAccepted(accepted: boolean): void;
  onReady(ready: boolean): void;
}) {
  const bridge = useBridge();
  // `--accept-portability` on the dry run only: it writes nothing, and without it a blocking
  // entry would stop the dry run before it printed the very report to review.
  const dry = useQuery({
    queryKey: ["dry-run", project, name, template, target],
    queryFn: () =>
      bridge.run(
        "agent create",
        [
          ...createArgs(name, template, target),
          "--dry-run",
          "--accept-portability",
        ],
        project,
      ),
    retry: false,
    gcTime: 0,
  });
  const out = dry.data as Dry | undefined;
  const blocking = out?.portability.some((p) => p.blocking) ?? false;
  useEffect(() => {
    onReady(out !== undefined && (!blocking || accepted));
  }, [out, blocking, accepted, onReady]);
  if (dry.isPending) return <Skeleton className="h-24 w-full" />;
  if (dry.isError || out === undefined) return <ErrorText error={dry.error} />;
  return (
    <div className="grid gap-4">
      <Review dry={out} name={name} target={target} />
      {blocking && (
        <div className="flex items-center gap-2">
          <Checkbox
            id="accept-portability"
            checked={accepted}
            onCheckedChange={(c) => setAccepted(c === true)}
          />
          <Label htmlFor="accept-portability">Accept portability</Label>
        </div>
      )}
    </div>
  );
}

export function AgentNewRoute() {
  const { project } = useProject();
  const bridge = useBridge();
  const queries = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("eve:blank");
  const [target, setTarget] = useState<AgentTarget>("local");
  const [accepted, setAccepted] = useState(false);
  const [ready, setReady] = useState(false);
  const [creating, setCreating] = useState(false);
  const [line, setLine] = useState<string>();
  const [error, setError] = useState<unknown>();

  const create = async () => {
    if (project === undefined) return;
    setCreating(true);
    setError(undefined);
    try {
      const job = await bridge.job(
        [
          "agent",
          "create",
          ...createArgs(name, template, target),
          ...(accepted ? ["--accept-portability"] : []),
        ],
        project,
      );
      job.on((event) => {
        if (event.type === "job.progress") setLine(event.line);
      });
      jobOutput("agent create", await job.done);
      void queries.invalidateQueries({ queryKey: ["run"] });
      void navigate(`/agents/${encodeURIComponent(name)}`);
    } catch (failure) {
      setError(failure);
      setCreating(false);
    }
  };

  const canNext = step === 0 ? validName(name) : step < 3;
  const last = step === STEPS.length - 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={1}>
          New agent
        </CardTitle>
        <CardDescription>
          {STEPS.map((s, i) => (i === step ? `${i + 1}. ${s}` : s)).join(" / ")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {project === undefined ? (
          <p className="text-sm text-muted-foreground">
            Pick a project to build an agent in.
          </p>
        ) : (
          <>
            {step === 0 && (
              <TemplateStep
                template={template}
                setTemplate={setTemplate}
                name={name}
                setName={setName}
              />
            )}
            {step === 1 && (
              <section aria-label="Persona" className="grid gap-1.5 text-sm">
                <p>
                  The agent is built on the persona of <code>{project}</code>:
                  its instructions, skills, MCP servers and models compile into
                  the agent's own files. The review shows what is kept and what
                  is dropped.
                </p>
                <p className="text-muted-foreground">
                  <code>agents.define.{name}</code> is added to this project's
                  persona when you create the agent.
                </p>
              </section>
            )}
            {step === 2 && (
              <TargetStep name={name} target={target} setTarget={setTarget} />
            )}
            {step === 3 && (
              <section aria-label="Review">
                <ReviewStep
                  project={project}
                  name={name}
                  template={template}
                  target={target}
                  accepted={accepted}
                  setAccepted={setAccepted}
                  onReady={setReady}
                />
              </section>
            )}
            {creating && (
              <p className="truncate text-sm text-muted-foreground">
                {line ?? "Creating…"}
              </p>
            )}
            <ErrorText error={error} />
            <div className="flex gap-2">
              {step === 0 ? (
                <Button variant="ghost" asChild>
                  <Link to="/agents">Cancel</Link>
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  disabled={creating}
                  onClick={() => setStep(step - 1)}
                >
                  Back
                </Button>
              )}
              {last ? (
                <Button
                  disabled={!ready || creating}
                  onClick={() => void create()}
                >
                  Create agent
                </Button>
              ) : (
                <Button disabled={!canNext} onClick={() => setStep(step + 1)}>
                  Next
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
