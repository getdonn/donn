import type { SwitchOutput } from "@getdonn/cli-schemas";
import { Badge } from "@/components/ui/badge";

// The per-harness report of a switch (docs/planning/17-switch-report.md): what each harness
// keeps and drops, the sessions still on another persona, and what the committed AGENTS.md
// carries (`shared`: it carries the project persona, whatever was switched to).

type Report = Extract<SwitchOutput, { harnesses?: unknown }>;
type Harness = NonNullable<Report["harnesses"]>[number];

const STATUS: Record<
  Harness["status"],
  { label: string; variant: "secondary" | "outline" | "destructive" }
> = {
  ok: { label: "keeps everything", variant: "secondary" },
  drops: { label: "drops some", variant: "outline" },
  error: { label: "could not build", variant: "destructive" },
  shared: { label: "shared file", variant: "outline" },
};

/** The harnesses a switch reported on; none for the no-argument forms. */
export const harnessesOf = (result: SwitchOutput): Harness[] =>
  "harnesses" in result ? (result.harnesses ?? []) : [];

function Line({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <p className="text-sm">
      <span className="text-muted-foreground">{label}: </span>
      {items.join(", ")}
    </p>
  );
}

export function SwitchReport({ harnesses }: { harnesses: Harness[] }) {
  if (harnesses.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No harness applies to this project.
      </p>
    );
  return (
    <ul aria-label="Harnesses" className="grid gap-3">
      {harnesses.map((harness) => (
        <li key={harness.id} className="grid gap-1 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <span className="font-medium">{harness.id}</span>
            <Badge variant={STATUS[harness.status].variant}>
              {STATUS[harness.status].label}
            </Badge>
          </div>
          <Line label="Drops" items={harness.dropped} />
          <Line label="Approximates" items={harness.approximated} />
          {harness.sessions && (
            <p className="text-sm">
              {harness.sessions.count} session
              {harness.sessions.count === 1 ? "" : "s"} still on{" "}
              <code>{harness.sessions.persona}</code>
              <span className="block text-muted-foreground">
                {harness.sessions.fix}
              </span>
            </p>
          )}
          {harness.message && <p className="text-sm">{harness.message}</p>}
          {harness.fix && (
            <p className="text-sm text-muted-foreground">{harness.fix}</p>
          )}
          {harness.id === "agents-md" && harness.status === "shared" && (
            <p className="text-sm text-muted-foreground">
              AGENTS.md carries the project persona, not this switch.
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
