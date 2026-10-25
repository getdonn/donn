import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findProject } from "@getdonn/store-local";
import type { CliIo } from "../cli.js";
import { cliVersion } from "../commands/daemon.js";
import type { Context } from "../context.js";
import { connectDaemon, type AgentInfo } from "../daemon/client.js";
import { CliError } from "../errors.js";
import { agentEnvironment } from "./env.js";
import { eveEnv, packageManager, runEve } from "./eve.js";
import { projectContext, projectRoot } from "./load.js";
import { nodeSpawn } from "./spawn.js";

// `donn agent run|stop|logs`: a created agent built and started with its env resolved, by the
// daemon when one runs, else in the foreground. `eve start` runs in its own process group so
// `stop` reaches the server as well as `pnpm exec` (the server's shutdown removes its sandbox
// containers). See docs/planning/25-agent-runner.md, section 4 `local`, and
// spikes/eve-runner/FINDINGS-runtime.md R1 and R6.

export type { AgentInfo };

const START_LINE = /^\[START\] server listening at (\S+)/;
const START_TIMEOUT_MS = 60_000;
const KILL_AFTER_MS = 10_000;
const TAIL_LINES = 20;
const FOLLOW_MS = 250;
const SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
const LEFTOVERS = ["ps", "-q", "--filter", "name=eve-sbx-"];

export interface RunningAgent extends AgentInfo {
  /** The exit code of `eve start`; it settles on a stop or when the agent ends on its own. */
  exited: Promise<number>;
  /** SIGTERM to the group, SIGKILL after 10 s, then the `eve-sbx-*` containers still up. */
  stop(): Promise<{ leftovers: number }>;
}

export interface StartOptions {
  name: string;
  /** The project's root folder. */
  project: string;
  /** Each output line of `eve build` and `eve start`, with the token and `redact` hidden. */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  /** Values (resolved secrets) replaced by `***` in every line passed on. */
  redact?: string[];
  /** Stops a start still waiting for eve to listen. */
  signal?: AbortSignal;
  startTimeoutMs?: number;
  killAfterMs?: number;
}

/** The running agents and how to start and stop them: the daemon's, or its socket's. */
export interface AgentControl {
  list(): Promise<AgentInfo[]>;
  run(
    project: string,
    name: string,
  ): Promise<{ agent: AgentInfo; already: boolean }>;
  stop(
    project: string,
    name: string,
  ): Promise<{ stopped: boolean; leftovers?: number }>;
}

const eveFailed = (
  command: string,
  message: string,
  tail: string[],
  exitCode?: number,
) =>
  new CliError("eve-failed", message, {
    command,
    ...(exitCode !== undefined && { exitCode }),
    tail,
  });

/** How many `eve-sbx-*` containers run; 0 when Docker does not answer. */
export async function leftoverContainers(io: CliIo): Promise<number> {
  const result = await io.probe.run("docker", LEFTOVERS).catch(() => undefined);
  if (result?.exitCode !== 0) return 0;
  return result.stdout.split("\n").filter((line) => line.trim() !== "").length;
}

/**
 * `eve build`, then `eve start --host 127.0.0.1 --port 0` in its own process group with `env`,
 * `NODE_ENV=production` and a new route token; resolves once eve prints its `[START]` line.
 */
