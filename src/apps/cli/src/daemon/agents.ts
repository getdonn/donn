import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { agentEnvironment, envInputs } from "../agent/env.js";
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
import { CliError, errorEnvelope } from "../errors.js";
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
  /** What its env was made from at start (envInputs): a change restarts it. */
  inputs: string;
  stopping: boolean;
}

/**
 * A secret the env provider could not resolve, in the daemon: its environment is the service's,
 * which carries none of the user's shell exports (spec 16), so the fix names that cause.
 */
function daemonSecretFix(error: unknown, name: string): unknown {
  if (!(error instanceof CliError) || error.code !== "secret-unresolved")
    return error;
  const failures = (error.details["failures"] ?? []) as { type?: string }[];
  if (!failures.some((f) => f.type === "env")) return error;
  return new CliError(error.code, error.message, {
    ...error.details,
    fix: `the daemon resolves secrets in its own environment, which has no shell exports: use the keychain provider for this ref, or run \`donn agent run ${name}\` with the daemon stopped`,
  });
}

const key = (project: string, name: string) => `${project}\0${name}`;

/**
 * One piece of work at a time per key. A call while one runs waits for it, and every such call
 * shares the one run queued after it; work that fails does not stop the queue.
 */
export function serial() {
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
      after = current
        .catch(() => undefined)
        .then(() => {
          queued.delete(k);
          return next(k, work);
        });
      queued.set(k, after);
    }
    return after;
  };
  /** Settles once nothing runs or waits; each await is on work, never a spin. */
  const settled = async () => {
    while (inFlight.size > 0 || queued.size > 0)
      await Promise.allSettled([...queued.values(), ...inFlight.values()]);
  };
  return { next, settled };
}

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
    Promise<{
      agent: RunningAgent;
      flushed: () => Promise<void>;
      inputs: string;
    }>
  >();
  let closing = false;

  const launch = async (project: string, name: string) => {
    const ctx = await projectContext(io, project);
    const { root, dir, values, secrets, inputs } = await runEnvironment(
      ctx,
      io,
      name,
      { start: true },
    ).catch((error: unknown) => {
      throw daemonSecretFix(error, name);
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
    return { agent, flushed: () => last, inputs };
  };

  const watch = (k: string, entry: Entry) => {
    const { agent } = entry;
    void agent.exited.then(async (exitCode) => {
      if (entry.stopping) return;
      running.delete(k);
      // What it left of its group, and its sandbox containers.
      const { leftovers, exited } = await agent.stop();
      await entry.flushed();
      await log(`agent ${agent.name} in ${agent.project} exited ${exitCode}`);
      emit({
        type: "agent.failed",
        name: agent.name,
        project: agent.project,
        exitCode,
        leftovers,
        exited,
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
      const { agent, flushed, inputs } = await started;
      const entry: Entry = { agent, flushed, inputs, stopping: false };
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
      const known = errorEnvelope(error);
      const code = known?.code ?? "internal";
      const message =
        known?.message ??
        (error instanceof Error ? error.message : String(error));
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
    const { leftovers, exited } = await entry.agent.stop();
    await entry.flushed();
    running.delete(k);
    const { agent } = entry;
    await log(
      `agent ${name} in ${agent.project} stopped${leftovers > 0 ? `, ${leftovers} eve-sbx- containers still running` : ""}${exited > 0 ? `, ${exited} stopped eve-sbx- containers kept` : ""}`,
    );
    emit({
      type: "agent.stopped",
      name,
      project: agent.project,
      leftovers,
      exited,
    });
    return { stopped: true, leftovers, exited };
  };

  const syncOf =
    options.syncAgent ??
    (async (project: string, name: string) =>
      syncAgent(await projectContext(io, project), io, name));
  const failures = new Map<string, AgentSyncFailure>();
  const syncs = serial();
  const restarts = serial();
  /** Agents a sync wrote files for since their last restart. */
  const filesChanged = new Set<string>();

  /** The env inputs the persona gives the agent now; undefined when they cannot be read. */
  const currentInputs = async (project: string, name: string) => {
    try {
      const ctx = await projectContext(io, project);
      const env = await agentEnvironment(ctx, io, name, { resolve: false });
      return envInputs(env.entries);
    } catch (error) {
      const code = errorEnvelope(error)?.code ?? "internal";
      await log(`agent ${name} in ${project} env not read: ${code}`);
      return undefined;
    }
  };

  /**
   * After a sync: a running agent is stopped and started as a fresh run would be when the sync
   * wrote its files or its env inputs differ from those it started with. A start that fails is
   * `agent.failed` (run's).
   */
  const restart = (project: string, name: string) =>
    restarts.next(key(project, name), async () => {
      const k = key(project, name);
      // One still starting may have started from the files before this sync.
      await starting.get(k)?.catch(() => undefined);
      const entry = running.get(k);
      const wrote = filesChanged.delete(k);
      if (closing || entry === undefined) return;
      if (!wrote) {
        const inputs = await currentInputs(project, name);
        if (inputs === undefined || inputs === entry.inputs) {
          await log(`agent ${name} in ${project} kept running: env unchanged`);
          return;
        }
      }
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
      const code = errorEnvelope(error)?.code ?? "internal";
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
    const wrote = written.length > 0 || removed.length > 0;
    if (wrote) {
      await log(
        `agent ${name} in ${project} synced: ${written.length} written, ${removed.length} removed`,
      );
      emit({ type: "agent.synced", name, project, written, removed });
    }
    if (!running.has(k) && !starting.has(k)) return;
    if (wrote) filesChanged.add(k);
    // Not awaited: a build and start must not hold up the next sync.
    void restart(project, name);
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
