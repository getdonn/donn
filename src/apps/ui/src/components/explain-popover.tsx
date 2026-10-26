import type { ResolveOutput } from "@getdonn/cli-schemas";
import { InfoIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { explainValue } from "@/lib/explain";

// "Explain" for one value (docs/planning/26-gui.md §3): the layer that set it, what it
// overrode, the lock protecting it. Read from the resolve answer, not computed.

export function ExplainPopover({
  result,
  path,
  label,
}: {
  result: ResolveOutput;
  path: string;
  label: string;
}) {
  const explained = explainValue(result, path);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Explain">
          <InfoIcon />
          Explain
        </Button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={`Explain ${label}`}
        className="grid gap-2 text-sm"
      >
        <code className="break-all text-xs text-muted-foreground">{path}</code>
        <p>
          {explained.layer === undefined
            ? "No layer set this value."
            : `Set by ${explained.layer}`}
        </p>
        {explained.overrides.map((entry) => (
          <p key={`${entry.layer}-${entry.kind}`}>
            {entry.kind === "override"
              ? `Overrode ${entry.from}`
              : `Removed ${entry.from}'s value`}
          </p>
        ))}
        {explained.replaced.map((entry) => (
          <p key={entry.path}>
            Replaced {entry.path} from {entry.from}
          </p>
        ))}
        {explained.locks.map((lock) => (
          <p key={lock.path}>
            Locked by {lock.layer} on <code>{lock.path}</code>
          </p>
        ))}
        {explained.warnings.map((warning) => (
          <p key={warning.code} className="text-destructive">
            {warning.message ?? warning.code}
          </p>
        ))}
      </PopoverContent>
    </Popover>
  );
}
