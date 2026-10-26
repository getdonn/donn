import { CliFailure } from "@/lib/bridge";
import { cn } from "@/lib/utils";

// The one renderer of a failure shown inline (role=alert): its message, the CLI's fix as an
// element of its own, and the code when there is no message. Toasts are app/providers.tsx's.

export function ErrorText({
  error,
  className,
}: {
  error: unknown;
  className?: string;
}) {
  if (error === undefined || error === null) return null;
  const failure = error instanceof CliFailure ? error : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const parts = [
    message !== "" && (
      <p key="message" className="text-destructive">
        {message}
      </p>
    ),
    failure?.fix !== undefined && (
      <p key="fix" className="text-muted-foreground">
        {failure.fix}
      </p>
    ),
    message === "" && failure !== undefined && (
      <p key="code" className="text-destructive">
        <code>{failure.code}</code>
      </p>
    ),
  ].filter((part) => part !== false);
  return (
    <div role="alert" className={cn("grid gap-0.5 text-sm", className)}>
      {/* A space between the parts: read as text, they never run together. */}
      {parts.flatMap((part, i) => (i === 0 ? [part] : [" ", part]))}
    </div>
  );
}
