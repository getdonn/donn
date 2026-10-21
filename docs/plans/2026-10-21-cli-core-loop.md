# CLI Core Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `zzpersona claude` turns personas on disk into a correctly configured Claude Code session: store, secrets, plan executor, and the `resolve`/`compile`/`claude` commands.

**Architecture:** Three locations (personas folder, project `.zzpersona/`, `~/.zzpersona/`) are mounted onto the resolver's single virtual root by layer. The CLI resolves, detects, compiles with the Claude Code adapter, and hands the build and plan to an executor that writes builds atomically with per-mount containment, resolves secrets into the launch env, and runs `claude`.

**Tech Stack:** TypeScript 7, Node 26 (floor 24), pnpm + turborepo, vitest 5, commander 15.0.0, yaml 2.9.1, zod 4.6.7, `@zzpersona/{spec,resolver,adapter-sdk,adapter-claude-code}`.

**Spec:** `docs/planning/06-cli-core-loop.md`

## Global Constraints

- **Stacked PRs.** Layer 0 (`feature/cli-0-spec`) holds the spec and this plan. Each task is its own layer: before starting task N run `gh stack add feature/cli-<N>-<topic>` (names below). A review fix belongs in the layer that owns the code: `gh stack checkout <branch>`, commit, `gh stack rebase --upstack`. Open PRs with `gh stack submit` only when the user asks.
- New packages copy `src/packages/resolver/` layout: scripts `build`/`test`/`lint`/`check-types`, `tsconfig.json`, `tsconfig.build.json` (excludes `src/**/*.test.ts`), `eslint.config.js`; `"private": true`, `"type": "module"`, `@types/node` `^24`.
- Packages: `src/packages/store-local` (`@zzpersona/store-local`), `src/packages/secrets` (`@zzpersona/secrets`), `src/packages/executor` (`@zzpersona/executor`), `src/apps/cli` (`@zzpersona/cli`, bin `zzpersona`).
- Home: `ZZPERSONA_HOME` env, else `~/.zzpersona`. Config: `<home>/config.yaml`, key `personas`. Overlay: `<home>/overrides.yaml`. User personas: `<home>/personas/`. Builds: `<home>/build/<slug>-<hash8>/<adapter>/`, `<home>/build/` mode `0700`.
- Fixed project ref: `project/persona` ↔ `<repo>/.zzpersona/persona.yaml`.
- Secret refs `secret://<provider>/<path>`; only backend `env`; provider `env` needs no declaration.
- Secret values never appear in files, logs, error messages or `--json` output.
- `pnpm format` before each commit; `CI=1 pnpm turbo run build check-types lint test` must pass at the end of every task.

## Review Focus

1. **`personas: ~/personas` in config** → `~` expands to the home directory, not a literal folder named `~`. Test in Task 5.
2. **A secret env var set to the empty string** → treated as unset ("is not set"), no launch. Test in Task 2.
3. **Running `zzpersona claude` from a subdirectory of the repo** → finds the project persona above it and launches with cwd = that subdirectory. Test in Task 7.
4. **A project persona whose instruction file is missing** → one error naming the virtual and physical path, not a stack trace. Test in Task 6.
5. **`personas:` configured but the folder doesn't exist** → `StoreError` naming the configured path. Test in Task 1.

## Spec refinement (made while planning)

`LocalStore.physicalPath(virtualPath): string | undefined` becomes
`locate(virtualPath): { path: string; root: string } | undefined`: the executor's containment
check needs the mount root as well as the path. Task 1 amends spec §1 with a dated note.

---

### Task 1: `@zzpersona/store-local` — layer `feature/cli-1-store-local`

**Files:** Create `src/packages/store-local/{package.json,tsconfig.json,tsconfig.build.json,eslint.config.js}`, `src/index.ts`, `src/store.ts`, `src/store.test.ts`. Modify `docs/planning/06-cli-core-loop.md` (refinement note).

**Interfaces:**
- Consumes: `Ref` from `@zzpersona/spec`; `PersonaSource` (type) from `@zzpersona/resolver`; `parse` from `yaml`.
- Produces: `interface Mounts { personas?: string; project?: string; user: string }`; `createLocalStore(mounts: Mounts): LocalStore`; `interface LocalStore extends PersonaSource { locate(virtualPath: string): { path: string; root: string } | undefined; readText(virtualPath: string): Promise<string>; list(): Promise<Ref[]>; strayLayerDirs(): Promise<string[]> }`; `findProject(cwd: string): string | undefined` (returns the `.zzpersona` directory); `class StoreError extends Error { file?: string; line?: number; configKey?: string }`.

