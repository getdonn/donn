import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SwitchOutput } from "@getdonn/cli-schemas";
import { useState } from "react";
import { harnessesOf, SwitchReport } from "@/components/switch-report";
import { Badge } from "@/components/ui/badge";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useBridge, useProject, useRun } from "@/app/providers";
import { folderName } from "@/lib/projects";

// Screen 2, sessions and switching (docs/planning/26-gui.md §3): the live sessions per harness
// from `donn status --json` (refetched on the daemon's `session.*` events), and `donn switch`
// for the picked project with the spec 17 report in a dialog afterwards.

const STATE_LABEL: Record<string, string> = {
  current: "current",
  refreshed: "refreshed",
  stale: "restart for latest",
  "refresh-failed": "refresh failed",
};

function Sessions() {
  const status = useRun("status");
  if (status.isPending) return <Skeleton className="h-20 w-full" />;
  if (status.isError)
    return <p className="text-sm text-destructive">{status.error.message}</p>;
  const sessions = [...status.data.sessions].sort((a, b) =>
    a.harness.localeCompare(b.harness),
  );
  if (sessions.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No live sessions. Start one with <code>donn claude</code> or{" "}
        <code>donn codex</code>.
      </p>
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Harness</TableHead>
          <TableHead>Project</TableHead>
          <TableHead>Persona</TableHead>
          <TableHead>State</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sessions.map((session) => (
          <TableRow key={session.dir}>
            <TableCell className="font-medium">{session.harness}</TableCell>
            <TableCell title={session.project}>
              {session.project === undefined
                ? "-"
                : folderName(session.project)}
            </TableCell>
            <TableCell>
              {session.live ?? session.launched}
              {session.live !== undefined &&
                session.live !== session.launched && (
                  <span className="block text-xs text-muted-foreground">
                    launched with {session.launched}
                  </span>
                )}
            </TableCell>
            <TableCell>
              {"state" in session ? (
                <Badge
                  variant={
                    session.state === "refresh-failed"
                      ? "destructive"
                      : "secondary"
                  }
                >
                  {STATE_LABEL[session.state] ?? session.state}
                </Badge>
              ) : (
                <span className="text-muted-foreground">no daemon</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** `donn switch <persona>` (or `--clear`) for the picked project. */
function Switcher({ project }: { project: string }) {
  const bridge = useBridge();
  const queries = useQueryClient();
  const personas = useRun("list");
  const current = useRun("switch", [], project);
  const [chosen, setChosen] = useState<string>();
  const [done, setDone] = useState<{ title: string; result: SwitchOutput }>();
  const apply = useMutation({
    mutationFn: async (persona: string | undefined) => ({
      title:
        persona === undefined ? "Switch cleared" : `Switched to ${persona}`,
      result: await bridge.run(
        "switch",
        persona === undefined ? ["--clear"] : [persona],
        project,
      ),
    }),
    onSuccess: (outcome) => {
      setDone(outcome);
      void queries.invalidateQueries({ queryKey: ["run"] });
    },
  });
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Select value={chosen ?? ""} onValueChange={setChosen}>
          <SelectTrigger aria-label="Switch to" className="w-64">
            <SelectValue placeholder="Pick a persona" />
          </SelectTrigger>
          <SelectContent>
            {(personas.data?.personas ?? []).map(({ ref }) => (
              <SelectItem key={ref} value={ref}>
                {ref}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          disabled={chosen === undefined || apply.isPending}
          onClick={() => apply.mutate(chosen)}
        >
          Switch
        </Button>
        <Button
          variant="outline"
          disabled={apply.isPending}
          onClick={() => apply.mutate(undefined)}
        >
          Clear
        </Button>
        {current.data !== undefined &&
          "source" in current.data &&
          current.data.persona !== null && (
            <span className="text-sm text-muted-foreground">
              In use: <code>{current.data.persona}</code> ({current.data.source}
              )
            </span>
          )}
      </div>
      <Dialog
        open={done !== undefined}
        onOpenChange={(open) => {
          if (!open) setDone(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{done?.title}</DialogTitle>
            <DialogDescription>
              What each harness keeps and drops for {folderName(project)}.
            </DialogDescription>
          </DialogHeader>
          {done && <SwitchReport harnesses={harnessesOf(done.result)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function SessionsRoute() {
  const { project } = useProject();
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            Sessions
          </CardTitle>
          <CardDescription>
            Live sessions per harness, on this machine.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Sessions />
        </CardContent>
      </Card>
      {project !== undefined && (
        <Card>
          <CardHeader>
            <CardTitle>Switch persona</CardTitle>
            <CardDescription>
              For {folderName(project)}. Running sessions keep their persona
              until restarted or switched live.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Switcher key={project} project={project} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
