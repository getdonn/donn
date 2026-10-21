# CLI Daily Use Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `zzpersona` pleasant to live with: `switch` (per-project and default, in `state.json`), flags-only `init`, `doctor` with `--fix`, and fixes for the CLI-side deferred minors.

**Architecture:** Persona selection becomes one function returning the chosen ref and its source, reading a small atomic `state.json`. `switch` and `init` are thin commands over that state and the store; `doctor` composes the existing context, resolver, adapter detection, secrets and new executor maintenance helpers into a list of checks.

**Tech Stack:** TypeScript 7, Node 26 (floor 24), pnpm + turborepo, vitest 5, commander 15, yaml 2.9.1, zod 4.6.7; existing `@zzpersona/*` packages.

**Spec:** `docs/planning/07-cli-daily-use.md`

## Global Constraints

- **Stacked PRs.** Layer 0 (`feature/daily-0-spec`) holds the spec and this plan. Before task N: `gh stack add feature/daily-<N>-<topic>` (names below). A review fix goes into the layer that owns the code (`gh stack checkout <branch>`, commit, `gh stack rebase --upstack`). Open PRs with `gh stack submit --auto --open` only when the user asks.
- State file: `<home>/state.json` = `{ "version": 1, "default"?: Ref, "projects": { <realpath of .zzpersona dir>: Ref } }`, written atomically.
- Selection sources, first match wins: `argument` → `switch` → `project` → `default` → error `no-persona`.
- Every command supports `--json`; error envelopes are `{ "error": { "code", … } }` on stdout, exit 1.
- `claude` is the only command that accepts `--` passthrough.
- Verified Claude Code version for `doctor`: `2.1.306`.
- `pnpm format` before each commit; `CI=1 pnpm turbo run build check-types lint test` and `pnpm format:check` pass at the end of every task.

## Review Focus

1. **`switch` run from a subdirectory of a project** → applies to that project (same key as from its root), not the default. Test in Task 4.
2. **`doctor` on a fresh machine** (no config, outside any project) → no crash; `config` warns, `persona` warns ("no persona would be used here"), dependent checks `skipped`, exit 0. Test in Task 6.
3. **`init --personas` with a relative path** → stored in `config.yaml` as an absolute path, so it works from any directory. Test in Task 5.
4. **`switch --clear` with nothing to clear** → succeeds with "nothing to clear", exit 0. Test in Task 4.
5. **`init --extends` inside an existing project's subdirectory** → creates a nested `.zzpersona/persona.yaml` there, and `findProject` from that directory then picks the nested one. Test in Task 5.

## File Structure

```
src/packages/store-local/src/store.ts        list() + readText() hardening        (Task 1)
src/packages/executor/src/run-plan.ts         128+n signal exit                    (Task 2)
src/packages/executor/src/maintenance.ts      build leftovers: find + remove       (Task 6)
src/apps/cli/src/fs.ts                        writeFileAtomic                      (Task 3)
src/apps/cli/src/state.ts                     readState / writeState / projectKey  (Task 3)
src/apps/cli/src/select.ts                    Selection with source                (Task 3)
src/apps/cli/src/commands/switch.ts                                                (Task 4)
src/apps/cli/src/commands/init.ts                                                  (Task 5)
src/apps/cli/src/commands/doctor.ts, doctor/checks.ts                              (Task 6)
```

---

### Task 1: Store hardening — layer `feature/daily-1-store-hardening`

**Files:** Modify `src/packages/store-local/src/store.ts`, `store.test.ts`.

**Interfaces:** No signature changes. `list()` follows symlinks and includes only files whose parsed YAML has `kind: Persona`; unparseable files are skipped. `readText(virtualPath)` throws `StoreError` when the file's real path is outside the real path of its mount root.

- [ ] **Step 1: `gh stack add feature/daily-1-store-hardening`.**
- [ ] **Step 2: Write failing tests:** a `team/payments.yaml` that is a symlink to a persona file elsewhere inside the personas folder appears in `list()`; `team/skills/x/data.yaml` (`foo: 1`) and a `kind: PersonaOverlay` file under `team/` do not; a project instruction file that is a symlink to a file outside the project mount → `readText` throws `StoreError` whose message contains "outside"; a symlink to a file inside the mount still reads.
- [ ] **Step 3–5:** run (FAIL), implement (`stat` instead of `Dirent.isFile`; parse and check `kind`; `realpath` containment as in the executor), run (PASS).
- [ ] **Step 6: Commit** `fix(store-local): list only real personas, follow symlinks; contain readText`.

### Task 2: Executor and CLI hardening — layer `feature/daily-2-runtime-hardening`

**Files:** Modify `src/packages/executor/src/run-plan.ts` (+test), `src/apps/cli/src/cli.ts`, `src/apps/cli/src/commands/claude.ts`, `src/apps/cli/src/context.ts`; tests `src/apps/cli/src/hardening.test.ts`.

**Interfaces:** `runPlan` returns `128 + os.constants.signals[signal]` for a signal-killed child. `CliError` codes `usage`, `unexpected-passthrough`.

