// The part of Claude Code's mods API this mod uses (types for v2.1.306). The mod bundles no
// runtime dependencies; the engine supplies `$`, `on` and the global `h`.
// See docs/planning/09-mod-claude-code.md and the engine's own claude-code.d.ts.

export interface ProcessRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The engine interface a hook receives. */
export interface Mod$ {
  env: { get(name: string): Promise<string | undefined> };
  session: { cwd(): Promise<string> };
  process: {
    /** Resolves for any exit code; rejects when the command cannot start or is refused. */
    run(
      argv: readonly string[],
      init?: { cwd?: string; timeoutMs?: number },
    ): Promise<ProcessRunResult>;
  };
  ui: {
    status(text: string | undefined): void;
    invalidate(event: "ui.render" | "prompt.section"): void;
    resolve(e: unknown): { Box: unknown; Text: unknown };
  };
  /** Missing on an older Claude Code. */
  fs?: {
    /** A file's text; rejects when it is missing. */
    read(path: string): Promise<string>;
  };
  command: {
    register(spec: {
      name: string;
      description: string;
      argumentHint?: string;
    }): Promise<unknown>;
  };
}

export type Next = (e: unknown) => Promise<unknown>;
export type Hook = ($: Mod$, e: never, next: Next) => unknown;
export type On = (
  event: string,
  matcherOrHook: object | Hook,
  hook?: Hook,
) => void;
export interface Options {
  nudge?: boolean;
  band?: boolean;
}

/** Builds an element of the drawing surface; the engine defines it globally. */
export type H = (
  type: unknown,
  props: object | null,
  ...children: unknown[]
) => unknown;
