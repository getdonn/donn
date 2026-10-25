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
import { syncAgent } from "../agent/sync.js";
import type { CliIo } from "../cli.js";
import { CliError } from "../errors.js";
import type { AgentSyncFailure, DaemonEvent } from "./client.js";
import { createLog, type DaemonLog } from "./log.js";

// The daemon's running agents: started with their env resolved, each one's output in its own
// log, stopped on request or when the daemon closes, synced when their persona changes and
// restarted after a sync. Events and logs carry names, projects, URLs, pids, file paths and
// error codes, never the route token or an env value.
// See docs/planning/25-agent-runner.md, sections 3, 4 `local` and 7.

export interface AgentRunnerOptions {
  home: string;
  /** The daemon's in-process io: its env, probe and spawner. */
  io: CliIo;
  emit: (event: DaemonEvent) => void;
  log: DaemonLog;
  now: () => number;
  /** Test seam: the sync of one created agent; `agent sync`'s, never forced, by default. */
  syncAgent?: (
    project: string,
    name: string,
  ) => Promise<{ written: string[]; removed: string[] }>;
}

export interface AgentRunner extends AgentControl {
  /**
   * Syncs a created agent with its persona and restarts it if it runs and files changed. A
   * sync that stops is `agent.sync-failed`, kept for `status` until one succeeds; one of an
   * agent that needs recreating is skipped. One sync of an agent at a time: a call while one
   * runs waits for it, then one more runs for every call that waited.
   */
  sync(project: string, name: string): Promise<void>;
  /** The agents whose last sync stopped, and why. */
  syncFailures(): AgentSyncFailure[];
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

  const syncOf =
    options.syncAgent ??
    (async (project: string, name: string) =>
      syncAgent(await projectContext(io, project), io, name));
  const failures = new Map<string, AgentSyncFailure>();

  /** One at a time per key; calls during one share the single run queued after it. */
  const serial = () => {
    const inFlight = new Map<string, Promise<void>>();
    const queued = new Map<string, Promise<void>>();
    const next = (k: string, work: () => Promise<void>): Promise<void> => {
      const current = inFlight.get(k);
      if (current === undefined) {
        const done = work().finally(() => inFlight.delete(k));
        inFlight.set(k, done);
        return done;
      }
      let after = queued.get(k);
      if (after === undefined) {
        after = current.then(() => {
          queued.delete(k);
          return next(k, work);
        });
        queued.set(k, after);
      }
      return after;
    };
    const settled = async () => {
      while (inFlight.size > 0 || queued.size > 0)
        await Promise.allSettled([...queued.values(), ...inFlight.values()]);
    };
    return { next, settled };
  };
  const syncs = serial();
  const restarts = serial();

  /** Stop, then start as a fresh run would; a start that fails is `agent.failed` (run's). */
  const restart = (project: string, name: string) =>
    restarts.next(key(project, name), async () => {
      if (closing) return;
      const { stopped } = await stop(project, name);
      if (!stopped || closing) return;
      await log(`agent ${name} in ${project} restarting after a sync`);
      await run(project, name).catch(() => undefined);
    });

  const syncOnce = async (project: string, name: string) => {
    if (closing) return;
    const k = key(project, name);
    let changed: { written: string[]; removed: string[] };
    try {
      changed = await syncOf(project, name);
    } catch (error) {
      const code = error instanceof CliError ? error.code : "internal";
      if (code === "recreate-needed") {
        failures.delete(k);
        const field = (error as CliError).details?.field;
        await log(
          `agent ${name} in ${project} not synced: recreate needed (${String(field)})`,
        );
        return;
      }
      failures.set(k, { name, project, code });
      await log(`agent ${name} in ${project} sync failed: ${code}`);
      emit({ type: "agent.sync-failed", name, project, code });
      return;
    }
    failures.delete(k);
    const { written, removed } = changed;
    if (written.length === 0 && removed.length === 0) return;
    await log(
      `agent ${name} in ${project} synced: ${written.length} written, ${removed.length} removed`,
    );
    emit({ type: "agent.synced", name, project, written, removed });
    // Not awaited: a build and start must not hold up the next sync.
    if (running.has(k) || starting.has(k)) void restart(project, name);
  };

  return {
    list: async () => [...running.values()].map((e) => info(e.agent)),
    run,
    stop,
    sync: (project, name) => {
      const root = rootOf(project);
      return syncs.next(key(root, name), () => syncOnce(root, name));
    },
    syncFailures: () => [...failures.values()],
    closeAll: async () => {
      closing = true;
      await syncs.settled();
      await restarts.settled();
      await Promise.allSettled(starting.values());
      await Promise.all(
        [...running.values()].map((e) => stop(e.agent.project, e.agent.name)),
      );
    },
  };
}
