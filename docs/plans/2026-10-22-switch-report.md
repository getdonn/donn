# Switch Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After saving a choice, `zzpersona switch` prints one line per harness: what it keeps and
drops, which sessions here still run another persona, and what the committed `AGENTS.md` carries.

**Architecture:** A `gh stack` on `feature/switch-0-spec` (`gh stack add feature/switch-<n>-<name>`).
A new `src/apps/cli/src/switch-report.ts` compiles each harness in-process through `prepareBuild`
(new `quiet` option), asks a running daemon for its sessions, and checks the `AGENTS.md` block;
`commands/switch.ts` calls it after saving.

**Tech Stack:** TypeScript, Node 26, vitest. No new dependencies.

**Spec:** `docs/planning/17-switch-report.md`

## Global Constraints

- The report runs after `switch <persona>` and `switch --clear` save; never for `switch` (show) or
  `switch --default` (show). Exit code 0 once the choice is saved, whatever the report says.
- Harnesses: built-in and config-loaded adapters whose `detect` says installed; `agents-md` only
  when the project's `AGENTS.md` has a zzpersona block. `--harness <id>` limits to one; unknown id →
  the existing `unknown-harness` error from `findAdapter`.
- Line format: `<id padded to the longest id + 2>` then `ok`, `drops <groups>` or
  `error <message>`, then ` · <sessions text>` when sessions apply. Groups: report entries grouped
  by the first segment of `path` (up to `.` or `[`), `<field> (<n>)` for `dropped`,
  `<field> (<n> approximated)` for `approximated`/`advisory`, joined by `, `, in report order.
- Sessions text: `<n> session(s) here still run(s) <persona>: <fix>`; fix `/persona use <p>` for
  `claude-code`, `relaunch with zzpersona codex` for `codex`. Counted only when the switch's scope is
  the project, the daemon answers, and the session's `project` is this project's repo folder and its
  persona (`live ?? launched`) is not the new choice. Several old personas: name the first, then
  `and others`.
- agents-md text: `AGENTS.md carries project/persona (shared); <p> applies to zzpersona launches
  only` (status `shared`) when the choice is not `project/persona`, else `ok`; append
  ` — zzpersona write` when `applyOverlay(..., { mode: "check" })` says `stale`.
- `--json`: the existing object plus `harnesses: [{ id, status, dropped, sessions?, message?, fix? }]`
  (`status` ∈ `ok | drops | error | shared`; `dropped` the group strings; `sessions` `{ count, fix }`).
- Resolve warnings print once (from the switch's own resolve), never per harness.
- Every layer passes `pnpm turbo run build check-types lint test` and `pnpm format:check`; commits
  end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Tests never touch the real
  `~/.zzpersona` or `~/.claude`.

## Review Focus

1. A third-party adapter whose `detect` or `compile` throws → that line is `error`, other harnesses
   still report, the choice is saved, exit 0 → Task 1 test "a failing adapter does not undo the
   switch".
2. `switch X --default` inside a project that has its own switch → no sessions counted (X does not
   apply here) → Task 1 test "a default switch counts no sessions".
3. A daemon that refuses the token or is unresponsive → the report goes on without `sessions`, no
   error, within the client's normal timeout → Task 1 test "a refusing daemon leaves out sessions".
4. `switch --clear` leaving no persona at all (no default) → no report lines, exit 0 → Task 1 test
   "clearing to nothing reports nothing".
5. `switch X --json` through the daemon's `POST /run` (the daemon asks itself for sessions) →
   answers 200 within 5 s → Task 1 test "switch through /run reports".

---

### Task 1: The report (`feature/switch-1-report`)

**Files:** Create `src/apps/cli/src/switch-report.ts`, `src/apps/cli/src/switch-report.test.ts`.
Modify `build.ts` (`prepareBuild` option `quiet?: boolean` skips `printWarnings`),
`commands/switch.ts` (call after saving; print; `--json`), `cli.ts` (`switch --harness <id>`).

**Interfaces (produces):**
```ts
export interface HarnessResult {
  id: string;
  status: "ok" | "drops" | "error" | "shared";
  dropped: string[];
  sessions?: { count: number; fix: string };
  message?: string;
  fix?: string;
}
export async function harnessReport(
  io: CliIo, ctx: Context, selection: Selection,
  options: { only?: string; countSessions: boolean },
): Promise<HarnessResult[]>;
export function reportLines(results: HarnessResult[], persona: string): string[];
```

- [ ] **Step 1: Failing tests** in `switch-report.test.ts` (seeded home as `switch.test.ts`, probes
  as `codex.test.ts`/`capabilities.test.ts`):
  `it("reports ok and drops per installed harness")` — claude-code and codex installed, a persona
  with hooks and knowledge → codex line `drops hooks (2), knowledge (1 approximated)` (adjust to the
  fixture's real report) and JSON `harnesses` matching; `it("skips a harness that is not
  installed")`; `it("a failing adapter does not undo the switch")` (a test plugin adapter whose
  compile throws: line `error <message>`, state.json has the choice, exit 0);
  `it("--harness limits the report")` and `--harness nope` → `unknown-harness`;
  `it("agents-md says what AGENTS.md carries")` — no block → no line; block present, choice
  `team/x` → `shared` text; block out of date → ` — zzpersona write`; choice `project/persona` and
  block current → `ok`; `it("counts sessions here on another persona")` — in-process daemon
  (`startDaemon`) with a claude-code and a codex session registered for this repo on the old persona
  → both lines carry the sessions text and fixes; `it("a default switch counts no sessions")`;
  `it("a refusing daemon leaves out sessions")`; `it("prints resolve warnings once")`;
  `it("clearing reports for the persona that now applies")` and
  `it("clearing to nothing reports nothing")`; `it("switch through /run reports")` (`POST /run`
  with `["switch","team/x","--json"]` → 200, `harnesses` present, under 5 s);
  `it("show forms report nothing")`.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/cli exec vitest run src/switch-report.test.ts` —
  Expected: FAIL.
- [ ] **Step 3: Implement.** For `--clear`, re-create the context after saving and
  `selectPersona(undefined, ctx)`; `no-persona` → no report. Sessions via `connectDaemon(home)` in a
  try/catch (any throw → no sessions).
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): switch reports per harness`.

### Task 2: Docs (`feature/switch-2-docs`)

**Files:** Modify `README.md` (the switch section: the report, `--harness`), `CLAUDE.md` (reading
list item 17; status paragraph: Phase 2's roadmap items built), `docs/planning/03-architecture.md`
(open question 2: dated 2026-10-22 answer — per harness, reported, the choice kept),
`docs/planning/04-roadmap.md` (dated note on the `switch --harness all` item: built as spec 17, one
choice with per-harness results), `docs/planning/17-switch-report.md` (amendments from Task 1 and
the check run). Create `.changeset/switch-report.md` (minor `@zzpersona/cli`).

- [ ] **Step 1: Check run (controller):** the built CLI in `examples/demo-app` with the real
  `claude`, `codex` if installed, and the user's daemon: `switch team/web`, read the lines, then
  `switch --clear`; record the output in spec 17's amendments.
- [ ] **Step 2: Docs.** Prose wrapped at 100.
- [ ] **Step 3: Run** the full pipeline and `pnpm format:check` — Expected: PASS.
- [ ] **Step 4: Commit** `docs: switch report`.
