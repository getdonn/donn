# Claude Code Mod Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone Claude Code mod that shows the active persona in the band, nudges when the
folder selects a different one, and answers `/persona list|switch|clear`, installed with
`zzpersona mod install`.

**Architecture:** A `gh stack` on `feature/mod-0-spec` (this plan and the spec are layer 0), one
layer per task, created with `gh stack add feature/mod-<n>-<name>`. The mod's decisions are pure
functions over the launch variables and the CLI's `--json` output; `register.ts` only wires them
to Claude Code's mod events. The CLI ships the built mod and registers it through a local folder
marketplace, which Claude Code reads in place.

**Tech Stack:** TypeScript, pnpm, turborepo, vitest, esbuild (bundles the mod), Claude Code
mods API (v2.1.306 types).

**Spec:** `docs/planning/09-mod-claude-code.md`

## Global Constraints

- The mod never changes the session's persona, injects instructions, or starts a turn.
- The mod carries refs and paths only; it never reads or prints secret values.
- Every CLI call from the mod has a 5 s timeout and never throws out of a hook.
- Launch variables, verbatim: `ZZPERSONA_PERSONA`, `ZZPERSONA_SOURCE`
  (`argument|switch|project|default`), `ZZPERSONA_PROJECT` (inside a project only).
- Plugin name `zzpersona`; marketplace name `zzpersona`; installed id `zzpersona@zzpersona`.
- `userConfig`: `nudge` (boolean, default `true`), `band` (boolean, default `true`).
- Mod API facts (types for v2.1.306): `$.env.get("<literal>")`, `$.session.cwd()`,
  `$.process.run(argv, { cwd, timeoutMs })` resolves `{ exitCode, stdout, stderr }` for any exit
  and **rejects** when the command cannot start or is refused; `$.ui.status(text | undefined)`;
  `$.ui.invalidate('ui.render')`; band = `on('ui.render', { component: 'AbovePrompt' }, …)`
  returning a tree built from `$.ui.resolve(e)` (`Box`, `Text`) via the global `h`, or `next(e)`;
  `$.command.register({ name, description, argumentHint })` in `session.start`, answered by
  `on('command.run', { command: 'persona' }, …)` returning `{ text }`; `register(on, options)`
  receives `userConfig` values in `options`.
- All packages `"private": true`; Prettier width 80; every layer passes
  `pnpm turbo run build check-types lint test` and `pnpm format:check`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A folder where the CLI reports `no-persona` (exit 1, `{"error":{"code":"no-persona"}}`) is not
   a failure: no band in plain `claude`, no nudge, no "unavailable". → Task 3 test "treats
   no-persona as nothing to say".
2. A CLI error that persists (corrupt `state.json`, stale switch) shows once as a status line and
   is not re-run on every render. → Task 3 test "runs the CLI once per session start, not per
   render".
3. `/persona switch` arguments with extra spaces, or `--default` before the ref, parse the same.
   → Task 3 test "parses /persona arguments loosely".
4. Launched with A by argument while the folder also selects A: no nudge. → Task 3 test "no nudge
   when the folder selects the session's persona".
5. CLI warnings on stderr alongside valid JSON on stdout parse normally. → Task 3 test "ignores
   stderr when stdout is JSON".

---

### Task 1: Plugin names (`feature/mod-1-plugin-name`)

**Files:** Modify `src/packages/adapters/claude-code/src/compile.ts` (`pluginName`), golden files
under `src/packages/adapters/claude-code/test/golden/`, `docs/planning/05-adapter-sdk.md` (dated
note on open question 3). Test: `src/packages/adapters/claude-code/src/compile.test.ts`.

**Interfaces:** Produces `pluginName(personaId: string): string` = `zzp-` + id with `/` → `--`.

