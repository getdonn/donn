# Live Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/persona switch` and `/persona use` change a running Claude Code session's skills, hooks,
agents and instructions without a restart, and say what stays as launched.

**Architecture:** A `gh stack` on `feature/live-0-spec`, one layer per task
(`gh stack add feature/live-<n>-<name>`). `zzpersona claude` launches with a per-session folder of
plugins; `zzpersona live` swaps the persona plugin inside it and records the live state; the mod
adds a superseding `prompt.compose` section and shows what is held.

**Tech Stack:** TypeScript, pnpm, turborepo, vitest, Claude Code mods API (v2.1.306).

**Spec:** `docs/planning/10-live-switching.md`

## Global Constraints

- Nothing is written into the user's repo or Claude Code settings; the CLI writes only under
  `<home>/sessions/` and `<home>/build/`.
- Instructions heading, verbatim: `## zzpersona persona: <ref>` as the first line of
  `system-prompt.md`.
- Compose section id `zzpersona:live-persona`, scope `session`, text verbatim from spec §3.
- Launch variable `ZZPERSONA_SESSION=<home>/sessions/<id>` (with spec 09's three).
- `held` values: `"mcp"`, `"permissions"`; band wording `MCP and permissions`, `MCP`,
  `permissions`.
- Error code `live-unavailable` with the spec's messages: `managed settings block --plugin-dir`,
  `the session folder is gone; relaunch`, and `live switching needs a session started by zzpersona claude`
  (the mod's text when `ZZPERSONA_SESSION` is unset).
- Plugin swap order: copy the new child first, then remove every other child.
- No secret is resolved by `zzpersona live`; builds and `live.json` never hold secret values.
- Every layer passes `pnpm turbo run build check-types lint test` and `pnpm format:check`;
  commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Switching back to the launched persona removes the compose section and the band's `· live`.
   → Task 4 test "switching back to the launched persona drops the section".
2. A failed `zzpersona live` (unknown persona, compile error) leaves the previous child plugin and
   `live.json` untouched. → Task 3 test "a failed switch changes nothing".
3. `zzpersona claude` that fails to launch (non-zero exit, thrown error) still removes its session
   folder. → Task 2 test "removes the session folder even when the launch fails".
4. `held` is empty when the two personas' MCP and permissions are equal even though other fields
   differ. → Task 3 test "holds nothing when MCP and permissions match".
5. A reload of the mod after a switch restores the live section and band from `live.json`.
   → Task 4 test "restores the live state after a reload".

---

### Task 1: Instructions heading (`feature/live-1-adapter`)

**Files:** Modify `src/packages/adapters/claude-code/src/compile.ts` (`systemPrompt`), golden files
in `src/packages/adapters/claude-code/test/golden/`. Test: `src/packages/adapters/claude-code/src/compile.test.ts`.

**Interfaces:** Produces: `system-prompt.md` is always written and starts with
`## zzpersona persona: <personaId>`, followed by a blank line and the existing body when there is
one; `activate` therefore always passes `--append-system-prompt-file`.

- [ ] **Step 1: Failing tests** `it("heads the instructions with the persona")` (full corpus entry:
  first line `## zzpersona persona: project/checkout-api`) and `it("writes the heading when a persona has no instructions")` (minimal entry with no instructions: file is exactly the heading plus `\n`). Update the existing "writes instructions in order…" expectation for the heading.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/adapter-claude-code exec vitest run src/compile.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**, then `vitest run -u` for golden builds; the golden diff may contain only the heading lines and a new `--append-system-prompt-file` argument where a build had no prompt before.
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` — Expected: PASS (fix any CLI test that pinned the old prompt text).
- [ ] **Step 5: Commit** `feat(adapter-claude-code): head the instructions with the persona`.

### Task 2: Session folder (`feature/live-2-session`)

**Files:** Create `src/apps/cli/src/session.ts`, `src/apps/cli/src/session.test.ts`. Modify
`src/apps/cli/src/commands/claude.ts`, `src/packages/executor/src/index.ts` (export `isAlive` from
`./process.js`), `src/apps/cli/src/doctor/checks.ts` (build check's `--fix` also removes orphaned
session folders), `src/apps/cli/src/doctor.test.ts`.

**Interfaces:**
- Produces (`session.ts`):
  ```ts
  interface Launched { persona: string; source: string; pid: number }
  function createSession(home: string, pluginDir: string, launched: Omit<Launched, "pid">, pid: number): Promise<string>; // returns <home>/sessions/<16 hex>, plugin copied to plugins/<basename of the plugin's name>
  function sessionPlugins(sessionDir: string): string; // <dir>/plugins
  function removeSession(sessionDir: string): Promise<void>;
  function findOrphanSessions(home: string, now: number): Promise<string[]>; // older than 24 h (mtime) and pid not alive
  ```
  The child is named after the plugin's manifest `name` (`zzp-team--payments`).
- Produces (`claude.ts`): in relaunch mode (the plan has a `--plugin-dir` argument), after
  `writeBuild` it creates the session from `<buildDir>/plugin`, replaces the `--plugin-dir` value in
  the launch step's args with `sessionPlugins(dir)`, adds `ZZPERSONA_SESSION`, runs the plan, and
  removes the session in a `finally`. `--dry-run` and `--json` create nothing. `launched.json` holds
  `{ persona, source, pid: process.pid }`.

- [ ] **Step 1: Failing tests.** `session.test.ts`: create copies the plugin and writes `launched.json`; `findOrphanSessions` returns a 2-day-old folder with a dead pid, not a fresh one nor an old one with a live pid. `claude.test.ts`: a recorded `runPlan` sees `--plugin-dir <home>/sessions/<id>/plugins` containing `zzp-project--persona/.claude-plugin/plugin.json`, env `ZZPERSONA_SESSION` equal to that session; after the run the folder is gone; `it("removes the session folder even when the launch fails")` (runPlan rejects, and separately returns 1); partial mode (`--mode partial`) creates no session and sets no `ZZPERSONA_SESSION`. `doctor.test.ts`: `--fix` removes an orphaned session folder.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/cli exec vitest run src/session.test.ts src/claude.test.ts src/doctor.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Copy with `cp(..., { recursive: true, dereference: true })`. Doctor's build line mentions session folders in its counts.
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): launch with a session folder of plugins`.

### Task 3: `zzpersona live` (`feature/live-3-live`)

**Files:** Create `src/apps/cli/src/commands/live.ts`, `src/apps/cli/src/live.test.ts`. Modify
`src/apps/cli/src/cli.ts` (register `live`).

**Interfaces:**
- Consumes: `sessionPlugins`, `Launched` (Task 2); `prepareBuild` (CLI); `writeBuild` (executor);
  `diff` (resolver).
- Produces: `zzpersona live <persona> --session <dir> [--json]` and
  `zzpersona live --show --session <dir> [--json]`.
  ```ts
  interface LiveState { persona: string; previous: string; launched: string; instructions: string; held: ("mcp" | "permissions")[]; stricter: boolean; plugin: string; appliedAt: string }
  ```
  `--json` prints the `LiveState`; `--show` prints `live.json` or `{ "launched": <ref> }` when there
  is none. Text output: `<persona> is now live in <dir>` plus held/stricter lines. `previous` is the
  current live persona, or the launched one.
- Algorithm (spec §2): `<dir>/launched.json` missing → `live-unavailable` "live switching needs a
  session started by zzpersona claude"; `<dir>` missing → "the session folder is gone; relaunch";
  no `plugins/` subfolder → "managed settings block --plugin-dir". Resolve the launched persona too
  (overlay on) for `diff`; `held` = `"mcp"` if any change path starts with `mcp.`, `"permissions"`
  if any starts with `permissions.`; `stricter` = an `added` change under `permissions.deny[`.
  Write the build, copy the plugin to `plugins/<name>.new-<hex>`, rename it to `plugins/<name>`
  (after removing an existing same-named child), then remove other children; write `live.json`
  with `writeFileAtomic`.

- [ ] **Step 1: Failing tests** against a session created with Task 2's `createSession` in the seeded home: switch to `org/base` → plugin child `zzp-org--base` only, `live.json` written, `held`/`stricter` as computed; `it("holds nothing when MCP and permissions match")`; `stricter` true for a persona adding a deny rule; `it("a failed switch changes nothing")` (unknown persona, and a persona with a missing instruction file → error, old child and `live.json` unchanged); the three `live-unavailable` messages; `--show` before and after a switch.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/cli exec vitest run src/live.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): zzpersona live`.

### Task 4: The mod applies switches live (`feature/live-4-mod-live`)

**Files:** Modify `src/packages/mod-claude-code/src/decide.ts`, `register.ts`, `api.ts`
(`prompt.compose` types), tests `decide.test.ts`, `register.test.ts`.

**Interfaces:**
- Consumes: `zzpersona live … --json` → `LiveState`; `zzpersona live --show --session <dir> --json`.
- Produces (`decide.ts`):
  ```ts
  type Form = "show" | "list" | "switch" | "use" | "clear";
  function liveSection(live: LiveState): { id: "zzpersona:live-persona"; text: string; scope: "session" } | undefined; // undefined when live.persona === live.launched
  function bandText(launched, here, live?: LiveState): string | undefined;   // live wins when present and differs from launched
  function nudgeText(launched, here, live?: LiveState): string | undefined;  // compares here with the live persona
  function liveText(live: LiveState, saved?: string): string;               // spec §3 copy
  ```
  `personaCommand("use team/x")` → `{ form: "use", argv: ["live", "team/x"] }` (the register adds
  `--session <dir>`); `switch` keeps its argv and the register runs `live` after a successful save
  when a session is known.
- Register: `session.start` reads `ZZPERSONA_SESSION` (literal `$.env.get`); when set and
  interactive, the background refresh also runs `live --show`; a `prompt.compose` hook returns
  `[...(await next(e)).sections, section]` when `liveSection` gives one, else `next(e)`.

- [ ] **Step 1: Failing tests.** `decide.test.ts`: `liveSection` text exactly as spec §3 for team/payments → team/platform; `liveText` for held both / one / none, with `stricter`, and with a saved line; band `persona team/platform · live · MCP and permissions from team/payments` and `persona team/platform · live`; nudge compares with the live persona; `personaCommand("use team/x")`, `"use"` alone → usage. `register.test.ts`: `/persona use team/platform` runs `["zzpersona","live","team/platform","--session",<dir>,"--json"]`; the compose hook then appends the section; `it("switching back to the launched persona drops the section")`; `/persona switch` runs `switch` then `live`; without `ZZPERSONA_SESSION`, `use` prints `live switching needs a session started by zzpersona claude` and runs nothing; `it("restores the live state after a reload")` (`live --show` answer → section present after `session.start`).
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/mod-claude-code exec vitest run` — Expected: FAIL.
- [ ] **Step 3: Implement**; keep hooks top-level (validate's rule); rebuild and run `claude plugin validate src/packages/mod-claude-code/dist/mod` — Expected: `Validation passed`.
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(mod-claude-code): apply persona switches live`.

### Task 5: Smoke run and docs (`feature/live-5-smoke-e2e`)

**Files:** Create `spikes/live-smoke/FINDINGS.md`, `.changeset/live-switching.md`. Modify
`CLAUDE.md`, `docs/planning/10-live-switching.md` (dated amendments).

- [ ] **Step 1: Smoke run in a herdr pane** (load the `herdr` skill; throwaway `ZZPERSONA_HOME`
  and project as in spec 09's run; personas A and B where B has its own skill and instructions, and
  B adds an MCP server and a deny rule): `zzpersona claude -- --plugin-dir <dist/mod>` on A; `/persona use B` → band shows `live · MCP and permissions from A`, the message names the stricter rules; ask for skills (B's listed, A's gone); ask Claude to quote its "You are running the" lines and which it follows (B); `/compact`, ask again (still B); `/persona use A` → band without `live`, quote again (A only governs); `/persona switch B` → saved and live; exit → session folder removed. Record each result, plus the spec §5 compose check, in `spikes/live-smoke/FINDINGS.md`.
- [ ] **Step 2: Fix what the smoke run finds** in the owning code with a failing test first, and note it as a dated amendment in spec 10.
- [ ] **Step 3: Changeset** (minor `@zzpersona/cli`, minor `@zzpersona/mod-claude-code`, patch `@zzpersona/adapter-claude-code`, patch `@zzpersona/executor`); CLAUDE.md current phase: spec 10 built.
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` and `pnpm format:check` — Expected: PASS.
- [ ] **Step 5: Commit** `test: live switching smoke findings; changeset`.
