import { CliFailure } from "@/lib/bridge";

// A failure shown inline (role=alert): its message, and the CLI's fix under it.

export function ErrorText({ error }: { error: unknown }) {
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
