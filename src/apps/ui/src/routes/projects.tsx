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
import { folderName, useProjects } from "@/app/shell";

// Screen 1, projects and personas (docs/planning/26-gui.md §3). For now the projects the
// daemon knows and the picked one's persona with its layers (`donn resolve --json`); the full
// layer stack, the resolved values and explain come with the screen itself.

/** The picked project's persona: its name and its layers in merge order. */
function PersonaOf({ project }: { project: string }) {
  const resolved = useRun("resolve", [], project);
  if (resolved.isPending) return <Skeleton className="h-6 w-64" />;
  if (resolved.isError) {
    return <p className="text-sm text-destructive">{resolved.error.message}</p>;
  }
  const { metadata, layers } = resolved.data.ir;
  return (
    <div
      role="group"
      aria-label="Persona"
      className="flex flex-wrap items-center gap-2"
    >
      <span className="font-medium">{metadata.name}</span>
      {layers.map((layer) => (
        <Badge key={layer} variant="secondary" className="font-mono">
          {layer}
        </Badge>
      ))}
    </div>
  );
}

export function ProjectsRoute() {
  const projects = useProjects();
  const { project, pick } = useProject();
  return (
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
      <CardContent className="grid gap-4">
        {project !== undefined && <PersonaOf project={project} />}
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
  );
}