Mapping (`root` is what containment is checked against):

| Virtual path | `path` | `root` |
|---|---|---|
| `org/…`, `area/…`, `team/…` | `<personas>/<virtual>` | `<personas>` |
| `project/persona.yaml` | `<project>/persona.yaml` | `<project>` |
| `project/<rest>` | `<project>/<rest>` | `<project>` |
| `user/overrides.yaml` | `<user>/overrides.yaml` | `<user>` |
| `user/<rest>` | `<user>/personas/<rest>` | `<user>/personas` |

- [ ] **Step 1: `gh stack add feature/cli-1-store-local`.**
- [ ] **Step 2: Write failing tests** (temp dirs per test):
  - `locate` returns the table's path and root for each row; `undefined` for `project/…` without a project mount.
  - `load("team/payments")` parses `<personas>/team/payments.yaml`; a missing file → `undefined`.
  - invalid YAML → `StoreError` with `file` = the physical path and `line` = the YAML error line.
  - `load("team/x")` with no `personas` mount → `StoreError` with `configKey: "personas"`.
  - `personas` mount pointing at a non-existent folder → `StoreError` whose message contains that path (Review Focus 5).
  - `list()` returns sorted refs from `org/`, `area/`, `team/` (nested allowed), `user/*` from `<user>/personas`, and `project/persona` when mounted; ignores `<personas>/project/` and `<personas>/user/`, which `strayLayerDirs()` returns.
  - `findProject` from `<repo>/a/b` finds `<repo>/.zzpersona`; a nested `<repo>/a/.zzpersona/persona.yaml` wins from `<repo>/a/b`; `undefined` at a directory with none above it.
- [ ] **Step 3: Run** `pnpm --filter @zzpersona/store-local test` — FAIL (module missing).
- [ ] **Step 4: Implement** `store.ts`; `readText` throws `StoreError` with the virtual and physical path when the file is missing.
- [ ] **Step 5: Run** — PASS. Add the dated refinement note to spec §1.
- [ ] **Step 6: Commit** `feat(store-local): mount personas folder, project and user dirs onto one root`.

### Task 2: `@zzpersona/secrets` — layer `feature/cli-2-secrets`

**Files:** Create `src/packages/secrets/{package.json,…}`, `src/index.ts`, `src/secrets.ts`, `src/secrets.test.ts`.

**Interfaces:**
- Consumes: `ResolvedPersona` (type) from `@zzpersona/spec`.
- Produces: `interface SecretBackend { type: string; resolve(path: string, config: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<string | undefined> }`; `envBackend: SecretBackend`; `parseSecretRef(ref: string): { provider: string; path: string } | undefined`; `resolveSecrets(refs: string[], providers: ResolvedPersona["secrets"]["providers"], options?: { backends?: SecretBackend[]; env?: NodeJS.ProcessEnv }): Promise<Record<string, string>>`; `class SecretResolutionError extends Error { failures: { ref: string; reason: string }[] }`.

Exact reasons: malformed `not a secret://<provider>/<path> ref`; undeclared `provider "<p>" is not declared in secrets.providers`; unsupported `provider type "<t>" is not supported yet`; unset `environment variable <NAME> is not set`. Message: `could not resolve <n> secret(s):` then one `  <ref>: <reason>` line per failure.

- [ ] **Step 1: `gh stack add feature/cli-2-secrets`.**
- [ ] **Step 2: Write failing tests:** `secret://local/TOKEN` with `providers.local = {type:"env"}` and `env.TOKEN = "v"` → `{ "secret://local/TOKEN": "v" }`; `secret://env/X` works undeclared; one call with a malformed ref, an undeclared provider, a `hashicorp-vault` provider and an unset variable throws once with all four failures and exact reasons; `TOKEN=""` → "is not set" (Review Focus 2); the thrown message and `failures` never contain any env value (set values to `SUPER-SECRET-VALUE` and assert absence).
- [ ] **Step 3–5:** run (FAIL), implement, run (PASS).
- [ ] **Step 6: Commit** `feat(secrets): env backend and all-or-nothing resolution`.

### Task 3: Executor probe and build location — layer `feature/cli-3-executor-probe`

**Files:** Create `src/packages/executor/{package.json,…}`, `src/index.ts`, `src/probe.ts`, `src/build-dir.ts`, `src/probe.test.ts`, `src/build-dir.test.ts`. Modify `src/packages/adapter-sdk/src/types.ts` (`Probe.run` doc), `docs/planning/05-adapter-sdk.md` (dated amendment).

