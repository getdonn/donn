import { constants } from "node:os";
import type { Spawn, SpawnOptions } from "../agent/spawn.js";

// Test-only: a Spawn that plays a script instead of running a process, for the agent
// commands that drive the project's own eve.

export interface FakeEveCall {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  detached?: boolean;
  inherit?: boolean;
  /** The signals sent through the handle's `kill`, in order. */
  kills: NodeJS.Signals[];
  /** The handle's `alive()`: whether the process, or its lingering group, still runs. */
  alive: () => boolean;
}

export interface FakeEveReply {
  /** Matches when these are the arguments right after `eve` (a prefix); omit to match all. */
  eve?: string[];
  /** Or any predicate on the call; both must hold when both are given. */
  when?: (call: FakeEveCall) => boolean;
  /** Output lines; a string is stdout. */
  lines?: (string | { line: string; stream: "stdout" | "stderr" })[];
  exitCode?: number;
  /** Keep running after the lines until killed (a server); the exit code is 128 + the signal. */
  hold?: boolean;
  /** With `hold`: signals recorded but not obeyed, as by a process that traps them. */
  ignore?: NodeJS.Signals[];
  /** With `hold`: also exits on its own, with this code, once it settles. */
  until?: Promise<number>;
  /**
   * After the process exits, its group (the server under `pnpm exec`) runs on for this many
   * ms, or until a SIGKILL; `alive()` reports it.
   */
  linger?: number | "until-kill";
  /** Side effects, e.g. writing `.output/` or the files `eve init` creates into `call.cwd`. */
  effect?: (call: FakeEveCall) => void | Promise<void>;
}

export interface FakeEveScript {
  replies: FakeEveReply[];
  /** For a call nothing matches; defaults to exit 0 with no output. */
  fallback?: Omit<FakeEveReply, "eve" | "when">;
}

export type FakeEve = Spawn & { calls: FakeEveCall[] };

function matches(reply: FakeEveReply, call: FakeEveCall): boolean {
  if (reply.eve) {
    const at = call.args.indexOf("eve");
    const rest = at === -1 ? call.args : call.args.slice(at + 1);
    if (!reply.eve.every((a, i) => rest[i] === a)) return false;
  }
  return reply.when ? reply.when(call) : true;
}

/** The first matching reply plays on each call; every call is recorded in `.calls`. */
export function fakeEve(script: FakeEveScript = { replies: [] }): FakeEve {
  const calls: FakeEveCall[] = [];
  let pids = 90_000;
  const spawn = (command: string, args: string[], options: SpawnOptions) => {
    const call: FakeEveCall = {
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      ...(options.stdin !== undefined && { stdin: options.stdin }),
      ...(options.detached && { detached: true }),
      ...(options.inherit && { inherit: true }),
      kills: [],
      alive: () => !groupGone,
    };
    calls.push(call);
    const reply =
      script.replies.find((r) => matches(r, call)) ?? script.fallback ?? {};
    let killed: number | undefined;
    let finish: ((code: number) => void) | undefined;
    let groupGone = false;
    const exited = (async () => {
      await reply.effect?.(call);
      for (const entry of reply.lines ?? []) {
        if (typeof entry === "string") options.onLine?.(entry, "stdout");
        else options.onLine?.(entry.line, entry.stream);
      }
      if (!reply.hold) return reply.exitCode ?? 0;
      void reply.until?.then((code) => finish?.((killed ??= code)));
      return killed ?? new Promise<number>((resolve) => (finish = resolve));
    })().then((code) => {
      if (reply.linger === undefined) groupGone = true;
      else if (typeof reply.linger === "number")
        setTimeout(() => (groupGone = true), reply.linger);
      return code;
    });
    return {
      pid: reply.hold ? ++pids : undefined,
      exited,
      alive: () => call.alive(),
      kill: (signal: NodeJS.Signals = "SIGTERM") => {
        call.kills.push(signal);
        if (signal === "SIGKILL") groupGone = true;
        if (!reply.hold || reply.ignore?.includes(signal)) return;
        killed ??= 128 + (constants.signals[signal] ?? 1);
        finish?.(killed);
      },
    };
  };
  return Object.assign(spawn, { calls });
}