- [ ] **Step 1: Failing test** `it("keeps nested and hyphenated refs apart in plugin names")`:
  `pluginName("team/platform-payments") === "zzp-team--platform-payments"`,
  `pluginName("team/platform/payments") === "zzp-team--platform--payments"`, and the existing
  "names the plugin after the persona id" expectation updated to the `--` form.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/adapter-claude-code exec vitest run src/compile.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**, then regenerate golden builds with `vitest run -u`; the golden diff
  must contain only plugin-name changes. Add the dated note to `05` open question 3. Update any
  CLI test or e2e string that hard-codes `zzp-team-e2e` (`grep -rn "zzp-" src/apps/cli/src`).
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` — Expected: PASS.
- [ ] **Step 5: Commit** `fix(adapter-claude-code): plugin names map / to --`.

### Task 2: `zzpersona list` and launch variables (`feature/mod-2-cli-list-env`)

**Files:** Create `src/apps/cli/src/commands/list.ts`, `src/apps/cli/src/list.test.ts`. Modify
`src/apps/cli/src/cli.ts` (register `list`), `src/apps/cli/src/commands/claude.ts` (launch env).
Test: `src/apps/cli/src/claude.test.ts`.

**Interfaces:**
- Produces: `zzpersona list [--json]` → `{ "personas": [{ "ref": string, "layer": string }] }`
  sorted by ref; text groups by layer (`org`, `area`, `team`, `project`, `user` order), one ref
  per line under a `<layer>:` heading.
- Produces: the launch step's `env` gains `ZZPERSONA_PERSONA`, `ZZPERSONA_SOURCE`, and
  `ZZPERSONA_PROJECT` (= the repo, `dirname(projectDir)`) when the selection has a project.

- [ ] **Step 1: Failing tests.** `list.test.ts`: in the seeded repo `list --json` lists
  `org/base`, `area/fintech`, `team/payments`, `project/persona` with their layers; text output has
  `team:` then `  team/payments`. `claude.test.ts`: `it("tells the session which persona it runs")`
  — a recorded `runPlan` sees `plan.steps[0].env` containing `ZZPERSONA_PERSONA: "project/persona"`,
  `ZZPERSONA_SOURCE: "project"`, `ZZPERSONA_PROJECT: s.repo`; `claude team/payments --dry-run`
  output contains `ZZPERSONA_SOURCE=argument`.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/cli exec vitest run src/list.test.ts src/claude.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Add the variables to every `launch` step of the plan returned by
  `prepareBuild` inside `claudeCommand` (CLI concern; the adapter stays harness-neutral). Check how
  `renderBuild` prints step env and make `--dry-run` show them.
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): zzpersona list; tell the session which persona it runs`.

### Task 3: The mod (`feature/mod-3-mod`)

**Files:** Create package `src/packages/mod-claude-code/` (`package.json` private, name
`@zzpersona/mod-claude-code`, `"type": "module"`, scripts `build`, `test`, `lint`,
`check-types`; devDependency `esbuild` at its latest version), `src/decide.ts`, `src/cli.ts`,
`src/register.ts`, `src/types.d.ts` (the subset of the mod API used, see Global Constraints),
`plugin/.claude-plugin/plugin.json`, `plugin/hooks/hooks.json`, `scripts/build.mjs`, tests
`src/decide.test.ts`, `src/cli.test.ts`.

**Interfaces:**
- Produces (`decide.ts`, pure):
  ```ts
  type Source = "argument" | "switch" | "project" | "default";
  interface Launched { persona: string; source: Source; project?: string } // from env
  type Here = { kind: "persona"; persona: string; source: Source; project?: string }
            | { kind: "none" }                       // CLI said no-persona
            | { kind: "unavailable"; reason: string };
  function bandText(launched: Launched | undefined, here: Here): string | undefined;
  function nudgeText(launched: Launched | undefined, here: Here): string | undefined;
  function personaCommand(args: string): { argv: string[] } | { usage: string };
  function commandText(form: "show" | "list" | "switch" | "clear", json: unknown, launched: Launched | undefined): string;
  ```
  Exact copy from spec §2 and §3: band `persona <ref> · <source>` / `persona none · this folder
  uses <ref>`; nudges `this folder uses <B> (<source>); this session runs <A>. /persona switch
  <B>, then relaunch`, `this folder uses <ref>; start with zzpersona claude to load it`,
  `zzpersona unavailable: <reason>`; the post-switch text block from §3 verbatim. Default-only
  selection never yields a band or nudge for a plain session.