export async function startAgent(
  io: CliIo,
  dir: string,
  env: Record<string, string>,
  options: StartOptions,
): Promise<RunningAgent> {
  const token = randomBytes(32).toString("hex");
  const hidden = [...(options.redact ?? []), token]
    .filter((value) => value !== "")
    .sort((a, b) => b.length - a.length);
  const hide = (line: string) =>
    hidden.reduce((text, value) => text.replaceAll(value, "***"), line);
  const tail: string[] = [];
  const pass = (line: string, stream: "stdout" | "stderr") => {
    const shown = hide(line);
    tail.push(shown);
    if (tail.length > TAIL_LINES) tail.shift();
    options.onLine?.(shown, stream);
  };

  // The build evaluates the agent without its run-time env, so it gets no secret.
  const pm = await packageManager(dir);
  const build = await runEve(io, dir, ["build"], {
    env: {},
    onProgress: (line) => pass(line, "stdout"),
  });
  if (build.exitCode !== 0) {
    throw eveFailed(
      `${pm} exec eve build`,
      `eve build exited ${build.exitCode}: ${hide(build.tail.at(-1) ?? "no output")}`,
      build.tail.map(hide),
      build.exitCode,
    );
  }

  tail.length = 0;
  const args = ["exec", "eve", "start", "--host", "127.0.0.1", "--port", "0"];
  const command = `${pm} ${args.join(" ")}`;
  let listening!: (url: string) => void;
  const url = new Promise<string>((resolve) => (listening = resolve));
  const child = (io.spawn ?? nodeSpawn)(pm, args, {
    cwd: dir,
    env: eveEnv(io.env, { ...env, DONN_ROUTE_TOKEN: token }),
    detached: true,
    onLine: (line, stream) => {
      pass(line, stream);
      const match = START_LINE.exec(line);
      if (match) listening(match[1]!);
    },
  });
  let ended = false;
  const exited = child.exited.then((code) => {
    ended = true;
    return code;
  });
  const killAfterMs = options.killAfterMs ?? KILL_AFTER_MS;
  let stopping: Promise<{ leftovers: number }> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      // The group, even when `pnpm exec` has gone: the server may outlive it.
      child.kill("SIGTERM");
      if (!ended) {
        let timer: NodeJS.Timeout | undefined;
        const gone = await Promise.race([
          exited.then(() => true),
          new Promise<boolean>(
            (resolve) =>
              (timer = setTimeout(() => resolve(false), killAfterMs)),
          ),
        ]);
        clearTimeout(timer);
        if (!gone) {
          child.kill("SIGKILL");
          await exited;
        }
      }
      return { leftovers: await leftoverContainers(io) };
    })());

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const outcome = await Promise.race([
    url.then((at) => ({ url: at })),
    exited.then((code) => ({ code })),
    new Promise<{ timeout: true }>(
      (resolve) =>
        (timer = setTimeout(
          () => resolve({ timeout: true }),
          options.startTimeoutMs ?? START_TIMEOUT_MS,
        )),
    ),
    new Promise<{ aborted: true }>((resolve) => {
      onAbort = () => resolve({ aborted: true });
      if (options.signal?.aborted) onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }),
  ]);
  clearTimeout(timer);
  if (onAbort) options.signal?.removeEventListener("abort", onAbort);
  if ("url" in outcome) {
    return {
      name: options.name,
      project: options.project,
      url: outcome.url,
      ...(child.pid !== undefined && { pid: child.pid }),
      token,
      startedAt: new Date((io.now ?? Date.now)()).toISOString(),
      exited,
      stop,
    };
  }
  await stop();
  if ("code" in outcome) {
    throw eveFailed(
      command,
      `eve start exited ${outcome.code} before it listened: ${tail.at(-1) ?? "no output"}`,
      [...tail],
      outcome.code,
    );
  }
  if ("aborted" in outcome) {
    throw new CliError(
      "cancelled",
      `stopped ${options.name} before it listened`,
    );
  }
  throw eveFailed(
    command,
    `eve start did not print its [START] line within ${Math.round((options.startTimeoutMs ?? START_TIMEOUT_MS) / 1000)} s`,
    [...tail],
  );
}

/** `<home>/agents/<first 16 hex of sha256(project)>/<name>.log`. */
export function agentLogPath(
  home: string,
  project: string,
  name: string,
): string {
  const hash = createHash("sha256").update(project).digest("hex").slice(0, 16);
  return join(home, "agents", hash, `${name}.log`);
}

/** The project root holding `dir`, or `dir` itself outside a project. */
export function rootOf(dir: string): string {
  const found = findProject(dir);
  return found === undefined ? dir : dirname(found);
}

/** The agent's folder and env, secrets resolved; `secrets` lists their values to hide. */
export async function runEnvironment(
  ctx: Context,
  io: CliIo,
  name: string,
): Promise<{
  root: string;
  dir: string;
  values: Record<string, string>;
  secrets: string[];
}> {
  const { root, dir, entries } = await agentEnvironment(ctx, io, name, {
    resolve: true,
  });
  const values: Record<string, string> = {};
  const secrets: string[] = [];
  for (const e of entries) {
    if (e.value === undefined) continue;
    values[e.name] = e.value;
    if (e.source === "secret") secrets.push(e.value);
  }
  return { root, dir, values, secrets };
}

