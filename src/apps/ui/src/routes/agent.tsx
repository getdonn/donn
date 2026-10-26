import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentBuildOutput,
  AgentDeployOutput,
  CommandName,
  CommandOutput,
} from "@getdonn/cli-schemas";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { AddConnection } from "@/components/agent-add";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { runKey, useBridge, useProject, useRun } from "@/app/providers";
import { CliFailure, jobOutput, type Bridge } from "@/lib/bridge";
import { useDaemonEvents, type DaemonEvent } from "@/lib/events";
import { currency, StateBadge, syncFailure, type AgentRow } from "./agents";

// Screen 5, the agent page (docs/planning/26-gui.md §3): run and stop (local, self-host), build
// (self-host: the Dockerfile and env.json as written, refs only), deploy (vercel: always a
// dialog first, from `deploy --dry-run`, then `deploy --yes`; §2 "Outward actions confirm in
// the UI"), sync, open the folder, add a channel or connection (components/agent-add.tsx), the
// log (`agent logs --json`, refetched on `agent.*` events and polled while it runs) and the
// agent's live events. Every failure is the CLI's own message and fix, shown inline. No secret
// value is ever asked for: `agent env --resolve` is never run.

/** `command args` as a job in `cwd`; its progress to `onLine`, its end as the command's output. */
async function runJob<C extends CommandName>(
  bridge: Bridge,
  command: C,
  args: string[],
  cwd: string,
  onLine?: (line: string) => void,
): Promise<CommandOutput<C>> {
  const job = await bridge.job([...command.split(" "), ...args], cwd);
  job.on((event) => {
    if (event.type === "job.progress") onLine?.(event.line);
  });
  return jobOutput(command, await job.done);
}

function FileView({
  title,
  path,
  text,
}: {
  title: string;
  path: string;
  text: string;
}) {
  const bridge = useBridge();
  const open = useMutation({
    meta: { quiet: true },
    mutationFn: () => bridge.open(path),
  });
  return (
    <section aria-label={title} className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <Button
          size="sm"
          variant="outline"
          disabled={open.isPending}
          onClick={() => open.mutate()}
        >
          Open
        </Button>
      </div>
      <ErrorText error={open.error} />
      <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">
        {text}
      </pre>
    </section>
  );
}

function Built({ out }: { out: AgentBuildOutput }) {
  return (
    <div className="grid gap-4">
      <FileView
        title="Dockerfile"
        path={out.dockerfile}
        text={out.contents.dockerfile}
      />
      <FileView
        title="env.json"
        path={out.envFile}
        text={out.contents.envFile}
      />
      <p className="text-sm text-muted-foreground">
        Sandbox images:{" "}
        {out.sandboxImages.length === 0
          ? "none (this agent opens no sandbox)"
          : out.sandboxImages.join(", ")}
      </p>
    </div>
  );
}

/** `agent deploy --dry-run`: what a deploy would do, shown before every deploy. */
type DeployPlan = Extract<AgentDeployOutput, { dryRun: true }>;

function deployed(name: string, out: AgentDeployOutput): string {
  if ("dryRun" in out) return `${name} was not deployed: a dry run`;
  return [
    `Deployed ${name}${out.url ? `: ${out.url}` : ""}`,
    out.pushed.length > 0 ? `set ${out.pushed.join(", ")}` : undefined,
    out.existing?.length
      ? `already set: ${out.existing.join(", ")}`
      : undefined,
  ]
    .filter(Boolean)
    .join("; ");
}

