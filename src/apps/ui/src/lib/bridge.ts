import {
  COMMAND_OUTPUTS,
  ErrorEnvelope,
  type CommandName,
  type CommandOutput,
} from "@getdonn/cli-schemas";
import type { DaemonEvent, EventSource } from "./events";

// The app's one client of the daemon's loopback bridge (docs/planning/26-gui.md §2, §4). Every
// action is a CLI command the bridge runs in process with `--json`; its stdout is parsed with
// the command's schema from @getdonn/cli-schemas, so the app and the CLI cannot drift. A failed
// run, and any refusal of the bridge's own, is a CliFailure; a 401 ends the session.

/** A command that failed, or a request the bridge refused: `{ code, message, details }`. */
export class CliFailure extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  /** The CLI's exit code, for a run that failed. */
  readonly exitCode?: number;
  /** The HTTP status, for a request the bridge refused. */
  readonly status?: number;

  constructor(
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    extra: { exitCode?: number; status?: number } = {},
  ) {
    super(message);
    this.name = "CliFailure";
    this.code = code;
    this.details = details;
    if (extra.exitCode !== undefined) this.exitCode = extra.exitCode;
    if (extra.status !== undefined) this.status = extra.status;
  }

  /** The `fix` the CLI suggests, when it gives one. */
  get fix(): string | undefined {
    const fix = this.details.fix;
    return typeof fix === "string" ? fix : undefined;
  }
}

/** What a job's `job.*` events carry. */
export type JobEvent =
  | { type: "job.progress"; id: string; line: string }
  | {
      type: "job.question";
      id: string;
      question: unknown;
      continue: string[];
    }
  | ({ type: "job.done"; id: string } & JobDone);

/** How a job ended: `exitCode` null when it was cancelled before it ran. */
export interface JobDone {
  exitCode: number | null;
  stdout: string;
  truncated?: boolean;
  cancelled?: boolean;
  /** What it asked, when it stopped for an answer (`25` §6). */
  question?: unknown;
}

export interface JobHandle {
  id: string;
  /** Each of this job's events, those before the call included. */
  on(listener: (event: JobEvent) => void): () => void;
  done: Promise<JobDone>;
  /** Answers the job's question: the continuation is a new job. */
  answer(key: string, value: unknown): Promise<JobHandle>;
}

export interface BridgeClientOptions {
  /** The bridge's origin; the page's own. */
  base?: string;
  token: () => string | undefined;
  fetch?: typeof fetch;
  /** Called on any 401: the session ended. */
  onUnauthorized?: () => void;
  /** `/v1/events`, which jobs follow. */
  events: EventSource;
}

