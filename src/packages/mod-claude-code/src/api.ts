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
  /** Missing on an older Claude Code: callers wrap its use in try/catch. */
  fs: {
    /** A file's text; rejects when it is missing. */
    read(path: string): Promise<string>;
    /** What a path leads to (a link followed); rejects when it is missing. */
    stat(path: string): Promise<{
      kind: "file" | "dir" | "other";
      isLink: boolean;
    }>;
  };
  /** Missing on an older Claude Code. */
  http?: {
    /** Resolves once the body is read, any status; it has no timeout. */
    fetch(
      url: string,
      init?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        /** A Unix socket to go over instead of TCP. */
        socketPath?: string;
      },
    ): Promise<{ status: number; ok: boolean; text: string }>;
  };
  /** Missing on an older Claude Code. */
  clock?: {
    /** Calls `fn` once after `ms` milliseconds; `cancel()` before then stops it. */
    after(ms: number, fn: () => void): { cancel(): void };
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
