import type { CapabilitiesOutput, CompileOutput } from "@getdonn/cli-schemas";
import { Badge } from "@/components/ui/badge";
import {
  Card,
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
import { folderName } from "@/lib/projects";

// Screen 3, capabilities (docs/planning/26-gui.md §3): the matrix of spec 13 from
// `donn capabilities --detect --json` (every harness, with whether it is installed), and the
// picked project's compile report for each installed harness.

type Harness = CapabilitiesOutput["harnesses"][number];
type Support = Harness["fields"][string]["support"];

const SUPPORTS: Support[] = ["native", "approximated", "advisory", "none"];

const SUPPORT_VARIANT: Record<
  Support,
  "default" | "secondary" | "outline" | "destructive"
> = {
  native: "default",
  approximated: "secondary",
  advisory: "outline",
  none: "destructive",
};

function Summary({ harnesses }: { harnesses: Harness[] }) {
  return (
    <Table aria-label="Harnesses">
      <TableHeader>
        <TableRow>
          <TableHead>Harness</TableHead>
          <TableHead>Installed</TableHead>
          {SUPPORTS.map((support) => (
            <TableHead key={support}>{support}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {harnesses.map((harness) => (
          <TableRow key={harness.id}>
            <TableCell className="font-medium">{harness.id}</TableCell>
            <TableCell>
              {harness.detected?.installed ? (
                <Badge variant="secondary">
                  {harness.detected.version ?? "installed"}
                </Badge>
              ) : (
                <Badge variant="outline">not detected</Badge>
              )}
            </TableCell>
            {SUPPORTS.map((support) => (
              <TableCell key={support}>
                {
                  Object.values(harness.fields).filter(
                    (field) => field.support === support,
                  ).length
                }
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Matrix({ harnesses }: { harnesses: Harness[] }) {
  const fields = [
    ...new Set(harnesses.flatMap((harness) => Object.keys(harness.fields))),
  ];
  return (
    <Table aria-label="Fields by harness">
      <TableHeader>
        <TableRow>
          <TableHead>Field</TableHead>
          {harnesses.map((harness) => (
            <TableHead key={harness.id}>{harness.id}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {fields.map((field) => (
          <TableRow key={field}>
            <TableCell className="font-mono text-xs">{field}</TableCell>
            {harnesses.map((harness) => {
              const cell = harness.fields[field];
              const detail = [cell?.note, cell?.caveat].filter(Boolean);
              return (
                <TableCell key={harness.id}>
                  {cell === undefined ? (
                    "-"
                  ) : (
                    <Badge
                      variant={SUPPORT_VARIANT[cell.support]}
                      title={detail.join(" - ") || undefined}
                    >
                      {cell.support}
                    </Badge>
                  )}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Report({ harness, project }: { harness: string; project: string }) {
  const report = useRun("compile", ["--harness", harness], project);
  const entries: CompileOutput["report"]["entries"] =
    report.data?.report.entries ?? [];
  return (
    <section
      aria-label={`Compile report: ${harness}`}
      className="grid gap-2 rounded-md border p-3"
    >
      <h3 className="font-medium">{harness}</h3>
      {report.isPending && <Skeleton className="h-8 w-full" />}
      {report.isError && (
        <p className="text-sm text-destructive">{report.error.message}</p>
      )}
      {report.data && entries.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nothing dropped or approximated.
        </p>
      )}
      {entries.length > 0 && (
        <ul className="grid gap-1 text-sm">
          {entries.map((entry) => (
            <li key={`${entry.path}-${entry.outcome}`}>
              <Badge variant="outline">{entry.outcome}</Badge>{" "}
              <code>{entry.path}</code>
              <span className="block text-muted-foreground">
                {entry.reason}
                {entry.lock && ` (locked by ${entry.lock.layer})`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function CapabilitiesRoute() {
  const { project } = useProject();
  const capabilities = useRun("capabilities", ["--detect"]);
  const harnesses = capabilities.data?.harnesses ?? [];
  const installed = harnesses.filter((harness) => harness.detected?.installed);
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            Capabilities
          </CardTitle>
          <CardDescription>
            What each harness does with every persona field.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          {capabilities.isPending && <Skeleton className="h-24 w-full" />}
          {capabilities.isError && (
            <p className="text-sm text-destructive">
              {capabilities.error.message}
            </p>
          )}
          {capabilities.data && (
            <>
              <Summary harnesses={harnesses} />
              <Matrix harnesses={harnesses} />
            </>
          )}
        </CardContent>
      </Card>
      {project !== undefined && installed.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Compile reports</CardTitle>
            <CardDescription>
              What each installed harness drops or approximates for{" "}
              {folderName(project)}'s persona.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {installed.map((harness) => (
              <Report key={harness.id} harness={harness.id} project={project} />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
