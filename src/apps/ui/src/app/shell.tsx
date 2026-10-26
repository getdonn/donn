import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BotIcon,
  ChevronsUpDownIcon,
  FolderGitIcon,
  LayersIcon,
  LibraryIcon,
  MonitorIcon,
  PlusIcon,
  TableIcon,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { NavLink, Outlet } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CliFailure } from "@/lib/bridge";
import { folderName, useProjects } from "@/lib/projects";
import { useBridge, useProject } from "./providers";

// The frame around every screen (docs/planning/26-gui.md §3): the five sections in a sidebar,
// the project picker in the header, toasts for failures.

const SECTIONS = [
  { to: "/projects", label: "Projects", icon: LayersIcon },
  { to: "/sessions", label: "Sessions", icon: MonitorIcon },
  { to: "/capabilities", label: "Capabilities", icon: TableIcon },
  { to: "/registry", label: "Registry", icon: LibraryIcon },
  { to: "/agents", label: "Agents", icon: BotIcon },
] as const;

function AddProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const bridge = useBridge();
  const queries = useQueryClient();
  const { pick } = useProject();
  const [path, setPath] = useState("");
  const add = useMutation({
    mutationFn: (dir: string) => bridge.addProject(dir),
    // Shown in the dialog instead of a toast.
    meta: { quiet: true },
    onSuccess: (added) => {
      queries.setQueryData(["projects"], added.projects);
      pick(added.path);
      setPath("");
      onOpenChange(false);
    },
  });
  const failure = add.error instanceof CliFailure ? add.error : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (path.trim() !== "") add.mutate(path.trim());
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) add.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add project</DialogTitle>
            <DialogDescription>
              The folder of a repository with a <code>.donn/persona.yaml</code>.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="project-path">Path</Label>
            <Input
              id="project-path"
              placeholder="/Users/you/code/checkout-api"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              autoFocus
              aria-invalid={failure !== undefined}
            />
            {failure && (
              <p role="alert" className="text-sm text-destructive">
                {failure.message}
                {failure.fix && (
                  <span className="block text-muted-foreground">
                    {failure.fix}
                  </span>
                )}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="submit"
              disabled={add.isPending || path.trim() === ""}
            >
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProjectPicker() {
  const projects = useProjects();
  const { project, pick } = useProject();
  const [adding, setAdding] = useState(false);
  const known = projects.data ?? [];

  // The first project known, when none is picked (or the picked one is gone).
  useEffect(() => {
    if (projects.data === undefined) return;
    if (project !== undefined && projects.data.includes(project)) return;
    pick(projects.data[0]);
  }, [projects.data, project, pick]);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="min-w-56 justify-between"
            aria-label="Project"
            title={project}
          >
            <span className="flex items-center gap-2 truncate">
              <FolderGitIcon />
              {project === undefined ? "No project" : folderName(project)}
            </span>
            <ChevronsUpDownIcon className="opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-72">
          <DropdownMenuLabel>Projects</DropdownMenuLabel>
          {known.length === 0 ? (
            <DropdownMenuItem disabled>None yet</DropdownMenuItem>
          ) : (
            <DropdownMenuRadioGroup
              value={project ?? ""}
              onValueChange={(value) => pick(value)}
            >
              {known.map((dir) => (
                <DropdownMenuRadioItem key={dir} value={dir} title={dir}>
                  <span className="flex flex-col">
                    <span>{folderName(dir)}</span>
                    <span className="text-xs text-muted-foreground">{dir}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setAdding(true)}>
            <PlusIcon />
            Add project…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AddProjectDialog open={adding} onOpenChange={setAdding} />
    </>
  );
}

export function Shell() {
  return (
    <TooltipProvider>
      <div className="flex h-svh bg-background text-foreground">
        <aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
          <div className="flex h-14 items-center gap-2 px-4 font-semibold">
            donn
            <Badge variant="outline">local</Badge>
          </div>
          <Separator />
          <nav aria-label="Sections" className="flex flex-col gap-1 p-2">
            {SECTIONS.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                    isActive
                      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60"
                  }`
                }
              >
                <Icon className="size-4" />
                {label}
              </NavLink>
            ))}
          </nav>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 items-center gap-4 border-b px-4">
            <ProjectPicker />
          </header>
          <ScrollArea className="min-h-0 flex-1">
            <main className="p-6">
              <Outlet />
            </main>
          </ScrollArea>
        </div>
      </div>
      <Toaster richColors />
    </TooltipProvider>
  );
}
