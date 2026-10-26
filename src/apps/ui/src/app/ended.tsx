import { TerminalIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { EndReason } from "@/lib/session";

// What the app shows once its session is over (docs/planning/26-gui.md §1): the token is gone,
// and only a new `donn ui` signs in again. No retry: the bridge would refuse it.

const WHY: Record<EndReason, string> = {
  "no-session": "This page was opened without a sign-in code.",
  "bad-code": "The sign-in code was already used or has expired.",
  unauthorized: "The daemon no longer accepts this page's session.",
  unreachable: "The daemon did not answer.",
  "daemon-stopped": "The daemon stopped.",
  idle: "The daemon closed the UI after ten minutes without use.",
};

export function SessionEnded({ reason }: { reason: EndReason }) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground">
      <Alert className="max-w-md" data-testid="session-ended">
        <TerminalIcon />
        <AlertTitle>
          Session ended — run <code className="font-mono">donn ui</code> again
        </AlertTitle>
        <AlertDescription>
          <p>{WHY[reason]}</p>
          <p>It prints a new link that signs this browser in.</p>
        </AlertDescription>
      </Alert>
    </div>
  );
}