**Interfaces:**
- Produces: `nodeProbe(): Probe`; `buildDirFor(personaId: Ref, projectDir: string | undefined, adapter: string, home: string): string`.

`buildDirFor` = `join(home, "build", `${personaId.replaceAll("/", "-")}-${hash8}`, adapter)`, `hash8` = first 8 hex of SHA-256 of `` `${personaId}\n${projectDir ?? ""}` ``.

- [ ] **Step 1: `gh stack add feature/cli-3-executor-probe`.**
- [ ] **Step 2: Write failing tests:** `nodeProbe().run("zz-no-such-command", [])` → `{ exitCode: 127 }`, no throw; `run("node", ["-e", "process.stdout.write('ok')"])` → exit 0, stdout `ok`; `run("node", ["-e", "process.exit(4)"])` → exit 4; `readFile`/`listDir` of an absent path → `undefined`; `buildDirFor("project/persona", "/a/.zzpersona", "claude-code", "/h")` ≠ same with `"/b/.zzpersona"`, both under `/h/build/project-persona-`, ending `/claude-code`; deterministic across calls.
- [ ] **Step 3–5:** run (FAIL), implement (`execFile`, `timeout: 10000`, `encoding: "utf8"`; ENOENT → 127), run (PASS).
- [ ] **Step 6:** Document on `Probe.run`: "Never throws for a missing command: returns exit code 127." Add the matching dated amendment to `05` §1.
- [ ] **Step 7: Commit** `feat(executor): node probe and per-project build directories`.

### Task 4: `writeBuild` and `runPlan` — layer `feature/cli-4-executor-run`

**Files:** Create `src/packages/executor/src/write-build.ts`, `run-plan.ts`, `errors.ts`, and their tests; modify `index.ts`.

**Interfaces:**
- Consumes: `LocalStore` (Task 1); `CompileOutput`, `ActivationPlan` from `@zzpersona/adapter-sdk`.
- Produces: `writeBuild(output: CompileOutput, options: { buildDir: string; store: LocalStore }): Promise<void>`; `runPlan(plan: ActivationPlan, options: { secretEnv: Record<string, string>; env?: NodeJS.ProcessEnv }): Promise<number>`; `class ExecutorError extends Error`.

- `writeBuild`: ensure `dirname(dirname(buildDir))` (the `build/` dir) exists with mode `0o700`; write into `${buildDir}.tmp-<pid>-<random>`; content files with `mode ?? 0o644`; for `copyFrom`, `store.locate(source)` (absent → `ExecutorError`), then every path copied — the source and, for a directory, each entry found with `lstat` — must have a `realpath` inside `realpath(root)`; copy with `cp(..., { recursive: true, dereference: true })`; then swap: rename an existing `buildDir` to `.old-<pid>`, rename tmp into place, remove old. On any error remove tmp and rethrow; the previous build is untouched.
- `runPlan`: steps in order. `overlay` → `ExecutorError("overlay steps are not supported until the agents-md adapter")`. `launch` → `spawn(command, args, { cwd, env: { ...(env ?? process.env), ...step.env, ...secretEnv }, stdio: "inherit" })`; forward `SIGINT`/`SIGTERM` while it runs; spawn ENOENT → `ExecutorError("command not found: <command>")`; result is the exit code (`1` if killed by a signal); stop at the first non-zero.

- [ ] **Step 1: `gh stack add feature/cli-4-executor-run`.**
- [ ] **Step 2: Write failing tests** (temp personas mount): content and `copyFrom` files land with the right modes; a second `writeBuild` replaces the first; a `copyFrom` of `../outside` and of a skill directory containing a symlink to a file outside the mount both throw, and the previous build is still intact; `build/` is `0700`; `runPlan` returns 3 for `node -e "process.exit(3)"`; passes `step.env` and `secretEnv` (child exits 0 only if `ZZ_A === "a"` and `ZZ_SECRET === "s"`); an `overlay` step throws the exact message; a missing command throws `command not found: zz-nope`.
- [ ] **Step 3–5:** run (FAIL), implement, run (PASS).
- [ ] **Step 6: Commit** `feat(executor): atomic builds with per-mount containment, and runPlan`.

### Task 5: CLI scaffold, config, persona selection, `resolve` — layer `feature/cli-5-cli-resolve`

**Files:** Create `src/apps/cli/{package.json,tsconfig.json,tsconfig.build.json,eslint.config.js}`, `src/bin.ts`, `src/cli.ts`, `src/config.ts`, `src/context.ts`, `src/select.ts`, `src/errors.ts`, `src/commands/resolve.ts`, `src/test/seed.ts` (test-only, excluded from build), `src/resolve.test.ts`. Modify root `package.json` (script `"zzpersona": "node src/apps/cli/dist/bin.js"`).