export interface Bridge {
  run<C extends CommandName>(
    command: C,
    args: string[],
    cwd?: string,
  ): Promise<CommandOutput<C>>;
  job(argv: string[], cwd?: string): Promise<JobHandle>;
  open(path: string): Promise<{ opened: string }>;
  projects(): Promise<string[]>;
  addProject(path: string): Promise<{ path: string; projects: string[] }>;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `{ error: { code, message, ...details } }`, the CLI's and the bridge's, as a CliFailure. */
function failureOf(
  body: unknown,
  extra: { exitCode?: number; status?: number },
): CliFailure | undefined {
  const parsed = ErrorEnvelope.safeParse(body);
  if (!parsed.success) return undefined;
  const { code, message, details, ...rest } = parsed.data.error;
  // The CLI spreads its details into the error; the bridge nests them under `details`.
  return new CliFailure(
    code,
    message ?? code,
    { ...rest, ...(isObject(details) ? details : {}) },
    extra,
  );
}

const withJson = (argv: string[]) =>
  argv.includes("--json") ? argv : [...argv, "--json"];

const lastLine = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

export function createBridge(options: BridgeClientOptions): Bridge {
  const base = options.base ?? window.location.origin;
  const doFetch = options.fetch ?? ((...args) => globalThis.fetch(...args));

  /** A request to the bridge, its JSON answer when 2xx; a CliFailure otherwise. */
  const request = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const token = options.token();
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          ...(token !== undefined && { authorization: `Bearer ${token}` }),
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new CliFailure(
        "unreachable",
        `the daemon did not answer: ${String(error)}`,
        { fix: "donn ui" },
      );
    }
    const answer: unknown = await res.json().catch(() => undefined);
    if (res.status === 401) options.onUnauthorized?.();
    if (res.ok) return answer;
    throw (
      failureOf(answer, { status: res.status }) ??
      new CliFailure(
        "http-error",
        `the bridge answered ${res.status}`,
        {},
        {
          status: res.status,
        },
      )
    );
  };

  /** A run's stdout as `command`'s output, or its failure. */
  const parse = <C extends CommandName>(
    command: C,
    result: RunResult,
  ): CommandOutput<C> => {
    let body: unknown;
    try {
      body = JSON.parse(result.stdout);
    } catch {
      body = undefined;
    }
    if (result.exitCode !== 0) {
      throw (
        failureOf(body, { exitCode: result.exitCode }) ??
        new CliFailure(
          "cli-failed",
          lastLine(result.stderr) ??
            `donn ${command} exited ${result.exitCode}`,
          {},
          { exitCode: result.exitCode },
        )
      );
    }
    const parsed = COMMAND_OUTPUTS[command].safeParse(body);
    if (!parsed.success) {
      throw new CliFailure(
        "bad-output",
        `donn ${command} printed output the app does not understand`,
        { issues: parsed.error.issues },
      );
    }
    return parsed.data as CommandOutput<C>;
  };

  /** Follows job `id` on the event stream, from events already buffered. */
  const follow = (id: string, early: DaemonEvent[]): JobHandle => {
    const listeners = new Set<(event: JobEvent) => void>();
    const seen: JobEvent[] = [];
    let question: unknown;
    let finish!: (done: JobDone) => void;
    const done = new Promise<JobDone>((resolve) => (finish = resolve));
    let finished = false;

    const end = (result: JobDone) => {
      if (finished) return;
      finished = true;
      unsubscribe();
      unopen();
      finish({
        ...result,
        ...(question !== undefined && { question }),
      });
    };
    const take = (event: DaemonEvent) => {
      if (event.id !== id || !event.type.startsWith("job.")) return;
      const job = event as JobEvent;
      seen.push(job);
      if (job.type === "job.question") question = job.question;
      for (const listener of [...listeners]) listener(job);
      if (job.type === "job.done") {
        const { type: _type, id: _id, ...result } = job;
        end(result);
      }
    };
    const unsubscribe = options.events.subscribe(take);
    // Reconnected: a done sent while the stream was down is asked for.
    const unopen = options.events.onOpen(() => {
      void request("GET", `/v1/jobs/${encodeURIComponent(id)}`)
        .then((view) => {
          if (!isObject(view) || view.state !== "done") return;
          if (isObject(view.question)) question = view.question.question;
          end({
            exitCode: typeof view.exitCode === "number" ? view.exitCode : null,
            stdout: typeof view.stdout === "string" ? view.stdout : "",
            ...(view.truncated === true && { truncated: true }),
            ...(view.cancelled === true && { cancelled: true }),
          });
        })
        .catch(() => {});
    });
    for (const event of early) take(event);

    return {
      id,
      on(listener) {
        for (const event of seen) listener(event);
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      done,
      answer: (key, value) =>
        started(() =>
          request("POST", `/v1/jobs/${encodeURIComponent(id)}/answer`, {
            key,
            value,
          }),
        ),
    };
  };

  /** Starts a job by `post`, following the stream from before it starts. */
  const started = async (post: () => Promise<unknown>): Promise<JobHandle> => {
    const early: DaemonEvent[] = [];
    const buffer = options.events.subscribe((event) => early.push(event));
    try {
      const answer = await post();
      if (!isObject(answer) || typeof answer.id !== "string") {
        throw new CliFailure("bad-output", "the bridge gave no job id");
      }
      return follow(answer.id, early);
    } finally {
      buffer();
    }
  };

  return {
    async run(command, args, cwd) {
      const result = (await request("POST", "/v1/run", {
        argv: withJson([...command.split(" "), ...args]),
        ...(cwd !== undefined && { cwd }),
      })) as RunResult;
      return parse(command, result);
    },
    job: (argv, cwd) =>
      started(() =>
        request("POST", "/v1/jobs", {
          argv: withJson(argv),
          ...(cwd !== undefined && { cwd }),
        }),
      ),
    open: async (path) =>
      (await request("POST", "/v1/open", { path })) as { opened: string },
    projects: async () =>
      ((await request("GET", "/v1/projects")) as { projects: string[] })
        .projects,
    addProject: async (path) =>
      (await request("POST", "/v1/projects", { path })) as {
        path: string;
        projects: string[];
      },
  };
}
