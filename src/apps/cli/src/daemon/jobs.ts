import { randomUUID } from "node:crypto";
import type { RunLines, RunResult } from "./run.js";

// The bridge's jobs (`POST /v1/jobs`): a long CLI run (`agent create`, `build`, `deploy`,
// `pull`) the app starts and follows by events instead of holding a request open. Up to four run
// at once, the rest queued in the order started (the per-agent lock already serialises an
// agent's writes); each stderr line is a `job.progress`, the end a `job.done` with the JSON
// result. A run that stops for an answer (exit 2 with a `needs-answer` result) is a
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
  /** Its output, each stream cut to its last `maxOutput` bytes. */
  result?: RunResult;
  /** Whether the output kept is the end of a longer one. */
  truncated?: boolean;
  /** Queued when the bridge closed: never run. */
  cancelled?: boolean;
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
  /** How many run at once; 4. */
  concurrency?: number;
  /** How much of each of a job's stdout and stderr is kept, from the end; 256 KiB. */
  maxOutput?: number;
}

export interface Jobs {
  /** Queues a job: `full` when `limit` jobs are still queued or running, `closed` after close. */
  start(
    argv: string[],
    cwd: string | undefined,
    parent?: string,
  ): Job | "full" | "closed";
  get(id: string): Job | undefined;
  /**
   * The argv and cwd that answer a job's question: its `continue` with `--answer=<key>=<JSON>`,
   * one token, so no parser reads the value as a flag.
   * Nothing is started: the caller checks the argv as any run's, then starts it with the
   * question's job as `parent`. A secret question (`kind: "environment"`) has no continuation:
   * its value never goes on a command line.
   */
  continuation(
    id: string,
    key: string,
    value: unknown,
  ):
    | { argv: string[]; cwd: string | undefined }
    | "no-such-job"
    | "no-question"
    | "answered"
    | "secret-question";
  /** A job as `GET /v1/jobs/<id>` answers it. */
  view(job: Job): Record<string, unknown>;
  /** Cancels the queued jobs (each a `job.done` with `cancelled`) and starts none again. */
  close(): void;
}

const LIMIT = 100;
const KEEP_MS = 60 * 60_000;
const CONCURRENCY = 4;
const MAX_OUTPUT = 256 * 1024;

/**
 * `argv` with each answer's value hidden: `--answer=<key>=***`, and the value after a lone
 * `--answer` as `<key>=***`. For the daemon log and a job's view.
 */
export function redactAnswers(argv: readonly string[]): string[] {
  const hide = (pair: string) => {
    const at = pair.indexOf("=");
    return at === -1 ? "***" : `${pair.slice(0, at)}=***`;
  };
  return argv.map((arg, i) =>
    arg.startsWith("--answer=")
      ? `--answer=${hide(arg.slice("--answer=".length))}`
      : argv[i - 1] === "--answer"
        ? hide(arg)
        : arg,
  );
}

/** The variable a secret question (`kind: "environment"`) names; undefined for any other. */
export function secretVariable(question: unknown): string | undefined {
  if (typeof question !== "object" || question === null) return undefined;
  const { kind, variable } = question as { kind?: unknown; variable?: unknown };
  if (kind !== "environment") return undefined;
  return typeof variable === "string" ? variable : "its variable";
}

/** The last `max` bytes of `text`, and whether that cut it. */
function tail(text: string, max: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return { text, cut: false };
  return {
    text: bytes.subarray(bytes.length - max).toString("utf8"),
    cut: true,
  };
}

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
  const concurrency = options.concurrency ?? CONCURRENCY;
  const maxOutput = options.maxOutput ?? MAX_OUTPUT;
  /** Every job kept, oldest first. */
  const jobs = new Map<string, Job>();
  const queue: Job[] = [];
  let running = 0;
  let closed = false;

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
    // Asked of the whole stdout, before it is cut.
    const question = askedBy(result);
    const stdout = tail(result.stdout, maxOutput);
    const stderr = tail(result.stderr, maxOutput);
    job.result = {
      exitCode: result.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
    };
    if (stdout.cut || stderr.cut) job.truncated = true;
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
      stdout: stdout.text,
      ...(stdout.cut && { truncated: true }),
    });
  };

  const pump = () => {
    while (!closed && running < concurrency) {
      const next = queue.shift();
      if (next === undefined) return;
      running++;
      const release = options.hold?.();
      void execute(next).finally(() => {
        running--;
        release?.();
        pump();
      });
    }
  };

  const get = (id: string) => {
    expire();
    return jobs.get(id);
  };

  return {
    start(argv, cwd, parent) {
      if (closed) return "closed";
      expire();
      // Room for one more: the oldest done jobs go first; a full list of live ones refuses.
      for (const [id, job] of jobs) {
        if (jobs.size < limit) break;
        if (job.state === "done") jobs.delete(id);
      }
      if (jobs.size >= limit) return "full";
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
      if (secretVariable(job.question.question) !== undefined)
        return "secret-question";
      return {
        argv: [
          ...job.question.continue,
          `--answer=${key}=${JSON.stringify(value)}`,
        ],
        cwd: job.cwd,
      };
    },
    view(job) {
      return {
        id: job.id,
        argv: redactAnswers(job.argv),
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
        ...(job.truncated && { truncated: true }),
        ...(job.cancelled && { cancelled: true, exitCode: null }),
        ...(job.question && { question: job.question }),
      };
    },
    close() {
      closed = true;
      for (const job of queue.splice(0)) {
        job.state = "done";
        job.cancelled = true;
        job.finishedAt = now();
        options.emit({
          type: "job.done",
          id: job.id,
          exitCode: null,
          stdout: "",
          cancelled: true,
        });
      }
    },
  };
}