**Interfaces:**
- Consumes: Tasks 1–3; `resolve`, `explain`, `ResolveError` from `@zzpersona/resolver`.
- Produces: `interface CliIo { env: NodeJS.ProcessEnv; cwd: string; stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown }; probe: Probe; runPlan?: typeof runPlan; now?: () => number }`; `createCli(io: CliIo): { run(argv: string[]): Promise<number> }`; `class CliError extends Error { code: string; details: Record<string, unknown> }`; `loadConfig(home: string): Promise<{ personas?: string }>`; `interface Context { home: string; projectDir?: string; store: LocalStore }` from `createContext(io): Promise<Context>`; `selectPersona(arg: string | undefined, ctx: Context): Promise<Ref>`; test helper `seed(): Promise<{ home: string; personas: string; repo: string; cleanup(): Promise<void> }>` that lays out resolver fixture 002 (org/area/team into `personas`, `project/checkout-api.yaml` → `<repo>/.zzpersona/persona.yaml`, `user/overrides.yaml` → `<home>/overrides.yaml`), writes `<home>/config.yaml` with `personas:`, and creates the files fixture 002 references (`org/instructions/conduct.md`, `org/hooks/block-prod-db.sh`, `team/skills/run-payment-sim/SKILL.md`, `.zzpersona/instructions/checkout-overview.md`, `.zzpersona/hooks/format.sh`).

Output formats:
- `resolve` summary (stdout): `<metadata.name> (<ref>)`, then `layers: <l1> → <l2> → …`, then `warnings: <n>`. Each warning on stderr: `warning: <code> <path> (from <layer>)`.
- Errors (stderr): `error: <code>: <k>=<v>, …` for `ResolveError`/`CliError`/`StoreError`; with `--json`, stdout `{"error":{"code":…,…}}`. Exit 1.
- Selection errors: `no-persona` (not in a project; `details.available` lists refs), `unknown-persona`, `ambiguous-persona` (`details.candidates`).

- [ ] **Step 1: `gh stack add feature/cli-5-cli-resolve`.**
- [ ] **Step 2: Write failing tests** with `seed()` and a fake probe:
  - in `<repo>`: `resolve` → exit 0, stdout starts `checkout-api (project/persona)`, layers `org/base → area/fintech → team/payments → project/persona → user/overrides`, `warnings: 1`, stderr `warning: allow-shadowed-by-ask permissions.allow[Bash(pnpm test:*)] (from team/payments)`.
  - `resolve --no-overlay` → layers end at `project/persona`.
  - `resolve team/payments --json` → JSON `ir.metadata.name === "payments-platform"`.
  - `resolve payments` → same as `team/payments`; with an extra `<personas>/team/x/base.yaml`, `resolve base` → exit 1, `ambiguous-persona` listing `org/base` and `team/x/base`.
  - outside any project, `resolve` → exit 1, `no-persona`, stderr lists the available refs.
  - `resolve --explain` → stdout equals `explain(result)`.
  - with a stray `<personas>/user/` folder → stderr `warning: <personas>/user is ignored: project/ and user/ layers are mounted elsewhere` (from `strayLayerDirs()`), command still succeeds.
  - config `personas: ~/p` with `env.HOME` set to a temp dir → store mounts `<HOME>/p` (Review Focus 1).
  - a missing-ref error with `--json` → stdout `{"error":{"code":"missing-ref",…}}`, exit 1.
- [ ] **Step 3–5:** run (FAIL), implement (commander `exitOverride`, output to `io.stdout`/`io.stderr`), run (PASS).
- [ ] **Step 6: Commit** `feat(cli): config, persona selection and resolve`.

### Task 6: `compile` — layer `feature/cli-6-compile`

**Files:** Create `src/apps/cli/src/commands/compile.ts`, `src/harness.ts`, `src/compile.test.ts`; modify `cli.ts`.

**Interfaces:**
- Consumes: Tasks 4–5; `adapter` default export of `@zzpersona/adapter-claude-code`; `renderBuild`.
- Produces: `HARNESSES: Record<string, HarnessAdapter>` = `{ "claude-code": adapter }`; `prepareBuild(ctx: Context, io: CliIo, options: { persona: Ref; harness: string; facts?: Detection["facts"]; overlay: boolean; passthrough: string[] }): Promise<{ result: ResolveResult; detection: Detection; output: CompileOutput; plan: ActivationPlan; buildDir: string; secretRefs: string[] }>` (texts read with `store.readText` for every `file` instruction; `plan` from `activate` with `cwd: io.cwd`). Task 7 reuses it.