/** The daemon's agents: in-process inside the daemon, else over its socket, else none. */
export async function agentControl(
  io: CliIo,
  home: string,
): Promise<AgentControl | undefined> {
  if (io.agents !== undefined) return io.agents;
  const client = await connectDaemon(home, {
    version: cliVersion(),
    warn: (message) => io.stderr.write(`${message}\n`),
  });
  if (client === undefined) return undefined;
  return {
    list: () => client.agents(),
    run: (project, name) => client.runAgent(project, name),
    stop: (project, name) => client.stopAgent(project, name),
  };
}

/** The agents the daemon runs, without a word when there is none (or it refuses). */
export async function runningAgents(
  io: CliIo,
  home: string,
): Promise<AgentInfo[]> {
  if (io.agents !== undefined) return io.agents.list();
  const client = await connectDaemon(home).catch(() => undefined);
  return client === undefined ? [] : client.agents().catch(() => []);
}

export interface RunOptions {
  dev?: boolean;
  json?: boolean;
  project?: string;
}

const leftoverNote = (leftovers: number) =>
  `${leftovers} eve-sbx- sandbox container${leftovers === 1 ? "" : "s"} still running (docker ps --filter name=eve-sbx-)`;

function printStarted(
  io: CliIo,
  agent: AgentInfo,
  options: RunOptions,
  extra: { already?: boolean; foreground?: boolean },
): void {
  const { name, url, pid, token } = agent;
  if (options.json) {
    io.stdout.write(
      `${JSON.stringify(
        {
          agent,
          ...(extra.already !== undefined && { already: extra.already }),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  io.stdout.write(
    `${name} ${extra.already ? "already " : ""}running at ${url}${pid === undefined ? "" : ` (pid ${pid})`}\n` +
      `route token: ${token} (send as Authorization: Bearer)\n` +
      (extra.foreground
        ? "stop with Ctrl-C\n"
        : `stop with donn agent stop ${name}\n`),
  );
}

/** Runs `fn` with `handler` on SIGTERM, SIGINT and SIGHUP, removed afterwards. */
async function withSignals<T>(
  handler: (signal: NodeJS.Signals) => void,
  fn: () => Promise<T>,
): Promise<T> {
  const handlers = SIGNALS.map((s) => [s, () => handler(s)] as const);
  for (const [signal, h] of handlers) process.on(signal, h);
  try {
    return await fn();
  } finally {
    for (const [signal, h] of handlers) process.off(signal, h);
  }
}

/** `donn agent run <name> [--dev]`. */
export async function run(
  io: CliIo,
  name: string,
  options: RunOptions,
): Promise<number> {
  const ctx = await projectContext(io, options.project);
  if (options.dev) return dev(ctx, io, name);
  const control = await agentControl(io, ctx.home);
  if (control !== undefined) {
    const { agent, already } = await control.run(projectRoot(ctx), name);
    printStarted(io, agent, options, { already });
    return 0;
  }
  return foreground(ctx, io, name, options);
}

/** Without a daemon: the agent runs as this process's child until a signal stops it. */
async function foreground(
  ctx: Context,
  io: CliIo,
  name: string,
  options: RunOptions,
): Promise<number> {
  const { root, dir, values, secrets } = await runEnvironment(ctx, io, name);
  const abort = new AbortController();
  let agent: RunningAgent | undefined;
  return withSignals(
    () => {
      abort.abort();
      void agent?.stop();
    },
    async () => {
      agent = await startAgent(io, dir, values, {
        name,
        project: root,
        redact: secrets,
        signal: abort.signal,
        // Under --json, stdout carries only the JSON.
        onLine: (line, stream) =>
          (options.json || stream === "stderr" ? io.stderr : io.stdout).write(
            `${line}\n`,
          ),
      });
      printStarted(io, agent, options, { foreground: true });
      if (abort.signal.aborted) void agent.stop();
      const code = await agent.exited;
      const { leftovers } = await agent.stop();
      if (leftovers > 0)
        io.stderr.write(`warning: ${leftoverNote(leftovers)}\n`);
      return code;
    },
  );
}

/** `--dev`: `eve dev` with eve's terminal UI, in the foreground, never through the daemon. */
async function dev(ctx: Context, io: CliIo, name: string): Promise<number> {
  const { dir, values } = await runEnvironment(ctx, io, name);
  const pm = await packageManager(dir);
  // The model route is proved under eve dev with development, not production (spec 24 §2).
  const env = { ...eveEnv(io.env, values), NODE_ENV: "development" };
  const child = (io.spawn ?? nodeSpawn)(pm, ["exec", "eve", "dev"], {
    cwd: dir,
    env,
    inherit: true,
  });
  // The terminal's Ctrl-C reaches eve dev itself; pass on only what is sent to donn alone.
  return withSignals(
    (signal) => signal !== "SIGINT" && child.kill(signal),
    () => child.exited,
  );
}

/** `donn agent stop <name>`. */
export async function stop(
  io: CliIo,
  name: string,
  options: { json?: boolean; project?: string },
): Promise<number> {
  const ctx = await projectContext(io, options.project);
  const root = projectRoot(ctx);
  const control = await agentControl(io, ctx.home);
  const result =
    control === undefined ? { stopped: false } : await control.stop(root, name);
  if (options.json) {
    io.stdout.write(`${JSON.stringify({ agent: name, ...result }, null, 2)}\n`);
    return 0;
  }
  if (!result.stopped) {
    io.stdout.write(
      `${name} is not running${control === undefined ? " (no daemon; a foreground run stops with Ctrl-C)" : ""}\n`,
    );
    return 0;
  }
  const leftovers = result.leftovers ?? 0;
  io.stdout.write(
    `stopped ${name}${leftovers > 0 ? `; ${leftoverNote(leftovers)}` : ""}\n`,
  );
  return 0;
}

/** `donn agent logs <name> [--follow]`: the daemon run's log; `--follow` tails it. */
export async function logs(
  io: CliIo,
  name: string,
  options: { follow?: boolean; json?: boolean; project?: string },
): Promise<number> {
  const ctx = await projectContext(io, options.project);
  const path = agentLogPath(ctx.home, projectRoot(ctx), name);
  if (!existsSync(path)) {
    throw new CliError(
      "no-agent-log",
      `no log for ${name}: it has not run through the daemon`,
      { log: path, fix: `donn daemon start, then donn agent run ${name}` },
    );
  }
  const print = (line: string) =>
    io.stdout.write(
      options.json ? `${JSON.stringify({ line })}\n` : `${line}\n`,
    );
  if (!options.follow) {
    const text = await readFile(path, "utf8");
    if (options.json) {
      const lines = text.split("\n").filter((line) => line !== "");
      io.stdout.write(
        `${JSON.stringify({ agent: name, log: path, lines }, null, 2)}\n`,
      );
    } else {
      io.stdout.write(text);
    }
    return 0;
  }
  await follow(io, path, print);
  return 0;
}

/** Prints the file's lines, then each line appended, until Ctrl-C (or `io.signal`). */
async function follow(
  io: CliIo,
  path: string,
  print: (line: string) => void,
): Promise<void> {
  const own = io.signal === undefined ? new AbortController() : undefined;
  const signal = io.signal ?? own!.signal;
  const onSignal = () => own?.abort();
  if (own) for (const s of SIGNALS) process.once(s, onSignal);
  let offset = 0;
  let rest = "";
  const pump = async () => {
    const size = (await stat(path).catch(() => undefined))?.size;
    if (size === undefined) return;
    // Rotated: the new file starts from the top.
    if (size < offset) offset = 0;
    if (size === offset) return;
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(size - offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      offset += bytesRead;
      rest += buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) print(line);
  };
  try {
    while (!signal.aborted) {
      await pump();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, FOLLOW_MS);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
      });
    }
  } finally {
    if (own) for (const s of SIGNALS) process.off(s, onSignal);
  }
}
