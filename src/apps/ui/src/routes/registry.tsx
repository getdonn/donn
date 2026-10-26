import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PublishOutput } from "@getdonn/cli-schemas";
import { useEffect, useRef, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { CliFailure } from "@/lib/bridge";
import { folderName } from "@/lib/projects";

// Screen 4, the registry (docs/planning/26-gui.md §3): sign in through the browser (`donn login
// <url>` as a job, the daemon opens the browser), who you are and your roles (`whoami`), `pull`
// and `publish`. Publishing is an outward action: the `--dry-run` result is shown in a dialog
// and nothing is stored until it is confirmed (§2). `--force` is not offered.

function ErrorText({ error }: { error: unknown }) {
  if (error === undefined || error === null) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {error instanceof Error ? error.message : String(error)}
      {error instanceof CliFailure && error.fix && (
        <span className="block text-muted-foreground">{error.fix}</span>
      )}
    </p>
  );
}

/** The message of a failed job: the CLI's `{ error: { message } }` on stdout, else the exit. */
function jobFailure(done: { exitCode: number | null; stdout: string }) {
  try {
    const body = JSON.parse(done.stdout) as { error?: { message?: string } };
    if (typeof body.error?.message === "string") return body.error.message;
  } catch {
    // Not JSON: say what we know.
  }
  return `sign-in failed (exit ${done.exitCode ?? "cancelled"})`;
}

