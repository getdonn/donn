import { useState } from "react";
import { ErrorText } from "@/components/error-text";
import { FieldGroups } from "@/components/field-groups";
import { LayerStack } from "@/components/layer-stack";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { useProject, useRun } from "@/app/providers";
import { folderName, useProjects } from "@/lib/projects";

// Screen 1, projects and personas (docs/planning/26-gui.md §3): the projects the daemon knows,
// and for the picked one its persona: the layer stack, the resolved values by field group and
// "Explain" on each. Everything comes from `donn resolve --json`; the screen only presents it.

/** The sentinel for "the persona the project uses", the switcher's first option. */
const IN_USE = "in-use";

/** The picked project's persona: `resolve` (of the chosen persona, else the one in use). */
function PersonaOf({ project }: { project: string }) {
  const [chosen, setChosen] = useState(IN_USE);
  const personas = useRun("list");
  const resolved = useRun(
    "resolve",
    chosen === IN_USE ? ["--explain"] : ["--explain", chosen],
    project,
  );
  // Where each layer's file is: `list` reports the personas' and the user overlay's.
  const files: Record<string, string> = {
    ...Object.fromEntries(
      (personas.data?.personas ?? []).flatMap(({ ref, path }) =>
        path === undefined ? [] : [[ref, path]],
      ),
    ),
    ...(personas.data?.overlay && {
      [personas.data.overlay.ref]: personas.data.overlay.path,
    }),
  };
  const published = new Set(
    (personas.data?.personas ?? [])
      .filter(({ source }) => source === "registry")
      .map(({ ref }) => ref),
  );
  return (
    <div role="group" aria-label="Persona" className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={chosen} onValueChange={setChosen}>
          <SelectTrigger aria-label="Preview as" className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={IN_USE}>In use for this project</SelectItem>
            {(personas.data?.personas ?? []).map(({ ref }) => (
              <SelectItem key={ref} value={ref}>
                {ref}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {resolved.data !== undefined && (
          <span className="font-medium">{resolved.data.ir.metadata.name}</span>
        )}
      </div>
      {resolved.isPending && <Skeleton className="h-24 w-full" />}
      {resolved.isError && <ErrorText error={resolved.error} />}
      {resolved.data !== undefined && (
        <>
          <LayerStack
            layers={resolved.data.ir.layers}
            project={project}
            files={files}
            published={published}
          />
          {resolved.data.warnings.length > 0 && (
            <Alert>
              <AlertDescription>
                {resolved.data.warnings.map((warning) => (
                  <p key={`${warning.code}-${warning.path}`}>
                    {warning.code}: <code>{warning.path}</code> ({warning.layer}
                    )
                  </p>
                ))}
              </AlertDescription>
            </Alert>
          )}
          <FieldGroups result={resolved.data} />
        </>
      )}
    </div>
  );
}

export function PersonasRoute() {
  const projects = useProjects();
  const { project, pick } = useProject();
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            Projects
          </CardTitle>
          <CardDescription>
            Projects with a live session or a created agent, and the ones added
            here. Pick one in the header.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {projects.isPending ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead>Folder</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(projects.data ?? []).map((dir) => (
                  <TableRow
                    key={dir}
                    className="cursor-pointer"
                    onClick={() => pick(dir)}
                  >
                    <TableCell className="font-medium">
                      {folderName(dir)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{dir}</TableCell>
                    <TableCell>
                      {dir === project && <Badge>current</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {project !== undefined && (
        <Card>
          <CardHeader>
            <CardTitle>Persona</CardTitle>
            <CardDescription>
              The layers in merge order, then the resolved values. Explain says
              which layer set a value, what it overrode and what locks it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PersonaOf key={project} project={project} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
