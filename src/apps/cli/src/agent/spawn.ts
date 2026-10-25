import { spawn as nodeChildSpawn } from "node:child_process";
import { constants } from "node:os";

// A process spawner with line-by-line output, injectable as CliIo.spawn. The agent
// commands drive the agent project's own eve through it. See docs/planning/25-agent-runner.md.

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Called for every output line, in arrival order; a final line without a newline counts. */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  /** Start in its own process group, so `kill` reaches the whole tree. */
  detached?: boolean;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
}

export interface SpawnHandle {
  pid: number | undefined;
  /** The exit code; a process that dies of a signal resolves to 128 plus the signal number. */
  exited: Promise<number>;
  /** Signals the process, or its whole group when it was spawned `detached`. */
  kill(signal?: NodeJS.Signals): void;
}

export type Spawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => SpawnHandle;

/** Splits a stream into lines, holding back a partial one until its newline (or the end). */
function lineSplitter(emit: (line: string) => void) {
  let rest = "";
  return {
    push(chunk: string) {
      rest += chunk;
      const lines = rest.split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const line of lines) emit(line);
    },
    end() {
      if (rest !== "") emit(rest);
      rest = "";
    },
  };
}

/** The default Spawn: node:child_process. A command that cannot start resolves to 127. */
export const nodeSpawn: Spawn = (command, args, options) => {
  const child = nodeChildSpawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached === true,
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const onLine = options.onLine;
  const out = lineSplitter((l) => onLine?.(l, "stdout"));
  const err = lineSplitter((l) => onLine?.(l, "stderr"));
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => out.push(d));
  child.stderr?.on("data", (d: string) => err.push(d));
  if (options.stdin !== undefined) {
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.stdin);
  }
  const exited = new Promise<number>((resolve) => {
    child.on("error", (error) => {
      onLine?.(error.message, "stderr");
      resolve(127);
    });
    child.on("close", (code, signal) => {
      out.end();
      err.end();
      resolve(code ?? (signal ? 128 + signalNumber(signal) : 1));
    });
  });
  return {
    pid: child.pid,
    exited,
    kill(signal = "SIGTERM") {
      try {
        if (options.detached && child.pid !== undefined) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // Already gone.
      }
    },
  };
};

function signalNumber(signal: NodeJS.Signals): number {
  return constants.signals[signal] ?? 1;
}