Output: stdout `build: <buildDir>`; each report entry on stderr `<outcome>: <path> — <reason>` (plus ` [locked: <lock.path> by <lock.layer>]`). `--dry-run` → stdout `renderBuild(output, plan)`, nothing written. `--json` → `{ buildDir, report, secretRefs, plan }`. Unknown harness → `CliError` `unknown-harness`.

- [ ] **Step 1: `gh stack add feature/cli-6-compile`.**
- [ ] **Step 2: Write failing tests:** in `<repo>`, `compile` → build dir under `<home>/build/project-persona-`, containing `settings.json`, `system-prompt.md` (with the seeded `checkout-overview.md` text) and `plugin/skills/run-payment-sim/SKILL.md`; stderr has `dropped: skills[pr-review] — skill registries are not supported in v0`; `--dry-run` writes nothing and prints `mode: relaunch`; `--json` has `secretRefs: ["secret://vault/payments/schema-token"]` and no secret values; `--harness codex` → `unknown-harness`; deleting `.zzpersona/instructions/checkout-overview.md` → exit 1 with one error naming `project/instructions/checkout-overview.md` and its physical path (Review Focus 4).
- [ ] **Step 3–5:** run (FAIL), implement, run (PASS).
- [ ] **Step 6: Commit** `feat(cli): compile`.

### Task 7: `claude`, end-to-end, changeset — layer `feature/cli-7-claude`

**Files:** Create `src/apps/cli/src/commands/claude.ts`, `src/claude.test.ts`, `src/e2e.test.ts`, `.changeset/cli-core-loop.md`; modify `cli.ts`, `CLAUDE.md`.

**Interfaces:** Consumes `prepareBuild` (Task 6), `resolveSecrets` (Task 2), `writeBuild`/`runPlan` (Task 4).

Flow: select → `prepareBuild` with `--mode` mapped to facts (`partial` → `{ sideloadBlocked: true }`, `relaunch-no-mcp` → `{ managedMcp: true }`, merged over detected facts) → if not installed and not dry-run: `CliError` `claude-not-installed` → dry-run/`--json`: print and stop → `resolveSecrets(secretRefs, ir.secrets.providers, { env: io.env })` → map to `{ <placeholder>: value }` via `output.secretEnv` → `writeBuild` → `(io.runPlan ?? runPlan)(plan, { secretEnv, env: io.env })`; if the exit code ≠ 0 and less than 5000 ms passed (`io.now ?? Date.now`), stderr: `If Claude Code said flags are disabled by managed settings, retry with --mode partial.`; return the exit code.

- [ ] **Step 1: `gh stack add feature/cli-7-claude`.**
- [ ] **Step 2: Write failing tests** with a fake `runPlan` that records its arguments: `claude -- -p hi` passes `["-p", "hi"]` after the adapter's flags; `--mode partial` → args start `--settings` (no `--plugin-dir`); with the seeded persona's secret unset → exit 1, `SecretResolutionError` message, `runPlan` never called; with `SCHEMA_TOKEN` env and the vault provider replaced by `{type: env}` in the seed → `secretEnv` `{ ZZP_SECRET_1: "<value>" }`; a fake `runPlan` returning 1 with `now` advancing 1000 ms prints the hint, advancing 10000 ms does not; run from `<repo>/src/deep` → found project, plan `cwd` = `<repo>/src/deep` (Review Focus 3); `--json` prints the plan and never calls `runPlan`; probe reporting not installed → `claude-not-installed`.
- [ ] **Step 3–5:** run (FAIL), implement, run (PASS).
- [ ] **Step 6:** `e2e.test.ts`, skipped unless `ZZP_E2E === "1"`: build the CLI, seed a persona like the adapter e2e (inline `ZZ-PROMPT-CODEWORD` instruction, a `zz-probe-skill` skill, a SessionStart hook echoing `ZZ-HOOK-CODEWORD`, the spike's `mcp-server.mjs`), run `node dist/bin.js claude --dry-run` (exit 0), then `node dist/bin.js claude -- -p --model haiku --output-format json "<prompt>"` with stdout piped; assert the four codewords. Run once with `ZZP_E2E=1`.
- [ ] **Step 7:** changeset (`minor` for `store-local`, `secrets`, `executor`, `cli`); `CLAUDE.md` current phase: core loop built, next spec 07.
- [ ] **Step 8: Run** `CI=1 pnpm turbo run build check-types lint test --force` and `pnpm format:check` — PASS.
- [ ] **Step 9: Commit** `feat(cli): zzpersona claude`.