- [ ] **Step 1: `gh stack add feature/daily-2-runtime-hardening`.**
- [ ] **Step 2: Write failing tests:**
  - `runPlan` of `node -e "process.kill(process.pid, 'SIGTERM')"` → `143`.
  - `claude` with a fake `runPlan` returning `130` and `now` advancing 1000 ms → no managed-settings hint.
  - `claude --mode bogus --json` → exit 1, stdout `{"error":{"code":"usage",…}}`, nothing on stderr.
  - `resolve -- team/payments` and `compile -- x` → exit 1, `unexpected-passthrough`.
  - `ZZPERSONA_HOME=""` with `HOME` set to a seeded home → the seeded `config.yaml` is used.
- [ ] **Step 3–5:** run (FAIL), implement (commander `configureOutput({ outputError })` suppressed under `--json`; a per-command flag for whether passthrough is allowed; `env.ZZPERSONA_HOME || …`), run (PASS).
- [ ] **Step 6: Commit** `fix: signal exit codes, --json usage errors, reject stray passthrough, empty ZZPERSONA_HOME`.

### Task 3: State and selection — layer `feature/daily-3-selection`

**Files:** Create `src/apps/cli/src/fs.ts`, `src/apps/cli/src/state.ts`, `src/apps/cli/src/state.test.ts`; modify `select.ts`, `context.ts`, `commands/{resolve,compile,claude}.ts`, `src/apps/cli/src/select.test.ts` (new).

**Interfaces:**
- `writeFileAtomic(path: string, content: string, mode?: number): Promise<void>` (temp sibling + rename).
- `interface State { version: 1; default?: Ref; projects: Record<string, Ref> }`; `readState(home: string): Promise<State>` (missing → empty; unparseable or wrong shape → `CliError("invalid-state", …, { file })`); `writeState(home: string, state: State): Promise<void>`; `projectKey(projectDir: string): Promise<string>` (realpath).
- `Context` gains `state: State`.
- `type Source = "argument" | "switch" | "project" | "default"`; `interface Selection { ref: Ref; source: Source; project?: string }`; `selectPersona(arg: string | undefined, ctx: Context): Promise<Selection>`.
- `resolvePersona(ctx, selection, overlay)` (was `ref`): a `missing-ref` for `selection.ref` from source `switch` or `default` becomes `CliError("stale-switch", "<ref> (set by zzpersona switch) no longer exists; run zzpersona switch --clear to remove it", { ref, source })`.
- Bare-name rules: a trailing `.yaml` is stripped from any argument; `unknown-persona` adds `details.suggestion` and the message suffix ` — did you mean <ref>?` when exactly one listed ref matches case-insensitively (full ref or last segment).

- [ ] **Step 1: `gh stack add feature/daily-3-selection`.**
- [ ] **Step 2: Write failing tests:**
  - `state.test.ts`: round trip; missing file → `{ version: 1, projects: {} }`; `{ bad json` → `invalid-state` naming the file; `writeState` leaves no temp files; `projectKey` of a symlinked `.zzpersona` dir equals that of its target.
  - `select.test.ts` (seeded): each of the five sources wins in turn (argument over switch over project over default; outside a project the default is used; with none, `no-persona` whose message mentions `zzpersona switch`); `team/payments.yaml` selects `team/payments`; `Team/Payments` → `unknown-persona` with `suggestion: "team/payments"`; a default of `team/gone` → `stale-switch`.
- [ ] **Step 3–5:** run (FAIL), implement, run (PASS; existing CLI tests still pass).
- [ ] **Step 6: Commit** `feat(cli): state.json and source-aware persona selection`.

### Task 4: `switch` — layer `feature/daily-4-switch`

**Files:** Create `src/apps/cli/src/commands/switch.ts`, `src/apps/cli/src/switch.test.ts`; modify `cli.ts`.

**Interfaces:** Consumes Task 3. Output text: setting → `team/platform is now used for <project dir>` or `team/payments is now your default`; clearing → `cleared the switch for <project dir>` / `cleared your default` / `nothing to clear`; showing → `<ref> (<source>[ for <project>])`. `--json` per spec §1.

- [ ] **Step 1: `gh stack add feature/daily-4-switch`.**
- [ ] **Step 2: Write failing tests:** in a project, `switch team/payments` writes `projects[<key>]`, then `resolve --json` uses `team/payments`; from `<repo>/src/deep` the same key is used (Review Focus 1); `--default` inside a project writes `default`; outside a project writes `default`; `switch team/nope` → exit 1, `state.json` unchanged; `switch --clear` removes the entry; again → `nothing to clear`, exit 0 (Review Focus 4); `switch` with no args → `{ persona, source: "switch", project }` under `--json`.
- [ ] **Step 3–5:** run (FAIL), implement (resolve the persona before writing), run (PASS).
- [ ] **Step 6: Commit** `feat(cli): zzpersona switch`.

### Task 5: `init` — layer `feature/daily-5-init`

