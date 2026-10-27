import type { CommandName, CommandOutput } from "@getdonn/cli-schemas";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { CliFailure, createBridge, type Bridge } from "@/lib/bridge";
import {
  createEventStream,
  EventsContext,
  useDaemonEvents,
  type EventStream,
} from "@/lib/events";
import { endReasonOf, type Session } from "@/lib/session";

// What every screen shares: the bridge client, the event stream, TanStack Query (one query per
// `run`, refetched when a daemon event says its answer changed) and the picked project.

/** The query key of `run(command, args, cwd)`; invalidated by command. */
export const runKey = (command: CommandName, args: string[], cwd?: string) =>
  ["run", command, cwd ?? null, ...args] as const;

/** Which queries each daemon event makes stale, by command. */
const STALE_ON: ReadonlyArray<[string, readonly CommandName[]]> = [
  ["session.", ["status"]],
  ["agent.", ["status", "agent list", "agent logs"]],
];

/** A failure as a toast: its message, and the CLI's fix under it. */
export function toastFailure(error: unknown) {
  if (error instanceof CliFailure) {
    // The ended screen says it already.
    if (error.status === 401) return;
    toast.error(error.message, {
      ...(error.fix !== undefined && { description: error.fix }),
    });
  } else {
    toast.error(String(error));
  }
}

const BridgeContext = createContext<Bridge | undefined>(undefined);

export function useBridge(): Bridge {
  const bridge = useContext(BridgeContext);
  if (bridge === undefined) throw new Error("useBridge needs AppProviders");
  return bridge;
}

/** `donn <command> <args> --json` in `cwd`, as a query. */
export function useRun<C extends CommandName>(
  command: C,
  args: string[] = [],
  cwd?: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<CommandOutput<C>, CliFailure> {
  const bridge = useBridge();
  return useQuery({
    queryKey: runKey(command, args, cwd),
    queryFn: () => bridge.run(command, args, cwd),
    ...options,
  });
}

interface ProjectState {
  /** The picked project's folder. */
  project: string | undefined;
  pick(project: string | undefined): void;
}

const ProjectContext = createContext<ProjectState | undefined>(undefined);
const PROJECT_KEY = "donn.ui.project";

export function useProject(): ProjectState {
  const state = useContext(ProjectContext);
  if (state === undefined) throw new Error("useProject needs AppProviders");
  return state;
}

/**
 * The project a deep link names (`?project=`, docs/planning/28-desktop.md §1): kept as the
 * picker keeps a pick, then dropped from the address bar. The path, other params and the
 * fragment stay: the sign-in code is spent from the fragment afterwards.
 */
function projectFromLink(): string | undefined {
  const url = new URL(window.location.href);
  const linked = url.searchParams.get("project");
  if (linked === null) return undefined;
  url.searchParams.delete("project");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
  if (linked === "") return undefined;
  try {
    sessionStorage.setItem(PROJECT_KEY, linked);
  } catch {
    // Not kept: the pick lasts for this page.
  }
  return linked;
}

function ProjectProvider({ children }: { children: ReactNode }) {
  const [project, setProject] = useState<string | undefined>(() => {
    const linked = projectFromLink();
    if (linked !== undefined) return linked;
    try {
      return sessionStorage.getItem(PROJECT_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  });
  const pick = useCallback((next: string | undefined) => {
    setProject(next);
    try {
      if (next === undefined) sessionStorage.removeItem(PROJECT_KEY);
      else sessionStorage.setItem(PROJECT_KEY, next);
    } catch {
      // Not kept: the pick lasts for this page.
    }
  }, []);
  const value = useMemo(() => ({ project, pick }), [project, pick]);
  return (
    <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
  );
}

/** Refetches what a daemon event made stale; a closing bridge or daemon ends the session. */
function Invalidation({ session }: { session: Session }) {
  const queries = useQueryClient();
  useDaemonEvents(
    () => true,
    (event) => {
      const ended = endReasonOf(event);
      if (ended !== undefined) return session.end(ended);
      for (const [prefix, commands] of STALE_ON) {
        if (!event.type.startsWith(prefix)) continue;
        for (const command of commands)
          void queries.invalidateQueries({ queryKey: ["run", command] });
      }
      if (event.type === "job.done")
        void queries.invalidateQueries({ queryKey: ["projects"] });
    },
  );
  return null;
}

export interface AppClients {
  bridge: Bridge;
  events: EventStream;
  queries: QueryClient;
}

/** The clients for a session: one bridge, one event stream, one query cache. */
export function createClients(session: Session): AppClients {
  const end = () => session.end("unauthorized");
  const token = () => session.token();
  const events = createEventStream({
    base: window.location.origin,
    token,
    onUnauthorized: end,
    onUnreachable: () => session.end("unreachable"),
  });
  const bridge = createBridge({ token, onUnauthorized: end, events });
  const queries = new QueryClient({
    queryCache: new QueryCache({ onError: toastFailure }),
    // A mutation that shows its own failure (a form) sets `meta: { quiet: true }`.
    mutationCache: new MutationCache({
      onError: (error, _variables, _result, mutation) => {
        if (mutation.meta?.quiet !== true) toastFailure(error);
      },
    }),
    defaultOptions: {
      queries: {
        // A refused or failed run fails the same way again: no retry storm.
        retry: false,
        refetchOnWindowFocus: false,
      },
    },
  });
  return { bridge, events, queries };
}

export function AppProviders({
  clients,
  session,
  children,
}: {
  clients: AppClients;
  session: Session;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={clients.queries}>
      <BridgeContext.Provider value={clients.bridge}>
        <EventsContext.Provider value={clients.events}>
          <ProjectProvider>
            <Invalidation session={session} />
            {children}
          </ProjectProvider>
        </EventsContext.Provider>
      </BridgeContext.Provider>
    </QueryClientProvider>
  );
}
