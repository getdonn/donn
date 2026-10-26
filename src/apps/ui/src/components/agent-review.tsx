import type { AgentCreateOutput, AgentListOutput } from "@getdonn/cli-schemas";
import { Badge } from "@/components/ui/badge";

// The review step of the agent builder: what `donn agent create --dry-run` says. The compile
// report (what the agent keeps and drops of the persona), the portability report with blocking
// entries first, the donn-owned files, and the `agents.define` entry to be added to the persona.

type AgentTarget = AgentListOutput["agents"][number]["target"];
type Dry = Extract<AgentCreateOutput, { dryRun: true }>;

/** The lines of `agents.define.<name>` in the persona text the dry run would write. */
export function declaredEntry(after: string, name: string): string | undefined {
  const lines = after.split("\n");
  const start = lines.findIndex((line) =>
    new RegExp(`^\\s+${name}:`).test(line),
  );
  if (start === -1) return undefined;
  const indent = lines[start]!.search(/\S/);
  const entry = [lines[start]!];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && line.search(/\S/) <= indent) break;
    entry.push(line);
  }
  return entry.join("\n").trimEnd();
}

/** Blocking entries first; the order within each is the report's own. */
export const blockingFirst = <T extends { blocking: boolean }>(
  entries: T[],
) => [
  ...entries.filter((e) => e.blocking),
  ...entries.filter((e) => !e.blocking),
];

export function Review({
  dry,
  name,
  target,
}: {
  dry: Dry;
  name: string;
  target: AgentTarget;
}) {
  const portability = blockingFirst(dry.portability);
  const entry =
    dry.declared === undefined
      ? undefined
      : declaredEntry(dry.declared.after, name);
  return (
    <div className="grid gap-5">
      <section aria-label="Persona entry" className="grid gap-1.5">
        <h3 className="text-sm font-medium">Added to the persona</h3>
        {dry.declared === undefined ? (
          <p className="text-sm text-muted-foreground">
            The persona already declares {name}; nothing is added.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              <code>agents.define.{name}</code> in{" "}
              <code>{dry.declared.file}</code>
            </p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
              {entry ?? dry.declared.after}
            </pre>
          </>
        )}
      </section>
      <section aria-label="What the agent receives" className="grid gap-1.5">
        <h3 className="text-sm font-medium">What the agent receives</h3>
        <p className="text-xs text-muted-foreground">
          {Object.keys(dry.files).length} files donn writes in{" "}
          <code>{dry.dir}</code>, eve {dry.frameworkVersion}
        </p>
        <ul className="grid gap-1 text-xs" aria-label="Files">
          {Object.keys(dry.files).map((file) => (
            <li key={file}>
              <code>{file}</code>
            </li>
          ))}
        </ul>
        {dry.report.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The persona compiles to the agent with nothing dropped.
          </p>
        ) : (
          <ul className="grid gap-1.5 text-sm" aria-label="Compile report">
            {dry.report.entries.map((e) => (
              <li key={`${e.path}-${e.outcome}`} className="flex gap-2">
                <Badge
                  variant={
                    e.outcome === "dropped" ? "destructive" : "secondary"
                  }
                >
                  {e.outcome}
                </Badge>
                <span>
                  <code>{e.path}</code>: {e.reason}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Portability" className="grid gap-1.5">
        <h3 className="text-sm font-medium">Portability at {target}</h3>
        {portability.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing here needs another service.
          </p>
        ) : (
          <ul className="grid gap-1.5 text-sm">
            {portability.map((p) => (
              <li key={`${p.service}-${p.target}`} className="flex gap-2">
                <Badge variant={p.blocking ? "destructive" : "outline"}>
                  {p.blocking ? "blocking" : "advisory"}
                </Badge>
                <span>
                  <strong>{p.service}</strong> ({p.target}): {p.instead}
                  {p.env && ` [env: ${p.env.join(", ")}]`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
