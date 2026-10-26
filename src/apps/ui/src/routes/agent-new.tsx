import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentCreateOutput, AgentListOutput } from "@getdonn/cli-schemas";
import { useState } from "react";
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
import { CliFailure, jobOutput } from "@/lib/bridge";
import { fieldGroups } from "@/lib/explain";

// Screen 5, the agent builder (docs/planning/26-gui.md §3 item 5): template, persona, target,
// a review from `agent create --dry-run`, then `agent create` as a job. This is the app's one
// write to the persona, and it is the CLI's: `create` adds `agents.define.<name>`. The name is
// checked here only so the button says why it is off; the CLI is the authority.

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const validName = (name: string) => name.length <= 64 && NAME.test(name);

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

const PATH = "path";

function TemplateStep({
  template,
  setTemplate,
  pathTemplate,
  setPathTemplate,
  name,
  setName,
}: {
  template: string;
  setTemplate(template: string): void;
  pathTemplate: string;
  setPathTemplate(path: string): void;
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
          <div className="flex items-start gap-2">
            <RadioGroupItem id="template-path" value={PATH} />
            <Label htmlFor="template-path" className="grid gap-1.5 font-normal">
              Path template
              <span className="text-xs text-muted-foreground">
                A folder in the persona's store or the project's .donn, such as{" "}
                <code>./templates/kody</code>
              </span>
              {template === PATH && (
                <Input
                  aria-label="Template path"
                  className="w-72"
                  value={pathTemplate}
                  onChange={(event) => setPathTemplate(event.target.value)}
                />
              )}
            </Label>
          </div>
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

type Mark = Dry["report"]["entries"][number]["outcome"];

/** What the agent receives of the persona: names from `resolve`, marks from the dry run. */
function PersonaStep({
  project,
  name,
  dry,
}: {
  project: string;
  name: string;
  dry: Dry | undefined;
}) {
  const resolved = useRun("resolve", [], project);
  const marks = new Map<string, Mark>(
    (dry?.report.entries ?? []).map((e) => [e.path, e.outcome]),
  );
  const groups = resolved.data
    ? fieldGroups(resolved.data.ir).filter((g) =>
        ["instructions", "skills", "mcp"].includes(g.id),
      )
    : [];
  return (
    <section aria-label="Persona" className="grid gap-3 text-sm">
      <p>
        The agent is built on the persona of <code>{project}</code>.{" "}
        <code>agents.define.{name}</code> is added to it when you create the
        agent.
      </p>
      {resolved.isPending && <Skeleton className="h-16 w-full" />}
      {resolved.isError && <ErrorText error={resolved.error} />}
      {groups.map((g) => (
        <div key={g.id} className="grid gap-1">
          <h3 className="font-medium">{g.title}</h3>
          {g.items.length === 0 ? (
            <p className="text-muted-foreground">None.</p>
          ) : (
            <ul aria-label={g.title} className="grid gap-1">
              {g.items.map((item) => {
                const mark = marks.get(item.path);
                return (
                  <li key={item.path} className="flex items-center gap-2">
                    <code>{item.label}</code>
                    {mark !== undefined && mark !== "advisory" && (
                      <Badge
                        variant={
                          mark === "dropped" ? "destructive" : "secondary"
                        }
                      >
                        {mark}
                      </Badge>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}

type Entry = Dry["portability"][number];

export function AgentNewRoute() {
  const { project } = useProject();
  const bridge = useBridge();
  const queries = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [choice, setChoice] = useState("eve:blank");
  const [pathTemplate, setPathTemplate] = useState("");
  const [target, setTarget] = useState<AgentTarget>("local");
  const [accepted, setAccepted] = useState(false);
  /** Blocking entries a create stopped at (a template's own files are not in the dry run). */
  const [stopped, setStopped] = useState<Entry[]>();
  const [creating, setCreating] = useState(false);
  const [line, setLine] = useState<string>();
  const [error, setError] = useState<unknown>();

  const template = choice === PATH ? pathTemplate.trim() : choice;
  /** Any change to what is being built withdraws an acceptance given for the old one. */
  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setAccepted(false);
      setStopped(undefined);
      setError(undefined);
    };
  const go = (to: number) => {
    setAccepted(false);
    setError(undefined);
    setStep(to);
  };

  const wanted = project !== undefined && validName(name) && template !== "";
  // `--accept-portability` on the dry run only: it writes nothing, and without it a blocking
  // entry would stop the dry run before it printed the report to review.
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
    enabled: wanted && step >= 1,
    retry: false,
    gcTime: 0,
  });
  const out = dry.data as Dry | undefined;
  const blocking = [
    ...(out?.portability.filter((p) => p.blocking) ?? []),
    ...(stopped ?? []),
  ];
  const needsAccept = blocking.length > 0;

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
          ...(needsAccept && accepted ? ["--accept-portability"] : []),
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
      const entries =
        failure instanceof CliFailure &&
        failure.code === "portability-blocking" &&
        Array.isArray(failure.details.entries)
          ? (failure.details.entries as Entry[])
          : undefined;
      if (entries !== undefined) setStopped(entries);
      else setError(failure);
      setCreating(false);
    }
  };

  const last = step === STEPS.length - 1;
  const canCreate =
    out !== undefined && !creating && (!needsAccept || accepted);

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
                template={choice}
                setTemplate={edit(setChoice)}
                pathTemplate={pathTemplate}
                setPathTemplate={edit(setPathTemplate)}
                name={name}
                setName={edit(setName)}
              />
            )}
            {step === 1 && (
              <PersonaStep project={project} name={name} dry={out} />
            )}
            {step === 2 && (
              <TargetStep
                name={name}
                target={target}
                setTarget={edit(setTarget)}
              />
            )}
            {step === 3 && (
              <section aria-label="Review" className="grid gap-4">
                {dry.isPending && <Skeleton className="h-24 w-full" />}
                {dry.isError && <ErrorText error={dry.error} />}
                {out !== undefined && (
                  <Review dry={out} name={name} target={target} />
                )}
                {stopped !== undefined && (
                  <div role="alert" className="grid gap-1.5 text-sm">
                    <p className="text-destructive">
                      Creating stopped at what the template itself needs:
                    </p>
                    <ul aria-label="Blocking" className="grid gap-1.5">
                      {stopped.map((p) => (
                        <li
                          key={`${p.service}-${p.target}`}
                          className="flex gap-2"
                        >
                          <Badge variant="destructive">blocking</Badge>
                          <span>
                            <strong>{p.service}</strong> ({p.target}):{" "}
                            {p.instead}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {needsAccept && (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="accept-portability"
                      checked={accepted}
                      onCheckedChange={(c) => setAccepted(c === true)}
                    />
                    <Label htmlFor="accept-portability">
                      Accept portability
                    </Label>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Add channels or connections from the agent page.
                </p>
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
                  onClick={() => go(step - 1)}
                >
                  Back
                </Button>
              )}
              {last ? (
                <Button disabled={!canCreate} onClick={() => void create()}>
                  Create agent
                </Button>
              ) : (
                <Button
                  disabled={step === 0 && !wanted}
                  onClick={() => go(step + 1)}
                >
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
