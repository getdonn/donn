import { randomUUID } from "node:crypto";
import type { RunLines, RunResult } from "./run.js";

// The bridge's jobs (`POST /v1/jobs`): a long CLI run (`agent create`, `build`, `deploy`,
// `pull`) the app starts and follows by events instead of holding a request open. One runs at a
// time, in the order started; each stderr line is a `job.progress`, the end a `job.done` with
// the JSON result. A run that stops for an answer (exit 2 with a `needs-answer` result) is a
// `job.question`; its answer runs the `continue` argv as a new job. See docs/planning/26-gui.md
// §2 and docs/planning/25-agent-runner.md §6.

export type JobState = "queued" | "running" | "done";

/** What a `needs-answer` result asks, and the argv that continues once answered. */
export interface JobQuestion {
  question: unknown;
  continue: string[];
}

export interface Job {
  id: string;
  argv: string[];
  /** The project it runs in, as asked; none for a project-independent command. */
  cwd: string | undefined;
  state: JobState;
  /** The job whose question this one answers. */
  parent?: string;
  /** The job that answers this one's question. */
  answeredBy?: string;
  createdAt: number;
  finishedAt?: number;
  result?: RunResult;
  question?: JobQuestion;
}

export interface JobEvent {
  type: "job.progress" | "job.question" | "job.done";
  id: string;
  [key: string]: unknown;
}

export interface JobsOptions {
  /** Runs the CLI for a job: the bridge's in-process run, with its cwd rules applied. */
  run: (
    argv: string[],
    cwd: string | undefined,
    lines: RunLines,
  ) => Promise<RunResult>;
  emit: (event: JobEvent) => void;
  now?: () => number;
  /** Keeps the bridge open while a job is queued or running. */
  hold?: () => () => void;
  /** How many jobs are kept; 100. */
  limit?: number;
  /** How long a done job is kept; an hour. */
  keepMs?: number;
}

export interface Jobs {
  /** Queues a job; undefined when `limit` jobs are still queued or running. */
  start(
    argv: string[],
    cwd: string | undefined,
    parent?: string,
  ): Job | undefined;
  get(id: string): Job | undefined;
  /**
   * The argv and cwd that answer a job's question: its `continue` with `--answer key=<JSON>`.
   * Nothing is started: the caller checks the argv as any run's, then starts it with the
   * question's job as `parent`.
   */
  continuation(
    id: string,
    key: string,
    value: unknown,
  ):
    | { argv: string[]; cwd: string | undefined }
    | "no-such-job"
    | "no-question"
    | "answered";
  /** A job as `GET /v1/jobs/<id>` answers it. */
  view(job: Job): Record<string, unknown>;
}

const LIMIT = 100;
const KEEP_MS = 60 * 60_000;

/** The question of an exit-2 run whose stdout is a `needs-answer` result; else undefined. */
function askedBy(result: RunResult): JobQuestion | undefined {
  if (result.exitCode !== 2) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null) return undefined;
  const { status, question, continue: next } = body as Record<string, unknown>;
  if (
    status !== "needs-answer" ||
    question === undefined ||
    !Array.isArray(next) ||
    next.length === 0 ||
    !next.every((a) => typeof a === "string")
  )
    return undefined;
  return { question, continue: next as string[] };
}

export function createJobs(options: JobsOptions): Jobs {
  const now = options.now ?? Date.now;
  const limit = options.limit ?? LIMIT;
  const keepMs = options.keepMs ?? KEEP_MS;
  /** Every job kept, oldest first. */
  const jobs = new Map<string, Job>();
  const queue: Job[] = [];
  let running = false;

  const expire = () => {
    for (const [id, job] of jobs) {
      if (job.finishedAt !== undefined && now() - job.finishedAt >= keepMs)
        jobs.delete(id);
    }
  };

  const execute = async (job: Job) => {
    job.state = "running";
    let result: RunResult;
    try {
      result = await options.run(job.argv, job.cwd, {
        onStderr: (line) =>
          options.emit({ type: "job.progress", id: job.id, line }),
      });
    } catch (error) {
      result = {
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
    job.result = result;
    const question = askedBy(result);
    if (question) {
      job.question = question;
      options.emit({ type: "job.question", id: job.id, ...question });
    }
    job.state = "done";
    job.finishedAt = now();
    options.emit({
      type: "job.done",
      id: job.id,
      exitCode: result.exitCode,
      stdout: result.stdout,
    });
  };

  const pump = () => {
    if (running) return;
    const next = queue.shift();
    if (next === undefined) return;
    running = true;
    const release = options.hold?.();
    void execute(next).finally(() => {
      running = false;
      release?.();
      pump();
    });
  };

  const get = (id: string) => {
    expire();
    return jobs.get(id);
  };

  return {
    start(argv, cwd, parent) {
      expire();
      // Room for one more: the oldest done jobs go first; a full list of live ones refuses.
      for (const [id, job] of jobs) {
        if (jobs.size < limit) break;
        if (job.state === "done") jobs.delete(id);
      }
      if (jobs.size >= limit) return undefined;
      const job: Job = {
        id: randomUUID(),
        argv,
        cwd,
        state: "queued",
        createdAt: now(),
        ...(parent !== undefined && { parent }),
      };
      const asked = parent === undefined ? undefined : jobs.get(parent);
      if (asked) asked.answeredBy = job.id;
      jobs.set(job.id, job);
      queue.push(job);
      pump();
      return job;
    },
    get,
    continuation(id, key, value) {
      const job = get(id);
      if (job === undefined) return "no-such-job";
      if (job.question === undefined) return "no-question";
      if (job.answeredBy !== undefined) return "answered";
      return {
        argv: [
          ...job.question.continue,
          "--answer",
          `${key}=${JSON.stringify(value)}`,
        ],
        cwd: job.cwd,
      };
    },
    view(job) {
      return {
        id: job.id,
        argv: job.argv,
        ...(job.cwd !== undefined && { cwd: job.cwd }),
        state: job.state,
        ...(job.parent !== undefined && { parent: job.parent }),
        ...(job.answeredBy !== undefined && { answeredBy: job.answeredBy }),
        createdAt: new Date(job.createdAt).toISOString(),
        ...(job.finishedAt !== undefined && {
          finishedAt: new Date(job.finishedAt).toISOString(),
        }),
        ...(job.result && {
          exitCode: job.result.exitCode,
          stdout: job.result.stdout,
          stderr: job.result.stderr,
        }),
        ...(job.question && { question: job.question }),
      };
    },
  };
}
