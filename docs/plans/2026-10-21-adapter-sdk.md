# Adapter SDK and Claude Code Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@zzpersona/adapter-sdk` (the adapter contract, compile-report helpers and conformance kit) and `@zzpersona/adapter-claude-code` (the first adapter, on the verified relaunch path).

**Architecture:** Adapters are pure: `compile(input)` returns files, secret placeholders and a report; `activate(input)` returns a plan of `launch`/`overlay` steps. Only `detect(probe)` observes the machine, through a probe the caller supplies. The SDK derives "no silent loss" from each adapter's capability matrix, and a framework-neutral conformance kit checks every adapter against a shared corpus.

**Tech Stack:** TypeScript 7, Node 26 (floor 24), pnpm workspaces, turborepo, vitest 5, `yaml` (dev), `@zzpersona/spec`.

**Spec:** `docs/planning/05-adapter-sdk.md`

## Global Constraints

- Branch: `feature/adapter-sdk` from `develop`; one squash-merged PR at the end (CLAUDE.md git flow).
- Every package `"private": true`, `"type": "module"`, `engines` inherited (Node `>=24`), `@types/node` `^24`.
- Package layout copies `src/packages/resolver/` exactly: `package.json` scripts `build` (`tsc -p tsconfig.build.json`), `test` (`vitest run --passWithNoTests`), `lint` (`eslint . --max-warnings 0`), `check-types` (`tsc --noEmit`); `tsconfig.json`, `tsconfig.build.json` (excludes `src/**/*.test.ts`), `eslint.config.js`.
- `ADAPTER_API_VERSION = 1`; adapters accept `IR_VERSION` (`0`) from `@zzpersona/spec`.
- Secret placeholder format: `ZZP_SECRET_<n>`, `n` from 1, referenced in files as `${ZZP_SECRET_<n>}`.
- Claude Code plugin name: `zzp-` + `personaId` with `/` replaced by `-` (e.g. `zzp-project-checkout-api`).
- Managed settings directories: macOS `/Library/Application Support/ClaudeCode/`, Linux `/etc/claude-code/`, Windows `C:\Program Files\ClaudeCode\`. Files: `managed-settings.json`, `managed-settings.d/*.json`, `managed-mcp.json`.
- `compile` and `activate` must not touch the file system, network or processes.
- Run `pnpm exec prettier --write` on changed sources before each commit; `CI=1 pnpm turbo run build check-types lint test` must pass at the end of every task.

## Review Focus

1. **A persona with no instructions and no knowledge** → no `system-prompt.md` and no `--append-system-prompt-file` flag (an empty prompt file is noise). Test in Task 7.
2. **The same secret ref used by two servers** → one placeholder, reused, so the user resolves each secret once. Test in Task 6.
3. **A nested persona id** (`team/platform/payments`) → plugin name `zzp-team-platform-payments`, a valid plugin name. Test in Task 6.
4. **User passthrough args that repeat our flags** (`-- --mcp-config extra.json`) → appended unchanged after ours, never reordered or dropped. Test in Task 7.
5. **Windows** → `detect` reads `C:\Program Files\ClaudeCode\…`, not a POSIX path. Test in Task 5.

Known limitation (documented, not tested): `disableSideloadFlags` delivered by MDM profile, registry or server-managed settings is invisible to a file probe. The CLI spec must surface Claude Code's own startup error for that case.

## File Structure

```
src/packages/adapter-sdk/
  src/types.ts            contract types (sections 1–2 of the spec)
  src/define.ts           ADAPTER_API_VERSION, defineAdapter(), error classes
  src/report.ts           requiredEntries(), annotateLocks()
  src/render.ts           renderBuild()
  src/index.ts            public exports
  src/conformance/corpus/ minimal.ts, kitchen-sink.ts, full.json, index.ts
  src/conformance/checks.ts   runConformance()
  src/conformance/suite.ts    conformanceSuite() (vitest wrapper)
  src/conformance/index.ts    ./conformance subpath exports
  scripts/update-corpus.mjs   rewrites full.json from resolver fixture 002
src/packages/adapters/claude-code/
  src/capabilities.ts     matrix
  src/detect.ts           detect()
  src/compile.ts          compile() and its mode logic
  src/activate.ts         activate()
  src/index.ts            defineAdapter({...}) default export
  test/golden/<corpus>.<mode>.txt
```

---

### Task 1: SDK package, contract types and `defineAdapter`

**Files:**
- Create: `src/packages/adapter-sdk/{package.json,tsconfig.json,tsconfig.build.json,eslint.config.js}`, `src/types.ts`, `src/define.ts`, `src/index.ts`, `src/define.test.ts`
- Modify: `docs/planning/05-adapter-sdk.md` (two amendments below)

**Interfaces:**
- Consumes: `ResolvedPersona`, `Ref`, `HookEvent`, `HOOK_EVENTS`, `IR_VERSION` from `@zzpersona/spec`.
- Produces: every type in spec sections 1–2 (`HarnessAdapter`, `Probe`, `Detection`, `CompileInput`, `CompileOutput`, `FileEntry`, `ActivateInput`, `ActivationPlan`, `Step`, `Support`, `CapabilityField`, `CapabilityMatrix`, `CompileReport`, `ReportEntry`), with these amendments:
  - `Probe` gains `listDir(path: string): Promise<string[] | undefined>` (needed for `managed-settings.d/`).
  - `ActivateInput` gains `ir: ResolvedPersona` and `output: CompileOutput` (activate must know what was compiled, e.g. whether `system-prompt.md` exists).
- Produces: `ADAPTER_API_VERSION = 1`; `defineAdapter(declaration: Omit<HarnessAdapter, "apiVersion">): HarnessAdapter`; `class AdapterDeclarationError extends Error`; `class UnsupportedIrVersionError extends Error { irVersion: number; adapter: string }`; `class AdapterInputError extends Error`; `assertIrVersion(adapter: HarnessAdapter, ir: ResolvedPersona): void` (throws `UnsupportedIrVersionError`).

- [ ] **Step 1: Write failing tests** in `define.test.ts`:
  - `defineAdapter` returns the declaration with `apiVersion: 1`.
  - throws `AdapterDeclarationError` for id `"Claude_Code"`, for `irVersions: []`, and for a matrix field `"permissions.denny"`; accepts `"hooks.pre-tool-use"` and `"targets.anything"`.
  - `assertIrVersion` throws `UnsupportedIrVersionError` with `irVersion: 99` for an IR whose `irVersion` is 99 and the adapter accepts `[0]`.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/adapter-sdk test` — expect FAIL (module not found).
- [ ] **Step 3: Implement** `types.ts`, `define.ts`, `index.ts`. Valid matrix fields: the fixed names, `hooks.<HOOK_EVENTS>`, and any `targets.<non-empty>`.
- [ ] **Step 4: Amend** spec section 1 with the two interface changes above, as a dated note.
- [ ] **Step 5: Run** tests — PASS; run `pnpm install` so the workspace links the new package.
- [ ] **Step 6: Commit** `feat(adapter-sdk): contract types and defineAdapter`.

### Task 2: `requiredEntries` and `annotateLocks`

**Files:** Create `src/packages/adapter-sdk/src/report.ts`, `report.test.ts`; modify `index.ts`.

**Interfaces:**
- Consumes: `lockCovers`, `parsePath` from `@zzpersona/spec`; Task 1 types.
- Produces: `requiredEntries(adapterId: string, matrix: CapabilityMatrix, ir: ResolvedPersona): Array<{ path: string; outcome: ReportEntry["outcome"] }>`; `annotateLocks(report: CompileReport, ir: ResolvedPersona): CompileReport` (returns a copy; sets `lock` from the first covering `ir.locks` entry).

Paths `requiredEntries` emits for a field whose support is not `native` (absent = `none` → `dropped`; `advisory` → `advisory`; `approximated` → `approximated`):

| Field | One entry per |
|---|---|
| `instructions` | `instructions[<id>]` |
| `skills` | `skills[<name>]` |
| `mcp.servers` | `mcp.servers.<name>` |
| `knowledge` | `knowledge[<id>]` |
| `secrets` | `mcp.servers.<name>.env.<KEY>` whose value starts with `secret://` |
| `permissions.<list>` | `permissions.<list>[<rule>]` |
| `hooks.<event>` | `hooks.<event>[<id>]` |
| `targets.<id>` | only `targets.<adapterId>`, once, if present (other harnesses' blocks are not loss) |

- [ ] **Step 1: Write failing tests:** with an IR holding one deny rule, one `notification` hook, two knowledge items and `targets: { codex: {...} }`, and matrix `{ "permissions.deny": advisory, knowledge: none }`: expect exactly `permissions.deny[<rule>]: advisory`, `knowledge[a]: dropped`, `knowledge[b]: dropped`, `hooks.notification[<id>]: dropped`, and nothing for `targets.codex` or for a `native` field. `annotateLocks` with lock `permissions.deny` by `org/base` sets `lock: { path: "permissions.deny", layer: "org/base" }` on the deny entry and leaves the knowledge entries without `lock`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(adapter-sdk): derive required report entries and annotate locks`.

### Task 3: `renderBuild` and `renderCapabilities`

**Files:** Create `src/packages/adapter-sdk/src/render.ts`, `render.test.ts`; modify `index.ts`.

**Interfaces:** Produces `renderBuild(output: CompileOutput, plan: ActivationPlan): string` and `renderCapabilities(adapters: HarnessAdapter[]): string` — a Markdown table, one row per `CapabilityField` that any adapter declares (rows in `CapabilityField` declaration order, hook events in `HOOK_EVENTS` order), one column per adapter id, cells `native` / `approximated` / `advisory` / `—` (for `none` or absent); the docs site will publish it (spec section 2). Test: two toy adapters render an exact expected table.

Format (exact section headers; omit a section when empty):
```
mode: <report.mode or "default">
files (<n>)
  <path> (<mode octal, default 0644>)
    <content, each line indented 4 spaces>
  <path> <- copy <copyFrom>
secretEnv (<n>)
  <NAME> = <ref>
report (<n>)
  <outcome>  <path>  <reason>[  locked: <lock.path> by <lock.layer>]
plan (<n>)
  launch <command> <args joined by space>
    env: <sorted env keys joined by ", ">
  overlay <path> (<content length> chars)
```
Files and secretEnv sorted by key; report and plan in their given order. Ends with a newline.

- [ ] **Step 1: Write failing tests:** a fixed output with one content file, one `copyFrom`, one secret, one locked report entry and one launch step renders to an exact expected string (write it in the test); rendering twice is identical; files given in reverse order render sorted.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(adapter-sdk): renderBuild for golden builds`.

### Task 4: Conformance corpus and kit

**Files:**
- Create: `src/packages/adapter-sdk/src/conformance/{corpus/minimal.ts,corpus/kitchen-sink.ts,corpus/full.json,corpus/index.ts,checks.ts,suite.ts,index.ts}`, `scripts/update-corpus.mjs`, `src/conformance/corpus.test.ts`, `src/conformance/checks.test.ts`
- Modify: `package.json` (`exports["./conformance"]`, `peerDependencies: { vitest: "^5" }` with `peerDependenciesMeta.vitest.optional`, devDependency `yaml`, script `corpus:update`)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `interface CorpusEntry { name: "minimal" | "full" | "kitchen-sink"; personaId: Ref; ir: ResolvedPersona; texts: Record<string, string> }`; `corpus: CorpusEntry[]`; `interface CheckResult { name: CheckName; corpusEntry?: string; passed: boolean; reason?: string }`; `type CheckName = "declaration" | "rejects-unsupported-ir" | "deterministic" | "well-formed-output" | "no-secret-leaks" | "no-silent-loss" | "detect-not-installed" | "no-writes"`; `runConformance(adapter: HarnessAdapter, options?: { detection?: Detection }): Promise<CheckResult[]>`; `conformanceSuite(adapter: HarnessAdapter, options?): void` (one vitest `it` per result).

Corpus contents:
- `minimal`: fixture 001's resolved IR, `personaId: "team/solo"`, `texts: {}`.
- `full`: `full.json` = fixture 002's `expect.resolved`; `texts` for its two `file` instructions with short placeholder text. `update-corpus.mjs` regenerates `full.json` from `src/packages/resolver/fixtures/002-full-stack/case.yaml`.
- `kitchen-sink`: one hook per `HOOK_EVENTS` entry; servers of all three forms (`ref`, `command` with two `secret://` env values one of which repeats, `url`); one `registry://` and one local skill; a lock on each of `permissions.deny`, `mcp.servers`, `hooks.notification`; a 20 000-character inline instruction; `targets` for `claude-code` and `codex`.

Checks run per corpus entry (detection defaults to `{ installed: true, version: "0.0.0", facts: {} }`):
- `declaration`, `rejects-unsupported-ir`: once per adapter.
- `deterministic`: compile twice and activate twice → `isDeepStrictEqual`.
- `well-formed-output`: file and overlay paths relative, no `..` segment; `copyFrom` relative, no `..`; mode in {0o600, 0o644, 0o755}; launch `command` non-empty.
- `no-secret-leaks`: no `secret://` in any file `content` or launch `args`; every `secret://` in the IR appears in `secretEnv` values or in a `dropped` report entry.
- `no-silent-loss`: every `requiredEntries` item has a report entry with the same `path` and `outcome`; every report path names a value present in the IR; lock annotations equal `annotateLocks` output.
- `detect-not-installed`: fake probe whose `run` returns exit 127 and whose `readFile`/`listDir` return `undefined` → `installed: false`, no throw.
- `no-writes`: run compile and activate with `process.cwd()` changed to a fresh temp dir; the dir is still empty afterward. (`process.chdir` needs vitest's `forks` pool, the default; restore the cwd in a `finally`.)

- [ ] **Step 1: Write failing tests** in `corpus.test.ts`: every entry's `ir` passes `ResolvedPersona.parse`; `full.json` deep-equals fixture 002's `expect.resolved` (read with `yaml`); `kitchen-sink` has a hook for every `HOOK_EVENTS` value.
- [ ] **Step 2: Write failing tests** in `checks.test.ts`: a correct toy adapter (matrix `{ instructions: native }`, emits instructions to one file and reports everything else) passes every check; then one broken toy adapter per check, each failing **exactly** that check: wrong id; accepts `irVersion` 99; uses `Math.random()` in a file; writes `../x`; copies a `secret://` value into a file; omits a required entry; throws in `detect`; writes a file in `compile`.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement** corpus, checks, suite, script. **Step 5: Run** — PASS.
- [ ] **Step 6: Commit** `feat(adapter-sdk): conformance corpus and kit`.

### Task 5: Claude Code adapter package, capabilities and `detect`

**Files:** Create `src/packages/adapters/claude-code/{package.json,tsconfig.json,tsconfig.build.json,eslint.config.js}`, `src/capabilities.ts`, `src/detect.ts`, `src/index.ts`, `src/detect.test.ts`.

**Interfaces:**
- Consumes: `defineAdapter`, types from `@zzpersona/adapter-sdk`.
- Produces: `capabilities(): CapabilityMatrix` — `instructions`, `skills`, `mcp.servers`, `secrets`, `permissions.allow|deny|ask`, `hooks.<each of HOOK_EVENTS>`, `targets.claude-code`: `native`; `knowledge`: `advisory`. `detect(probe: Probe): Promise<Detection>` with `facts: { sideloadBlocked: boolean; managedMcp: boolean }`. `index.ts` default-exports `defineAdapter({ id: "claude-code", irVersions: [0], capabilities, detect, compile, activate })` (compile/activate stubs that throw until Tasks 6–7).

- [ ] **Step 1: Write failing tests** with a fake probe:
  - `claude --version` → `"2.1.306 (Claude Code)"` gives `version: "2.1.306"`; exit 127 gives `installed: false` and both facts `false`.
  - darwin: `managed-settings.json` with `{"disableSideloadFlags": true}` → `sideloadBlocked: true`; the same key only in `managed-settings.d/50-team.json` → `true`; `managed-mcp.json` present → `managedMcp: true`.
  - linux reads `/etc/claude-code/…`; win32 reads `C:\Program Files\ClaudeCode\…` (Review Focus 5).
  - malformed JSON in a managed file → that file ignored, no throw.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(adapter-claude-code): capabilities and detect`.

### Task 6: `compile` (relaunch mode)

**Files:** Create `src/packages/adapters/claude-code/src/compile.ts`, `compile.test.ts`; modify `index.ts`.

**Interfaces:** Produces `compile(input: CompileInput): CompileOutput` with `report.mode = "relaunch"` when neither fact is set. Uses `assertIrVersion`, `annotateLocks`; throws `AdapterInputError` when `texts` lacks a referenced instruction file.

Build files (spec section 5):
- `system-prompt.md`: instruction fragments in order (inline text or `texts[file]`), each `trimEnd()`, joined by `"\n\n"`; then, if `knowledge` is non-empty, `"\n\n## Knowledge sources\n"` + `- <id>: <source>` lines. Omitted entirely when both are empty.
- `plugin/.claude-plugin/plugin.json`: `{ "name": <plugin name>, "version": "0.0.0", "description": "Persona <ir.metadata.name>" }`.
- `plugin/skills/<name>`: `{ copyFrom: <source> }` for local sources; `registry://` → report `dropped`, reason `skill registries are not supported in v0`.
- `plugin/hooks/hooks.json`: `{ hooks: { <NativeEvent>: [{ matcher?, hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/<id>-<basename(run)>" }] }] } }`; events `session-start→SessionStart`, `session-end→SessionEnd`, `user-prompt-submit→UserPromptSubmit`, `pre-tool-use→PreToolUse`, `post-tool-use→PostToolUse`, `stop→Stop`, `subagent-stop→SubagentStop`, `pre-compact→PreCompact`, `notification→Notification`. Scripts: `plugin/hooks/scripts/<id>-<basename>` = `{ copyFrom: run, mode: 0o755 }`.
- `mcp.json`: `{ "mcpServers": {...} }`; `command` form keeps `command`/`args`/`env` with secrets replaced; `url` form → `{ type: transport ?? "http", url, headers? }`; `ref` form → report `dropped`, reason `gateway:// refs need gateway resolution, which is not available yet`.
- `settings.json`: `{ permissions: { allow, deny, ask }, ...targets["claude-code"] without "strictMcp" }`.
- `secretEnv`: placeholders numbered by first appearance, walking servers by name then env keys by name; an identical ref reuses its placeholder.
- Report: knowledge items `advisory` (reason `rendered as text in the system prompt`); all entries passed through `annotateLocks`.

- [ ] **Step 1: Write failing tests** against the `full` and `kitchen-sink` corpus entries: exact `system-prompt.md` for `full`; plugin name `zzp-project-checkout-api`, and `zzp-team-platform-payments` for `team/platform/payments` (Review Focus 3); `hooks.json` maps all nine events; `registry://` skill and `ref` server reported `dropped` with the exact reasons; kitchen-sink's repeated secret ref yields one placeholder (Review Focus 2); `settings.json` excludes `strictMcp`; missing `texts` entry throws `AdapterInputError`.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(adapter-claude-code): compile for the relaunch path`.

### Task 7: Degraded modes and `activate`

**Files:** Create `src/packages/adapters/claude-code/src/activate.ts`, `activate.test.ts`; modify `compile.ts`, `compile.test.ts`, `index.ts`.

**Interfaces:** Produces `activate(input: ActivateInput): ActivationPlan` with exactly one `launch` step, `command: "claude"`, `env: {}` (the CLI adds secret values), `cwd: input.cwd`.

Modes (from `detection.facts`; `sideloadBlocked` wins):
- `partial`: no `plugin/` files, no `mcp.json`; skills, hooks and MCP servers each reported `dropped`, reason `disableSideloadFlags blocks --plugin-dir and --mcp-config`.
- `relaunch-no-mcp`: no `mcp.json`; MCP servers reported `dropped`, reason `managed-mcp.json makes --mcp-config exit`.

Args, in this order, each only when applicable: `--plugin-dir <buildDir>/plugin` (a `plugin/` file exists); `--settings <buildDir>/settings.json` (always); `--mcp-config <buildDir>/mcp.json` (file exists) then `--strict-mcp-config` (unless `targets["claude-code"].strictMcp === false`); `--append-system-prompt-file <buildDir>/system-prompt.md` (file exists); then `passthrough` unchanged.

- [ ] **Step 1: Write failing tests:** full args for `full` in each of the three modes; `strictMcp: false` drops only `--strict-mcp-config`; an IR with no instructions and no knowledge has no `system-prompt.md` and no prompt flag (Review Focus 1); passthrough `["--mcp-config", "extra.json"]` appears verbatim after ours (Review Focus 4); `partial` report entries carry the exact reason.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(adapter-claude-code): degraded modes and activate`.

### Task 8: Conformance, golden builds, end-to-end, changeset

**Files:** Create `src/packages/adapters/claude-code/src/conformance.test.ts`, `src/golden.test.ts`, `test/golden/*.txt`, `src/e2e.test.ts`, `.changeset/adapter-sdk.md`; modify `CLAUDE.md` (current phase line).

**Interfaces:** Consumes everything above.

- [ ] **Step 1:** `conformance.test.ts`: `conformanceSuite(adapter)`. Run — every check passes for all three corpus entries.
- [ ] **Step 2:** `golden.test.ts`: for each corpus entry × mode (`relaunch`, `partial`, `relaunch-no-mcp`), `expect(renderBuild(output, plan)).toMatchFileSnapshot("../test/golden/<entry>.<mode>.txt")` with `buildDir: "/BUILD"`, `cwd: "/PROJECT"`, `passthrough: []`. Generate with `vitest run -u`, then read `full.relaunch.txt` and confirm it matches spec section 5 by eye.
- [ ] **Step 3:** `e2e.test.ts`, skipped unless `ZZP_E2E === "1"`: build a temp personas root containing a skill (`SKILL.md` saying `ZZ-SKILL-CODEWORD`), a SessionStart hook script echoing `ZZ-HOOK-CODEWORD`, an inline instruction `ZZ-PROMPT-CODEWORD`, and the spike's `mcp-server.mjs` as a command server; compile; write files and copies with a minimal test-only materializer; run the launch step with `-p --model haiku --output-format json` and a prompt asking for the codewords; assert all four appear. Run once with `ZZP_E2E=1` and record the result in the PR.
- [ ] **Step 4:** `.changeset/adapter-sdk.md`: `"@zzpersona/adapter-sdk": minor`, `"@zzpersona/adapter-claude-code": minor`, one-paragraph summary. Update `CLAUDE.md` current phase: adapter SDK and Claude Code adapter done; next is the CLI spec.
- [ ] **Step 5: Run** `CI=1 pnpm turbo run build check-types lint test --force` — PASS.
- [ ] **Step 6: Commit** `test(adapter-claude-code): conformance, golden builds, e2e`; push; open PR into `develop`.
