import type { RunResult, Runner } from "../run.js";

type Opts = Parameters<Runner>[2];
type Handler = [
  match: (cmd: string, args: string[]) => boolean,
  reply: RunResult | ((cmd: string, args: string[], opts: Opts) => RunResult),
];

/** A scripted Runner: first matching handler answers; no match throws. */
export function fakeRunner(
  handlers: Handler[],
): Runner & { calls: Array<{ cmd: string; args: string[]; opts: Opts }> } {
  const calls: Array<{ cmd: string; args: string[]; opts: Opts }> = [];
  const runner: Runner = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const hit = handlers.find(([match]) => match(cmd, args));
    if (!hit) {
      return Promise.reject(
        new Error(`fakeRunner: no handler for ${cmd} ${args.join(" ")}`),
      );
    }
    const [, reply] = hit;
    return Promise.resolve(
      typeof reply === "function" ? reply(cmd, args, opts) : reply,
    );
  };
  return Object.assign(runner, { calls });
}