- Produces (`cli.ts`): `runCli($, args: string[], cwd: string): Promise<{ ok: true; json: unknown } | { ok: false; reason: string; code?: string }>`
  — runs `["zzpersona", ...args, "--json"]` with `timeoutMs: 5000`; exit 0 → parse stdout;
  non-zero → `{ ok: false, code, reason: error.message }` from the `{"error":…}` envelope;
  rejection → `reason` `zzpersona not found on PATH` when the message says the command could not
  start (ENOENT), `timed out` on timeout, otherwise `blocked: <message>`.
- Produces: `dist/mod/` (plugin.json with the package version, hooks.json, bundled
  `hooks/register.js` with `claude-code` external, no other imports).

- [ ] **Step 1: Failing tests** (`decide.test.ts`, `cli.test.ts` with a fake `$` whose
  `process.run` records argv/init and returns or rejects as told):
  every row of spec §2's band and nudge tables; `it("treats no-persona as nothing to say")`;
  `it("no nudge when the folder selects the session's persona")`;
  `it("parses /persona arguments loosely")` (`"  switch   team/x "`, `"switch --default team/x"`,
  `"clear --default"`, `"bogus"` → usage);
  `commandText` for each form, including the post-switch block;
  `runCli`: argv and `timeoutMs: 5000`, the three rejection reasons, a non-zero envelope,
  `it("ignores stderr when stdout is JSON")`;
  a register-level test with a fake `on`: `it("runs the CLI once per session start, not per
  render")` (two `ui.render` calls after one `session.start` → one `process.run`), the nudge goes
  to `$.ui.status` once, any `/persona` clears it (`status(undefined)`), and `options.band ===
  false` / `options.nudge === false` suppress each.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/mod-claude-code exec vitest run` — Expected: FAIL.
- [ ] **Step 3: Implement.** `register.ts`: `session.start` registers `/persona`, reads the three
  variables with literal `$.env.get` calls, starts `runCli(["switch"])` without awaiting it in the
  hook (store the result, then `$.ui.invalidate('ui.render')` and set the nudge), returns
  `next(e)`. The band hook returns `next(e)` when there is no text, else a `Box` holding a dim
  `Text` and `await next(e)`. `scripts/build.mjs` bundles with esbuild (`format: "esm"`,
  `platform: "neutral"`, `external: ["claude-code"]`) and writes the manifest with the package
  version and the `userConfig` fields.
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` — Expected: PASS;
  `dist/mod/hooks/register.js` exists and imports nothing but `claude-code`.
- [ ] **Step 5: Commit** `feat(mod-claude-code): band, nudge and /persona`.

### Task 4: Install, uninstall, doctor (`feature/mod-4-mod-install`)

**Files:** Create `src/apps/cli/src/commands/mod.ts`, `src/apps/cli/src/mod.test.ts`. Modify
`src/apps/cli/package.json` (dependency `@zzpersona/mod-claude-code: workspace:*`), `cli.ts`
(register `mod install|uninstall`), `src/apps/cli/src/doctor/checks.ts` (a `mod` check after
`claude`), `doctor.test.ts` (IDS gains `mod`).

**Interfaces:**
- Consumes: `dist/mod/` from Task 3, found via
  `dirname(fileURLToPath(import.meta.resolve("@zzpersona/mod-claude-code/package.json")))`.
