import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { projectContext } from "../agent/load.js";
import {
  agentLogPath,
  rootOf,
  runEnvironment,
  startAgent,
  type AgentControl,
  type AgentInfo,
  type RunningAgent,
} from "../agent/run.js";
import type { CliIo } from "../cli.js";
import { CliError } from "../errors.js";
import type { DaemonEvent } from "./client.js";
import { createLog, type DaemonLog } from "./log.js";

// The daemon's running agents: started with their env resolved, each one's output in its own
// log, stopped on request or when the daemon closes. Events and logs carry names, projects,
// URLs and pids, never the route token or an env value.
// See docs/planning/25-agent-runner.md, sections 4 `local` and 7.

export interface AgentRunnerOptions {
  home: string;
  /** The daemon's in-process io: its env, probe and spawner. */
  io: CliIo;
  emit: (event: DaemonEvent) => void;
  log: DaemonLog;
  now: () => number;
}

export interface AgentRunner extends AgentControl {
  /** Stops every running agent, and any still starting; later runs are refused. */
  closeAll(): Promise<void>;
}

interface Entry {
  agent: RunningAgent;
  /** Settles once the lines written so far are in the agent's log. */
  flushed: () => Promise<void>;
  stopping: boolean;
}

const key = (project: string, name: string) => `${project}\0${name}`;

const info = (a: RunningAgent): AgentInfo => ({
  name: a.name,
  project: a.project,
  url: a.url,
  ...(a.pid !== undefined && { pid: a.pid }),
  startedAt: a.startedAt,
  token: a.token,
});

export function agentRunner(options: AgentRunnerOptions): AgentRunner {
  const { io, emit, log } = options;
  const running = new Map<string, Entry>();
  const starting = new Map<
    string,
    Promise<{ agent: RunningAgent; flushed: () => Promise<void> }>
  >();
  let closing = false;

  const launch = async (project: string, name: string) => {
    const ctx = await projectContext(io, project);
    const { root, dir, values, secrets } = await runEnvironment(ctx, io, name, {
      start: true,
    });
    const path = agentLogPath(options.home, root, name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const agentLog = createLog(path, options.now);
    let last = Promise.resolve();
    const agent = await startAgent(io, dir, values, {
      name,
      project: root,
      redact: secrets,
      onLine: (line) => void (last = agentLog(line)),
    });
    return { agent, flushed: () => last };
  };

  const watch = (k: string, entry: Entry) => {
    const { agent } = entry;
    void agent.exited.then(async (exitCode) => {
      if (entry.stopping) return;
      running.delete(k);
      // What it left of its group, and its sandbox containers.
      const { leftovers } = await agent.stop();
      await entry.flushed();
      await log(`agent ${agent.name} in ${agent.project} exited ${exitCode}`);
      emit({
        type: "agent.failed",
        name: agent.name,
        project: agent.project,
        exitCode,
        leftovers,
      });
    });
  };

  const run: AgentControl["run"] = async (project, name) => {
    if (closing) {
      throw new CliError("daemon-stopping", "the daemon is stopping");
    }
    const root = rootOf(project);
    const k = key(root, name);
    const on = running.get(k);
    if (on !== undefined) return { agent: info(on.agent), already: true };
    const pending = starting.get(k);
    if (pending !== undefined) {
      return { agent: info((await pending).agent), already: true };
    }
    const started = launch(root, name);
    starting.set(k, started);
    try {
      const { agent, flushed } = await started;
      const entry: Entry = { agent, flushed, stopping: false };
      running.set(k, entry);
      watch(k, entry);
      await log(`agent ${name} in ${root} running at ${agent.url}`);
      emit({
        type: "agent.started",
        name,
        project: root,
        url: agent.url,
        ...(agent.pid !== undefined && { pid: agent.pid }),
        startedAt: agent.startedAt,
      });
      return { agent: info(agent), already: false };
    } catch (error) {
      const code = error instanceof CliError ? error.code : "internal";
      const message = error instanceof Error ? error.message : String(error);
      await log(`agent ${name} in ${root} failed: ${code}`);
      emit({ type: "agent.failed", name, project: root, code, message });
      throw error;
    } finally {
      starting.delete(k);
    }
  };

  const stop: AgentControl["stop"] = async (project, name) => {
    const k = key(rootOf(project), name);
    // A start in flight finishes first, so it can be stopped.
    await starting.get(k)?.catch(() => undefined);
    const entry = running.get(k);
    if (entry === undefined) return { stopped: false };
    entry.stopping = true;
    const { leftovers } = await entry.agent.stop();
    await entry.flushed();
    running.delete(k);
    const { agent } = entry;
    await log(
      `agent ${name} in ${agent.project} stopped${leftovers > 0 ? `, ${leftovers} eve-sbx- containers left` : ""}`,
    );
    emit({
      type: "agent.stopped",
      name,
      project: agent.project,
      leftovers,
    });
    return { stopped: true, leftovers };
  };

  return {
    list: async () => [...running.values()].map((e) => info(e.agent)),
    run,
    stop,
    closeAll: async () => {
      closing = true;
      await Promise.allSettled(starting.values());
      await Promise.all(
        [...running.values()].map((e) => stop(e.agent.project, e.agent.name)),
      );
    },
  };
}
