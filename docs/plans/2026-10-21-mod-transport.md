# Mod Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Claude Code mod runs its `zzpersona` commands through the daemon's socket when the
daemon answers, and runs the CLI as today when it does not.

**Architecture:** A `gh stack` on `feature/transport-0-spec`, one layer per task
(`gh stack add feature/transport-<n>-<name>`). The daemon gains `POST /run`, which runs an
allowlisted command in-process through `createCli` with captured output; the mod's `runCli` gets
its `{ exitCode, stdout }` from the daemon first and from `$.process.run` second, then parses as
today.

**Tech Stack:** TypeScript, Node 26, vitest; the Claude Code mod API (`$.http.fetch` with
`socketPath`, `$.fs.read`/`stat`, `$.clock.after`). No new dependencies.

**Spec:** `docs/planning/15-mod-transport.md`

## Global Constraints

- Endpoint `POST /run`, body `{ argv: string[], cwd: string }`, answer `200 { exitCode, stdout,
  stderr }`. Errors `{ error: { code, message } }`: `400 bad-request`, `403 not-allowed`,
  `413 too-large` (body over 1 MiB), `401 unauthorized` as every endpoint.
- Allowlist (argv must contain `--json`; the rest exactly one of): `switch`; `switch <persona>`;
  `switch <persona> --default`; `switch --clear`; `switch --clear --default`; `list`;
  `live <persona> --session <abs dir>`; `live --show --session <abs dir>`. Flags may come in any
  order; nothing else is accepted.
- The mod's request: `POST http://zzpersona/run` with `socketPath`, header
  `authorization: Bearer <token>`, raced with 1500 ms.
- Copy, verbatim: `zzpersona unavailable: start the daemon (zzpersona daemon start), or allow the
  mod to run zzpersona`.
- The per-turn `live.json` read, the band, the nudge and every parse stay as they are.
- Every layer passes `pnpm turbo run build check-types lint test` and `pnpm format:check`; commits
  end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Tests never touch the real
  `~/.zzpersona` or `~/.claude`.

## Review Focus

1. Argument smuggling: `["switch", "--json", "--force"]`, `["list", "extra"]`, `["live", "x",
   "--session", "rel/dir"]`, `["switch", "--clear", "team/x"]`, `["switch", "a", "b"]` → 403 →
   Task 1 test "refuses argv outside the allowlist".
2. A `/run` command that throws inside `createCli` (not a CliError) → `200 { exitCode: 1 }` with
   the error text, never a hung request or a crashed daemon → Task 1 test "answers a command that
   throws".
3. The mod's daemon request never settling (wedged daemon) → the CLI runs after 1500 ms and the
   late answer is ignored → Task 2 test "falls back after 1.5 s".
4. A `where` file pointing to a path that is a symlink → no token sent, CLI used → Task 2 test
   "sends no token to a link".
5. `cwd` that exists but is a file → 400 → Task 1 test "refuses a cwd that is not a directory".

---

### Task 1: `POST /run` (`feature/transport-1-daemon`)

**Files:** Create `src/apps/cli/src/daemon/run.ts`, `src/apps/cli/src/daemon-run.test.ts`.
Modify `src/apps/cli/src/daemon/server.ts` (route, body reading with the 1 MiB cap).

**Interfaces (produces):**
```ts
// daemon/run.ts
export function allowedRun(argv: readonly string[]): boolean;
export interface RunResult { exitCode: number; stdout: string; stderr: string }
export function runInProcess(io: Omit<CliIo, "cwd" | "stdout" | "stderr">, argv: string[], cwd: string): Promise<RunResult>;
```
`runInProcess` builds a `CliIo` with captured `stdout`/`stderr` and the daemon's `env` (its
`ZZPERSONA_HOME`), `probe`, `now`; calls `createCli(io).run(argv)`; a throw becomes
`{ exitCode: 1, stdout: "", stderr: <message> }`.