/** `donn login <url>` as a job: the link and code from its progress while it waits. */
function SignIn() {
  const bridge = useBridge();
  const queries = useQueryClient();
  const [url, setUrl] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = async () => {
    setError(undefined);
    setLines([]);
    setWaiting(true);
    try {
      const job = await bridge.job(["login", url.trim()]);
      job.on((event) => {
        if (event.type === "job.progress" && mounted.current)
          setLines((seen) => [...seen, event.line]);
      });
      const done = await job.done;
      if (!mounted.current) return;
      if (done.exitCode !== 0) setError(jobFailure(done));
      void queries.invalidateQueries({ queryKey: ["run"] });
    } catch (failure) {
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (mounted.current) setWaiting(false);
    }
  };

  // "Open <url> and confirm the code ABCD-EFGH": the CLI's own line, shown whole.
  const prompt = lines.find((line) => line.startsWith("Open "));
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">Not signed in.</p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="registry-url">Registry URL</Label>
          <Input
            id="registry-url"
            className="w-80"
            placeholder="https://registry.example.com"
            value={url}
            disabled={waiting}
            onChange={(event) => setUrl(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={waiting || url.trim() === ""}>
          Sign in
        </Button>
      </form>
      {waiting && (
        <div className="grid gap-1 text-sm" role="status">
          <span>Waiting for sign-in in your browser…</span>
          {prompt && <code className="break-all">{prompt}</code>}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function Roles({
  roles,
}: {
  roles: ReadonlyArray<{ role: string; path: string }>;
}) {
  if (roles.length === 0)
    return <p className="text-sm text-muted-foreground">No roles granted.</p>;
  return (
    <Table aria-label="Roles">
      <TableHeader>
        <TableRow>
          <TableHead>Role</TableHead>
          <TableHead>On</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {roles.map(({ role, path }) => (
          <TableRow key={`${role} ${path}`}>
            <TableCell className="font-medium">{role}</TableCell>
            <TableCell>
              <code>{path}</code>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Pull() {
  const bridge = useBridge();
  const queries = useQueryClient();
  const [changes, setChanges] =
    useState<Array<{ ref: string; from?: number; to?: number }>>();
  const pull = useMutation({
    meta: { quiet: true },
    mutationFn: async () => {
      const job = await bridge.job(["pull"]);
      const done = await job.done;
      if (done.exitCode !== 0) throw new Error(jobFailure(done));
      return (JSON.parse(done.stdout) as { changes: typeof changes }).changes;
    },
    onSuccess: (result) => {
      setChanges(result);
      void queries.invalidateQueries({ queryKey: ["run"] });
    },
  });
  return (
    <div className="grid gap-3">
      <div>
        <Button
          variant="outline"
          disabled={pull.isPending}
          onClick={() => pull.mutate()}
        >
          {pull.isPending ? "Pulling…" : "Pull"}
        </Button>
      </div>
      <ErrorText error={pull.error ?? undefined} />
      {changes !== undefined &&
        (changes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Up to date.</p>
        ) : (
          <ul aria-label="Pulled" className="grid gap-1 text-sm">
            {changes.map(({ ref, from, to }) => (
              <li key={ref}>
                <code>{ref}</code>{" "}
                {to === undefined
                  ? "removed"
                  : from === undefined
                    ? `new @${to}`
                    : `${from} → ${to}`}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

type DryRun = Extract<PublishOutput, { dryRun: true }>;

const SIGN = { added: "+", removed: "-", changed: "~" } as const;

/** Publishes one of the local layers, after showing what `--dry-run` reports. */
function Publish({ project }: { project: string }) {
  const bridge = useBridge();
  const queries = useQueryClient();
  const layers = useRun("list");
  const [ref, setRef] = useState<string>();
  const [review, setReview] = useState<DryRun>();
  const [published, setPublished] = useState<string>();
  const dryRun = useMutation({
    meta: { quiet: true },
    mutationFn: async (target: string) => {
      const out = await bridge.run("publish", [target, "--dry-run"], project);
      if (!("dryRun" in out)) throw new Error("publish did not do a dry run");
      return out;
    },
    onMutate: () => setPublished(undefined),
    onSuccess: setReview,
  });
  const publish = useMutation({
    meta: { quiet: true },
    mutationFn: (target: string) => bridge.run("publish", [target], project),
    onSuccess: (out) => {
      setReview(undefined);
      setPublished(
        "unchanged" in out
          ? `${out.ref} is unchanged @${out.version}`
          : `Published ${out.ref} @${"version" in out ? out.version : ""}`,
      );
      void queries.invalidateQueries({ queryKey: ["run"] });
    },
  });
  const local = (layers.data?.personas ?? []).filter(
    (p) => p.source === "local",
  );
  const close = () => {
    setReview(undefined);
    publish.reset();
  };
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={ref ?? ""} onValueChange={setRef}>
          <SelectTrigger aria-label="Layer to publish" className="w-64">
            <SelectValue placeholder="Pick a layer" />
          </SelectTrigger>
          <SelectContent>
            {local.map((p) => (
              <SelectItem key={p.ref} value={p.ref}>
                {p.ref}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          disabled={ref === undefined || dryRun.isPending}
          onClick={() => ref !== undefined && dryRun.mutate(ref)}
        >
          Review publish
        </Button>
      </div>
      <ErrorText error={dryRun.error ?? undefined} />
      {published && (
        <p role="status" className="text-sm">
          {published}
        </p>
      )}
      <Dialog
        open={review !== undefined}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish {review?.ref}?</DialogTitle>
            <DialogDescription>
              From {folderName(project)}. This is the registry's dry run:
              nothing is stored until you publish.
            </DialogDescription>
          </DialogHeader>
          {review && (
            <div className="grid gap-3 text-sm">
              {review.diff.length === 0 ? (
                <p className="text-muted-foreground">
                  Dry run reports no changes to the resolved persona.
                </p>
              ) : (
                <ul aria-label="Changes" className="grid gap-1">
                  {review.diff.map((change) => (
                    <li key={change.path}>
                      <span className="mr-2 font-mono">
                        {SIGN[change.change]}
                      </span>
                      {change.change} <code>{change.path}</code>
                    </li>
                  ))}
                </ul>
              )}
              {review.broken.length > 0 && (
                <p role="alert" className="text-destructive">
                  Would break: {review.broken.join(", ")}
                </p>
              )}
            </div>
          )}
          <ErrorText error={publish.error ?? undefined} />
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={publish.isPending}
              onClick={() => review && publish.mutate(review.ref)}
            >
              Publish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SignedIn({
  who,
}: {
  who: Extract<
    NonNullable<ReturnType<typeof useRun<"whoami">>["data"]>,
    { loggedIn: true }
  >;
}) {
  const bridge = useBridge();
  const queries = useQueryClient();
  const { project } = useProject();
  const logout = useMutation({
    meta: { quiet: true },
    mutationFn: () => bridge.run("logout", []),
    onSuccess: () => queries.invalidateQueries({ queryKey: ["run"] }),
  });
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Signed in as {who.subject}</CardTitle>
          <CardDescription>
            {who.org} at <code>{who.url}</code>
            {who.expiresAt !== undefined &&
              `, session until ${who.expiresAt.slice(0, 10)}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {who.roles !== undefined && <Roles roles={who.roles} />}
          <div>
            <Button
              variant="outline"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              Sign out
            </Button>
          </div>
          <ErrorText error={logout.error ?? undefined} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Pull</CardTitle>
          <CardDescription>
            Fetch the registry's layers into this machine's cache.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Pull />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Publish</CardTitle>
          <CardDescription>
            Publish a local layer of the picked project.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {project === undefined ? (
            <p className="text-sm text-muted-foreground">
              Pick a project to publish from.
            </p>
          ) : (
            <Publish key={project} project={project} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function RegistryRoute() {
  const who = useRun("whoami");
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            Registry
          </CardTitle>
          <CardDescription>
            Sign in, who you are, pull and publish.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {who.isPending ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <>
              {who.isError && <ErrorText error={who.error} />}
              {!who.isError && who.data.loggedIn ? null : <SignIn />}
            </>
          )}
        </CardContent>
      </Card>
      {who.data?.loggedIn === true && <SignedIn who={who.data} />}
    </div>
  );
}
