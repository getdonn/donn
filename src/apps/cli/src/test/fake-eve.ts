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
}

export interface FakeEveReply {
  /** Matches when these are the arguments right after `eve` (a prefix); omit to match all. */
  eve?: string[];
  /** Or any predicate on the call; both must hold when both are given. */
  when?: (call: FakeEveCall) => boolean;
  /** Output lines; a string is stdout. */
  lines?: (string | { line: string; stream: "stdout" | "stderr" })[];
  exitCode?: number;
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
  const spawn = (command: string, args: string[], options: SpawnOptions) => {
    const call: FakeEveCall = {
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      ...(options.stdin !== undefined && { stdin: options.stdin }),
      ...(options.detached && { detached: true }),
    };
    calls.push(call);
    const reply =
      script.replies.find((r) => matches(r, call)) ?? script.fallback ?? {};
    const exited = (async () => {
      await reply.effect?.(call);
      for (const entry of reply.lines ?? []) {
        if (typeof entry === "string") options.onLine?.(entry, "stdout");
        else options.onLine?.(entry.line, entry.stream);
      }
      return reply.exitCode ?? 0;
    })();
    return {
      pid: undefined,
      exited,
      kill: () => undefined,
    };
  };
  return Object.assign(spawn, { calls });
}