- Produces: `zzpersona mod install [--json]` copies `dist/mod/` to `<home>/mod/plugin/`, writes
  `<home>/mod/.claude-plugin/marketplace.json` (`{ name: "zzpersona", owner: { name: "zzpersona" },
  plugins: [{ name: "zzpersona", source: "./plugin" }] }`), then runs through `io.probe.run`:
  `claude plugin marketplace add <home>/mod` and `claude plugin install zzpersona@zzpersona`
  (check `--scope user` with `claude plugin install --help` and pass it when offered). Prints each
  command it ran; `--json` `{ "installed": "<home>/mod/plugin", "ran": [[argv]...] }`. A failing
  `claude` command is `CliError("mod-install", "<command> exited <n>: <first stderr line>")`.
  `zzpersona mod uninstall` runs `claude plugin uninstall zzpersona@zzpersona`, `claude plugin
  marketplace remove zzpersona`, removes `<home>/mod`.
- Produces: doctor `mod` check: `ok` `zzpersona mod <version>`; `warn` `the mod is not installed`
  (fix `zzpersona mod install`); `warn` `mod <a> does not match zzpersona <b>` (same fix); version
  read from `<home>/mod/plugin/.claude-plugin/plugin.json`.

- [ ] **Step 1: Failing tests** with a recording fake probe: install copies the files, writes the
  marketplace file, runs exactly the two commands in order; re-running install is idempotent
  (marketplace already added → continue); a failing install command gives the `mod-install`
  envelope; uninstall runs its two commands and removes the folder; doctor `mod` in all three
  states.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/cli exec vitest run src/mod.test.ts src/doctor.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): zzpersona mod install|uninstall and doctor's mod check`.

### Task 5: Validate, smoke, docs (`feature/mod-5-smoke-e2e`)

**Files:** Modify `src/apps/cli/src/e2e.test.ts`. Create `spikes/mod-smoke/FINDINGS.md`,
`.changeset/mod-claude-code.md`. Modify `CLAUDE.md`, `docs/planning/09-mod-claude-code.md` (dated
amendments for anything the smoke run changes).

- [ ] **Step 1: E2e (`ZZP_E2E=1`):** `claude plugin validate <dist/mod>` exits 0; `mod install`
  then `mod uninstall` against the real `claude` with `CLAUDE_CONFIG_DIR` set to a temporary
  folder, so the user's own Claude Code config is never touched (skip with a message if the
  install needs a login there).
- [ ] **Step 2: Run** `ZZP_E2E=1 pnpm --filter @zzpersona/cli exec vitest run src/e2e.test.ts` — Expected: PASS.
- [ ] **Step 3: Smoke run in a herdr pane** (load the `herdr` skill first). Seeded temp home and
  project; run `zzpersona claude -- --plugin-dir <dist/mod>` (loads the mod without installing
  it into the user's config):
  band shows `persona project/persona · project`; `/persona list`; `/persona switch team/payments`
  prints the post-switch text; `/exit`; `zzpersona claude -- --plugin-dir <dist/mod> --continue`
  — does the conversation carry over and the band show `team/payments · switch`? Then plain
  `claude --plugin-dir <dist/mod>` in the project → nudge. Then manual checks A and B from
  `spikes/claude-code/FINDINGS.md`. Record each result in `spikes/mod-smoke/FINDINGS.md`; if
  `--continue` does not carry over, change the post-switch text (Task 3's `commandText`) and its
  test, and note it in spec 09.
- [ ] **Step 4: Changeset** (minor `@zzpersona/cli`, minor `@zzpersona/mod-claude-code`, patch
  `@zzpersona/adapter-claude-code`); CLAUDE.md current phase: spec 09 built, next spec 10 (live
  switching). Run `pnpm turbo run build check-types lint test` and `pnpm format:check` — Expected:
  PASS.
- [ ] **Step 5: Commit** `test: mod e2e and smoke findings; changeset`.
