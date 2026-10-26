import type { AgentListOutput, StatusOutput } from "@getdonn/cli-schemas";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useProject, useRun } from "@/app/providers";

// Screen 5, the agents list (docs/planning/26-gui.md §3): the project persona's agents from
// `donn agent list --json` (state, target, current, running with its URL from the daemon), and
// the sync failures `donn status --json` records (spec 25 §3). Both refetch on the daemon's
// `agent.*` events (app/providers.tsx).

export type AgentRow = AgentListOutput["agents"][number];

/** The code the daemon's last sync of `name` in `project` stopped with, if it did. */
export function syncFailure(
  status: StatusOutput | undefined,
  project: string,
  name: string,
): string | undefined {
  return status?.agents.find((a) => a.project === project && a.name === name)
    ?.syncFailed;
}

/** "current", "out of date" or what needs a recreate; nothing before the agent exists. */
export function currency(agent: AgentRow): string {
  if (agent.state === "available") return "-";
  if (agent.recreate !== undefined)
    return `recreate needed (${agent.recreate})`;
  return agent.current ? "current" : "out of date";
}

export function StateBadge({ state }: { state: AgentRow["state"] }) {
  return (
    <Badge
      data-testid="agent-state"
      variant={
        state === "running"
          ? "default"
          : state === "available"
            ? "outline"
            : "secondary"
      }
    >
      {state}
    </Badge>
  );
}

function AgentTable({ project }: { project: string }) {
  const list = useRun("agent list", [], project);
  const status = useRun("status");
  if (list.isPending) return <Skeleton className="h-20 w-full" />;
  if (list.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        {list.error.message}
        {list.error.fix && (
          <span className="block text-muted-foreground">{list.error.fix}</span>
        )}
      </p>
    );
  if (list.data.agents.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        This project's persona declares no agents.
      </p>
    );
  return (
    <Table aria-label="Agents">
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead>Template</TableHead>
          <TableHead>Target</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Persona</TableHead>
          <TableHead>Last sync</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.data.agents.map((agent) => {
          const failed = syncFailure(status.data, project, agent.name);
          return (
            <TableRow key={agent.name}>
              <TableCell className="font-medium">
                <Link
                  to={`/agents/${encodeURIComponent(agent.name)}`}
                  className="underline-offset-4 hover:underline"
                >
                  {agent.name}
                </Link>
              </TableCell>
              <TableCell>
                <code>{agent.template}</code>
              </TableCell>
              <TableCell>{agent.target}</TableCell>
              <TableCell>
                <span className="flex flex-col gap-1">
                  <StateBadge state={agent.state} />
                  {agent.url !== undefined && (
                    <span className="text-xs text-muted-foreground">
                      {agent.url}
                    </span>
                  )}
                </span>
              </TableCell>
              <TableCell>{currency(agent)}</TableCell>
              <TableCell>
                {failed === undefined ? (
                  <span className="text-muted-foreground">-</span>
                ) : (
                  <Badge variant="destructive">failed: {failed}</Badge>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function AgentsRoute() {
  const { project } = useProject();
  return (
    <Card>
      <CardHeader>
        {project !== undefined && (
          <CardAction>
            <Button asChild>
              <Link to="/agents/new">New agent</Link>
            </Button>
          </CardAction>
        )}
        <CardTitle role="heading" aria-level={1}>
          Agents
        </CardTitle>
        <CardDescription>
          The agents the project's persona declares, and where each stands.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {project === undefined ? (
          <p className="text-sm text-muted-foreground">
            Pick a project to see its agents.
          </p>
        ) : (
          <AgentTable key={project} project={project} />
        )}
      </CardContent>
    </Card>
  );
}
