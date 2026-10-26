import type { ResolveOutput } from "@getdonn/cli-schemas";
import { ExplainPopover } from "@/components/explain-popover";
import { Badge } from "@/components/ui/badge";
import { fieldGroups } from "@/lib/explain";

// The resolved persona by field group, each value with its Explain popover and the layer that
// set it. Secrets are refs only: the IR holds no values.

export function FieldGroups({ result }: { result: ResolveOutput }) {
  return (
    <div className="grid gap-4">
      {fieldGroups(result.ir).map((group) => (
        <section key={group.id} aria-label={group.title} className="grid gap-1">
          <h3 className="text-sm font-medium">
            {group.title}{" "}
            <span className="text-muted-foreground">
              ({group.items.length})
            </span>
          </h3>
          {group.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {group.items.map((item) => (
                <li
                  key={`${item.path}|${item.label}`}
                  className="flex items-center gap-3 px-3 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-sm">
                      {item.label}
                    </div>
                    {item.detail !== undefined && (
                      <div className="truncate text-xs text-muted-foreground">
                        {item.detail}
                      </div>
                    )}
                  </div>
                  {result.provenance[item.path] !== undefined && (
                    <Badge variant="secondary" className="font-mono">
                      {result.provenance[item.path]}
                    </Badge>
                  )}
                  <ExplainPopover
                    result={result}
                    path={item.path}
                    label={item.label}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