function Actions({ project, agent }: { project: string; agent: AgentRow }) {
  const bridge = useBridge();
  const queries = useQueryClient();
  const { name, target } = agent;
  const [line, setLine] = useState<string>();
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [built, setBuilt] = useState<AgentBuildOutput>();
  const [review, setReview] = useState<DeployPlan>();
  const refresh = () => queries.invalidateQueries({ queryKey: ["run"] });
  const quiet = {
    meta: { quiet: true },
    onMutate: () => {
      setError(undefined);
      setNote(undefined);
      setLine(undefined);
    },
    onError: setError,
    onSettled: () => {
      setLine(undefined);
      void refresh();
    },
  };

  const run = useMutation({
    ...quiet,
    mutationFn: () => runJob(bridge, "agent run", [name], project, setLine),
    onSuccess: (out) =>
      setNote(
        `${out.already ? "Already running" : "Running"} at ${out.agent.url}`,
      ),
  });
  const stop = useMutation({
    ...quiet,
    mutationFn: () => bridge.run("agent stop", [name], project),
    onSuccess: (out) =>
      setNote(
        [
          out.stopped ? `Stopped ${name}` : `${name} is not running`,
          out.leftovers
            ? `${out.leftovers} eve-sbx- sandbox containers still running`
            : undefined,
          out.exited
            ? `${out.exited} stopped eve-sbx- sandbox containers kept`
            : undefined,
        ]
          .filter(Boolean)
          .join("; "),
      ),
  });
  const build = useMutation({
    ...quiet,
    mutationFn: () => runJob(bridge, "agent build", [name], project, setLine),
    onSuccess: (out) => {
      setBuilt(out);
      setNote(`Built ${name}`);
    },
  });
  const sync = useMutation({
    ...quiet,
    mutationFn: () => bridge.run("agent sync", [name], project),
    onSuccess: (out) => {
      const changed = out.written.length + out.removed.length;
      setNote(
        changed === 0
          ? "Synced: nothing to write"
          : `Synced: wrote ${out.written.length}, removed ${out.removed.length}`,
      );
    },
  });
  // Every deploy confirms first (spec 26 §2): the dry run links, sets, resolves and deploys
  // nothing, and the dialog shows what it reports.
  const check = useMutation({
    ...quiet,
    mutationFn: async () => {
      const out = await bridge.run(
        "agent deploy",
        [name, "--dry-run"],
        project,
      );
      if (!("dryRun" in out)) throw new Error("deploy did not do a dry run");
      return out;
    },
    onSuccess: setReview,
  });
  const deploy = useMutation({
    ...quiet,
    mutationFn: () =>
      runJob(bridge, "agent deploy", [name, "--yes"], project, setLine),
    onMutate: () => {
      quiet.onMutate();
      setReview(undefined);
    },
    onSuccess: (out) => setNote(deployed(name, out)),
  });
  const open = useMutation({
    ...quiet,
    mutationFn: () => bridge.open(`${project}/${agent.path}`),
  });
  const busy = [run, stop, build, sync, check, deploy].some((m) => m.isPending);
  const runs = target === "local" || target === "self-host";

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        {runs && (
          <>
            <Button
              disabled={busy || agent.state === "running"}
              onClick={() => run.mutate()}
            >
              Run
            </Button>
            <Button
              variant="outline"
              disabled={busy || agent.state !== "running"}
              onClick={() => stop.mutate()}
            >
              Stop
            </Button>
          </>
        )}
        {target === "self-host" && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => build.mutate()}
          >
            Build
          </Button>
        )}
        {target === "vercel" && (
          <Button disabled={busy} onClick={() => check.mutate()}>
            Deploy…
          </Button>
        )}
        <Button variant="outline" disabled={busy} onClick={() => sync.mutate()}>
          Sync
        </Button>
        <Button variant="outline" onClick={() => open.mutate()}>
          Open folder
        </Button>
      </div>
      {target === "vercel" && (
        <p className="text-sm text-muted-foreground">
          A vercel agent runs on Vercel; to try it here, run{" "}
          <code>donn agent run {name} --dev</code> in a terminal.
        </p>
      )}
      {busy && line && (
        <p className="truncate text-sm text-muted-foreground">{line}</p>
      )}
      {note && (
        <p role="status" className="text-sm">
          {note}
        </p>
      )}
      <ErrorText error={error} />
      {built && <Built out={built} />}
      <Dialog
        open={review !== undefined}
        onOpenChange={(next) => {
          if (!next) setReview(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deploy {name} to Vercel?</DialogTitle>
            <DialogDescription>
              {review?.firstDeploy
                ? `It links ${name} to a new Vercel project${review.project ? ` (${review.project})` : ""} first, then runs eve deploy.`
                : `Linked${review?.project ? ` to ${review.project}` : ""}; it runs eve deploy.`}
            </DialogDescription>
          </DialogHeader>
          {review !== undefined &&
            (review.names.length > 0 ? (
              <div className="grid gap-2 text-sm">
                <p>
                  These variables are set in Vercel production, from the
                  persona's refs (their values never come to this page):
                </p>
                <ul aria-label="Variables" className="grid gap-1">
                  {review.names.map((variable) => (
                    <li key={variable}>
                      <code>{variable}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm">Nothing new to set in Vercel.</p>
            ))}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReview(undefined)}>
              Cancel
            </Button>
            <Button disabled={deploy.isPending} onClick={() => deploy.mutate()}>
              Deploy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** `donn agent logs --json`: none yet is not a failure, only a log not written. */
function Logs({ project, agent }: { project: string; agent: AgentRow }) {
  const bridge = useBridge();
  const logs = useQuery({
    queryKey: runKey("agent logs", [agent.name], project),
    queryFn: async () => {
      try {
        return await bridge.run("agent logs", [agent.name], project);
      } catch (error) {
        if (error instanceof CliFailure && error.code === "no-agent-log")
          return null;
        throw error;
      }
    },
    // `logs --follow` is a stream the bridge does not serve: polled while it runs.
    refetchInterval: agent.state === "running" ? 2_000 : false,
  });
  if (logs.isPending) return <Skeleton className="h-16 w-full" />;
  if (logs.isError) return <ErrorText error={logs.error} />;
  if (logs.data === null)
    return (
      <p className="text-sm text-muted-foreground">
        No log yet: the agent has not run through the daemon.
      </p>
    );
  return (
    <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">
      {logs.data.lines.slice(-200).join("\n")}
    </pre>
  );
}

const EVENT_DETAIL = (event: DaemonEvent) =>
  [event.url, event.code, event.message, event.exitCode]
    .filter((v) => typeof v === "string" || typeof v === "number")
    .join(" ");

/** The daemon's `agent.*` events for this agent, while the page is open. */
function AgentEvents({ project, name }: { project: string; name: string }) {
  const [seen, setSeen] = useState<Array<DaemonEvent & { at: string }>>([]);
  useDaemonEvents(
    (event) =>
      event.type.startsWith("agent.") &&
      event.name === name &&
      event.project === project,
    (event) =>
      setSeen((events) => [
        ...events.slice(-19),
        { ...event, at: new Date().toLocaleTimeString() },
      ]),
  );
  if (seen.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        None since this page opened.
      </p>
    );
  return (
    <ul className="grid gap-1 text-sm">
      {seen.map((event, i) => (
        <li key={i}>
          <span className="text-muted-foreground">{event.at}</span>{" "}
          <code>{event.type}</code> {EVENT_DETAIL(event)}
        </li>
      ))}
    </ul>
  );
}

function Agent({ project, name }: { project: string; name: string }) {
  const list = useRun("agent list", [], project);
  const status = useRun("status");
  if (list.isPending) return <Skeleton className="h-32 w-full" />;
  if (list.isError) return <ErrorText error={list.error} />;
  const agent = list.data.agents.find((a) => a.name === name);
  if (agent === undefined)
    return (
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            {name}
          </CardTitle>
          <CardDescription>
            The project's persona declares no agent {name}.{" "}
            <Link to="/agents" className="underline">
              All agents
            </Link>
          </CardDescription>
        </CardHeader>
      </Card>
    );
  const failed = syncFailure(status.data, project, name);
  const created = agent.state !== "available";
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle
            role="heading"
            aria-level={1}
            className="flex items-center gap-2"
          >
            {name}
            <StateBadge state={agent.state} />
          </CardTitle>
          <CardDescription>
            <code>{agent.template}</code>, target {agent.target}, in{" "}
            <code>{agent.path}</code>; persona {currency(agent)}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {agent.url !== undefined && (
            <p className="text-sm">
              Listening at{" "}
              <a
                href={agent.url}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {agent.url}
              </a>
            </p>
          )}
          {failed !== undefined && (
            <p role="alert" className="text-sm text-destructive">
              The daemon's last sync stopped: {failed}
            </p>
          )}
          {created ? (
            <Actions project={project} agent={agent} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Not created yet: <code>donn agent create {name}</code>.
            </p>
          )}
        </CardContent>
      </Card>
      {created && (
        <>
          <Card role="region" aria-label="Add a channel or connection">
            <CardHeader>
              <CardTitle>Add a channel or connection</CardTitle>
              <CardDescription>
                An eve registry item, such as <code>channel/github</code>; eve's
                questions are asked here.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AddConnection project={project} name={name} />
            </CardContent>
          </Card>
          <Card role="region" aria-label="Logs">
            <CardHeader>
              <CardTitle>Logs</CardTitle>
              <CardDescription>
                The daemon's run of {name}, newest last.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Logs project={project} agent={agent} />
            </CardContent>
          </Card>
          <Card role="region" aria-label="Events">
            <CardHeader>
              <CardTitle>Events</CardTitle>
              <CardDescription>
                What the daemon reports of {name}, live.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AgentEvents project={project} name={name} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

export function AgentRoute() {
  const { name = "" } = useParams();
  const { project } = useProject();
  if (project === undefined)
    return (
      <p className="text-sm text-muted-foreground">
        Pick a project to see its agents.
      </p>
    );
  return <Agent key={`${project}\0${name}`} project={project} name={name} />;
}