**Files:** Create `src/apps/cli/src/commands/init.ts`, `src/apps/cli/src/init.test.ts`; modify `cli.ts`.

**Interfaces:** Consumes `writeFileAtomic`, `selectPersona` (bare names → full ref), `resolvePersona`. Starter `org/base.yaml` contents: `apiVersion: zzpersona/v0`, `kind: Persona`, `metadata: { name: base, description: Baseline for every persona }`, one inline instruction id `conduct`, `permissions.deny: ["Bash(rm -rf:*)"]`, a leading comment pointing to `docs/planning/02-persona-spec.md`. Git hint text: `tip: run \`git init\` in <dir> to track your personas`.

- [ ] **Step 1: `gh stack add feature/daily-5-init`.**
- [ ] **Step 2: Write failing tests:** `init --personas <empty dir>` writes config and starter, `created` lists both; again with a different dir → refused naming the current value; with `--force` → updated; into a dir that already has `team/x.yaml` → no starter; `init --personas ./p` from `cwd` stores the absolute path (Review Focus 3); `init --extends payments` in a repo writes `.zzpersona/persona.yaml` with `extends: [team/payments]` and `metadata.name` = the dir's basename; existing file → refused, `--force` overwrites; `--extends team/nope` → exit 1, no file; both flags in one call; no flags → `init-needs-flags`; nested `init --extends` in `<repo>/sub` then `resolve` from `sub` uses `sub/.zzpersona` (Review Focus 5).
- [ ] **Step 3–5:** run (FAIL), implement, run (PASS).
- [ ] **Step 6: Commit** `feat(cli): zzpersona init (flags only)`.

### Task 6: `doctor` — layer `feature/daily-6-doctor`

**Files:** Create `src/packages/executor/src/maintenance.ts` (+test), `src/apps/cli/src/commands/doctor.ts`, `src/apps/cli/src/doctor/checks.ts`, `src/apps/cli/src/doctor.test.ts`; modify `executor/src/index.ts`, `cli.ts`.

**Interfaces:**
- Executor: `interface BuildLeftovers { staleLocks: string[]; orphanVersions: string[]; tempLinks: string[] }`; `findBuildLeftovers(home: string): Promise<BuildLeftovers>` (stale lock = `*.lock` dir whose `pid` process is gone; orphan = `*.v-*` dir not the `readlink` target of its sibling build symlink; temp link = `*.link-*`); `removeBuildLeftovers(leftovers: BuildLeftovers): Promise<void>`.
- CLI: `type Status = "ok" | "warn" | "error" | "skipped"`; `interface Check { id: string; status: Status; message: string; fix?: string }`; `runChecks(io: CliIo, options: { persona?: string; fix: boolean }): Promise<Check[]>` — builds what it needs step by step (never `createContext`, so a broken config is a check, not a crash). Check ids and conditions exactly as spec §3; `persona` is `warn` (not error) when nothing would be selected; `claude` version comparison is numeric per component against `2.1.306`; `secrets` uses `prepareBuild` + `resolveSecrets`, listing each failing ref. Line format: `<status padded to 7><id padded to 10><message>`, then `       fix: <fix>` on the next line when present.

- [ ] **Step 1: `gh stack add feature/daily-6-doctor`.**
- [ ] **Step 2: Write failing tests:** maintenance finds and removes a stale lock (pid `999999`), an orphan version and a temp link, leaving the live version; doctor in a healthy seeded repo with an env vault → all `ok`, exit 0; fresh machine → as Review Focus 2; a broken `config.yaml` → `config` error, `personas`/`resolve`/`secrets` skipped, exit 1; personas folder not a git repo → `personas` warn; an orphaned switch entry → `state` warn, and `--fix` removes it; probe not installed → `claude` error; probe `2.1.100` → warn; seeded vault (hashicorp) → `secrets` error naming the ref; `--json` shape; no secret value in any output.
- [ ] **Step 3–5:** run (FAIL), implement, run (PASS).
- [ ] **Step 6: Commit** `feat(cli): zzpersona doctor`.

### Task 7: End-to-end, changeset — layer `feature/daily-7-e2e`

**Files:** Modify `src/apps/cli/src/e2e.test.ts`, `CLAUDE.md`; create `.changeset/cli-daily-use.md`.

- [ ] **Step 1: `gh stack add feature/daily-7-e2e`.**
- [ ] **Step 2:** extend the opt-in e2e (`ZZP_E2E=1`, before the real launch): `init --personas`, a project via `init --extends team/e2e`, `switch team/e2e` from the project, `doctor` exits 0, `claude --dry-run` output names `team/e2e`. Run once with `ZZP_E2E=1` (one Haiku call).
- [ ] **Step 3:** changeset (`minor`: `@zzpersona/cli`; `patch`: `store-local`, `executor`); `CLAUDE.md` current phase: daily use built, next spec 08.
- [ ] **Step 4: Run** the full pipeline and `pnpm format:check` — PASS.
- [ ] **Step 5: Commit** `test(cli): e2e covers init, switch and doctor`.