- [ ] **Step 1: Failing tests** (in-process `startDaemon`, seeded home as `daemon.test.ts`):
  `it("runs each allowed form and answers what the CLI prints")` — for `["list","--json"]`,
  `["switch","--json"]` in the seeded repo, compare `exitCode` and `JSON.parse(stdout)` with
  `zz([...])` in the same cwd; `it("refuses argv outside the allowlist")` — `claude`, `write`,
  `daemon stop`, and the Review Focus 1 cases → 403 `not-allowed`; `it("refuses a cwd that is not
  a directory")` (relative, missing, a file) → 400; `it("refuses a body over 1 MiB")` → 413;
  `it("answers a command that throws")` (inject a probe whose `run` throws for `list`'s path, or a
  persona store that throws) → 200 with `exitCode: 1`; no token → 401;
  `it("takes the session lock for live")` — a `live` through `/run` and `daemon.refresh()` at once
  leave `live.json` and `plugins/` consistent (one persona's files).
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/cli exec vitest run src/daemon-run.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Route `POST /run` after the token check; read the body as text up to
  1 MiB, parse JSON, validate, `allowedRun`, `runInProcess`.
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): the daemon runs the mod's commands (POST /run)`.

### Task 2: The mod uses the daemon (`feature/transport-2-mod`)

**Files:** Create `src/packages/mod-claude-code/src/transport.ts`, `src/transport.test.ts`.
Modify `src/cli.ts` (`runCli` gets its output from `transport.ts`), `src/api.ts` (`http`,
`clock`, `fs.stat` in `Mod$`), `src/register.test.ts` (fake host: `http`, `clock`, `fs.stat`),
`src/decide.ts` (the unavailable copy).

**Interfaces (produces):**
```ts
// transport.ts
export const DAEMON_TIMEOUT_MS = 1500;
export interface Output { exitCode: number; stdout: string }
/** The command's output from the daemon, or undefined when the daemon cannot answer. */
export function viaDaemon($: Mod$, argv: string[], cwd: string): Promise<Output | undefined>;
```
`viaDaemon`: home from `$.env.get("ZZPERSONA_HOME")` else `${HOME}/.zzpersona`; socket from
`<home>/daemon/where` else `<home>/daemon/sock`; `$.fs.stat(socket)` must be `kind: "other"`,
`isLink: false`; token from `<home>/daemon/token`; `$.http.fetch("http://zzpersona/run", { method:
"POST", socketPath, headers, body })` raced with `$.clock.after(DAEMON_TIMEOUT_MS)`; on 401 read the
token again and retry once; any failure → `undefined`. `runCli` calls `viaDaemon` first (argv with
`--json` appended as today), then `$.process.run`; when `viaDaemon` returned `undefined` and
`process.run` is refused, the reason is the unavailable copy.

- [ ] **Step 1: Failing tests** (fake host): `it("uses the daemon and runs no process")`;
  `it("falls back to the CLI")` for no `where`/`sock`, a refused fetch (rejects), a 500, a second
  401; `it("retries once with a re-read token")`; `it("falls back after 1.5 s")` (fetch never
  settles; the fake clock fires; `process.run` called; a late answer changes nothing);
  `it("sends no token to a link")` and to a plain file; `it("says how to fix it when both fail")`
  (no daemon, `process.run` rejects as a policy refusal) → `/persona list` prints the copy.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/mod-claude-code exec vitest run` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` and `claude plugin validate
  src/packages/mod-claude-code/dist/mod` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(mod-claude-code): ask the daemon first, the CLI second`.

### Task 3: E2e, smoke and docs (`feature/transport-3-e2e-docs`)

**Files:** Modify `src/apps/cli/src/e2e.test.ts`, `README.md`, `CLAUDE.md`,
`docs/planning/09-mod-claude-code.md` (dated answer to open question 3), `docs/planning/15-mod-transport.md`
(amendments with the smoke result). Create `.changeset/mod-transport.md` (minor `@zzpersona/cli`,
minor `@zzpersona/mod-claude-code`).

- [ ] **Step 1: E2e (`ZZP_E2E=1`)** `it("serves the mod's commands over the socket")`: the built
  binary's daemon in a scratch home; `POST /run` (via `daemonRequest`) for `["list","--json"]` and
  `["switch","--json"]` equals the binary's own output; `daemon stop`.
- [ ] **Step 2: Run** it — Expected: PASS.
- [ ] **Step 3: Smoke (controller, herdr, before the final review):** scratch home and daemon; a
  scratch Claude Code launched by `zzpersona claude` with `--plugin-dir <dev mod>` and a second
  throwaway `--plugin-dir` mod whose `process.run` hook returns `{ deny }`; `/persona list`,
  `/persona use <other>` and the band work; daemon stopped → `/persona list` shows the unavailable
  copy. Recorded in spec 15's amendments.
- [ ] **Step 4: Docs; run** the full pipeline and `pnpm format:check` — Expected: PASS.
- [ ] **Step 5: Commit** `test: mod transport e2e; docs`.
