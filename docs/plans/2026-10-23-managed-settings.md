# Managed Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Org, area and team locks compile to a Claude Code managed policy bundle that
`zzpersona managed install` puts on a machine and `zzpersona managed check` verifies; the registry
contract serves the same bundle.

**Architecture:** A `gh stack` on `feature/managed-0-spec` (`gh stack add
feature/managed-<n>-<name>`). `@zzpersona/spec` and the resolver gain the `policy` block; the
adapter SDK gains managed types and an optional `managed` member; `@zzpersona/adapter-claude-code`
implements the pure compile; the CLI gets `managed build|install|uninstall|check`; `registry-api`
gains the route (mock and kit take the compile as an injected function, so `registry-api` does not
depend on adapters).

**Tech Stack:** TypeScript, Node 26, zod 4, vitest, Docker (opt-in e2e). No new dependencies.

**Spec:** `docs/planning/21-managed-settings.md`

## Global Constraints

- System roots: `macos` `/Library/Application Support/ClaudeCode`, `linux`
  `/etc/claude-code`, `windows` `C:\Program Files\ClaudeCode`.
- Bundle paths (relative to the root): `managed-settings.d/50-zzpersona.json` (always),
  `managed-mcp.json` (only for `policy.mcp: exclusive`), `zzpersona/hooks/<event>-<id>-<basename of
  run>`, `zzpersona/manifest.json`. Manifest `files` lists every file except itself, by sha256 hex.
- Manifest: `{ format: 1, zzpersona, os, layers: [{ ref, version?, digest }], files, minClaudeCode?,
  report }`. JSON written with sorted keys, 2-space indent, trailing newline; no timestamps.
- `policy` keys and values: `permissions: "exclusive"`, `hooks: "exclusive"`, `mcp: "exclusive"`,
  `bypassPermissions: "disabled"`. Mapping: `allowManagedPermissionRulesOnly: true`,
  `allowManagedHooksOnly: true`, `allowManagedMcpServersOnly: true` + `managed-mcp.json`,
  `permissions.disableBypassPermissionsMode: "disable"`.
- New resolver error code `policy-in-lower-layer`. Managed refusal codes `managed-secret`,
  `managed-mcp-needs-exclusive`, `managed-unknown-key`. Warning codes `partial-mode`,
  `plugin-hooks-dropped`, `console-hooks-approval`.
- `check` states, most severe first: `ignored`, `edited`, `overridden`, `stale`, `missing`,
  `current`. Exit 0 only for `current`.
- CLI copy: not admin → `managed install needs administrator rights; run: sudo zzpersona managed
  install <dir>` (Windows: `…; run it in an elevated PowerShell`, same for `uninstall`); nothing
  locked → `nothing in <ref> and its ancestors is locked; the bundle enforces nothing`; status line
  `managed: <state>` with `(<detail>)` when not current.
- Route `GET /v1/managed/bundle?layer&os&format&include` per spec §4; problems `not-found`,
  `managed-refused`, `managed-needs-files`, `invalid-request`, `format-unsupported` (501).
- Every layer passes `pnpm turbo run build check-types lint test` and `pnpm format:check`; commits
  end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Tests never write a real
  system folder, never need root, never read the real macOS managed preferences, Windows registry,
  `~/.zzpersona` or `~/.claude`.

## Review Focus

1. A chain with nothing locked → the build succeeds, prints the "enforces nothing" line, writes a
   bundle whose settings file is `{}` → Task 3 test "nothing locked builds an empty policy".
2. Re-running `install` with the same bundle → no file rewritten (mtimes unchanged), `check`
   `current` → Task 4 test "a second identical install writes nothing".
3. A bundle built with `--os windows` on macOS, installed on macOS → refused before any write,
   naming both OSes; hook commands in a Windows bundle use `C:\Program Files\ClaudeCode\…` quoted →
   Task 2 golden "windows" and Task 4 test "install refuses a bundle for another OS".
4. A lock on a whole section (`permissions`, `hooks`, `instructions`) versus single entries →
   the whole section, or only the locked entries, reach the policy → Task 2 tests "a section lock
   takes every entry" and "an entry lock takes only that entry".
5. An installed manifest with `format` greater than 1 (a newer zzpersona) → `check` and `install`
   stop with `installed by a newer zzpersona (<version>); upgrade zzpersona` and touch nothing →
   Task 4 test "a newer manifest format stops check and install".

---

### Task 1: The `policy` block (`feature/managed-1-policy`)

**Files:** Modify `src/packages/spec/src/{common.ts,persona.ts,ir.ts,index.ts}` and tests;
`src/packages/resolver/src/merge.ts` (and `resolve.ts` if the overlay check lives there), resolver
fixtures under `src/packages/resolver/fixtures/`.

**Interfaces (produces):** `Policy` (zod) and `type Policy = { permissions?: "exclusive"; hooks?:
"exclusive"; mcp?: "exclusive"; bypassPermissions?: "disabled" }` exported from `@zzpersona/spec`;
`Persona.policy?: Policy` (not in `PersonaOverlay`); `ResolvedPersona.policy: Policy` (default
`{}`); `ERROR_CODES` gains `"policy-in-lower-layer"`. `IR_VERSION` unchanged.

- [ ] **Step 1: Failing tests:**
  - spec: `it("accepts a policy block")`, `it("rejects unknown policy keys and values")`
    (`policy: { permissions: "shared" }`, `policy: { network: "exclusive" }`), `it("an overlay
    cannot carry policy")`.
  - resolver fixtures (the fixture suite is the executable merge spec): `policy-merges-down` (org
    sets `permissions`, team adds `hooks` → IR `{ permissions, hooks }`); `policy-locked-below` (org
    sets `policy.mcp`, team sets `policy.mcp` too → `lock-violation` at `policy.mcp`, same for
    `targets.claude-code.managed.deniedModels`); `policy-in-project` (a `project/` layer sets
    `policy` → `policy-in-lower-layer` naming the layer; same for
    `targets.claude-code.managed`); `policy-in-overlay` (the user overlay sets
    `targets.claude-code.managed` → `policy-in-lower-layer`); `policy-absent` (IR `policy: {}`).
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/spec --filter @zzpersona/resolver test` —
  Expected: FAIL.
- [ ] **Step 3: Implement.** `policy` and `targets.claude-code.managed` keys behave as implicitly
  locked by the layer that first sets them: any later layer setting the same key throws
  `lock-violation` with the key's path. Layer kind is the ref's prefix (`org`, `area`, `team` allowed).
  Provenance records `policy.<key>`.
- [ ] **Step 4: Run** the pipeline — Expected: PASS.
- [ ] **Step 5: Commit** `feat(spec): policy block for managed enforcement`.

### Task 2: `compileManaged` (`feature/managed-2-compile`)

**Files:** Create `src/packages/adapter-sdk/src/managed.ts` (types), modify
`src/packages/adapter-sdk/src/{types.ts,index.ts}`; create
`src/packages/adapters/claude-code/src/managed/{compile.ts,keys.ts,roots.ts,compile.test.ts}`,
`src/packages/adapters/claude-code/test/golden/managed/<case>/<os>/…`; modify
`src/packages/adapters/claude-code/src/{index.ts,compile.ts,capabilities.ts}`; regenerate
`docs/capabilities.md`; CLI `capabilities` output if it enumerates fields.

**Interfaces (produces), in `@zzpersona/adapter-sdk`:**
```ts
export type ManagedOs = "macos" | "linux" | "windows";
export interface ManagedLayer { ref: Ref; version?: number; digest: string }
export interface ManagedInput {
  ir: ResolvedPersona; layers: ManagedLayer[]; os: ManagedOs; zzpersona: string;
  texts: Record<string, string>;       // instruction files, keyed as in the IR
  scripts: Record<string, Uint8Array>; // hook run files, keyed as in the IR
}
export type ManagedCode = "managed-secret" | "managed-mcp-needs-exclusive" | "managed-unknown-key";
export interface ManagedEntry {
  path: string; layer: Ref; outcome: "enforced" | "advisory" | "refused";
  code?: ManagedCode; reason: string;
}
export interface ManagedReport {
  entries: ManagedEntry[];
  warnings: { code: "partial-mode" | "plugin-hooks-dropped" | "console-hooks-approval"; message: string }[];
}
export interface ManagedManifest {
  format: 1; zzpersona: string; os: ManagedOs; layers: ManagedLayer[];
  files: Record<string, string>; minClaudeCode?: string; report: ManagedReport;
}
export interface ManagedResult {
  report: ManagedReport;
  /** Absent when any entry is refused. Includes zzpersona/manifest.json. */
  bundle?: { files: Record<string, Uint8Array>; manifest: ManagedManifest };
}
export interface ManagedCompiler {
  inputs(ir: ResolvedPersona): { texts: string[]; scripts: string[] };
  compile(input: ManagedInput): ManagedResult;
  roots: Record<ManagedOs, string>;
}
// HarnessAdapter gains: managed?: ManagedCompiler
```
`@zzpersona/adapter-claude-code` exports `compileManaged`, `managedInputs`, `MANAGED_ROOTS` and sets
`adapter.managed`. `FIXED_CAPABILITY_FIELDS` gains `"policy"` (Claude Code `native`, note
"managed policy bundle"; every other built-in adapter `advisory`).

- [ ] **Step 1: Failing tests** in `managed/compile.test.ts`, each table row of spec §2 as a case
  with golden output for `macos`, `linux`, `windows` (`toMatchFileSnapshot` per file):
  - `it("locked permission rules reach the policy")`; `it("a section lock takes every entry")`;
    `it("an entry lock takes only that entry")` (lock `permissions.deny[Bash(rm -rf:*)]` only).
  - `it("locked hooks are copied and referenced by quoted absolute path")` — macOS command
    `"/Library/Application Support/ClaudeCode/zzpersona/hooks/pre-tool-use-block-prod-db-block-prod-db.sh"`
    (double-quoted), event `PreToolUse`, `matcher` kept.
  - `it("a locked https server goes to managedMcpServers")` → `managedMcpServers: { jira: { type:
    "http", url } }`; `it("a locked stdio server needs exclusive mcp")` → refused
    `managed-mcp-needs-exclusive`, no bundle; with `policy.mcp: exclusive` → `managed-mcp.json`
    `{ mcpServers: { name: { type: "stdio", command, args, env } } }` and
    `allowManagedMcpServersOnly: true`; exclusive with no locked servers → `{ "mcpServers": {} }`.
  - `it("refuses secret references")` (in `env`, `headers`, a URL) → `managed-secret`.
  - `it("locked instructions become claudeMd")` → only locked fragments, contract order, trimmed,
    joined by `\n\n`.
  - `it("gateway, skills, knowledge and providers are advisory")`.
  - `it("maps every policy key")`; `it("passes known managed keys through last")`;
    `it("refuses unknown managed keys")` → `managed-unknown-key`.
  - `it("warns when the policy weakens zzpersona launches")` — `disableSideloadFlags` or
    `managed-mcp.json` → `partial-mode`; `allowManagedHooksOnly` → `plugin-hooks-dropped`; any hook
    → `console-hooks-approval`.
  - `it("minClaudeCode is the highest floor among used keys")` (table: `managedMcpServers`
    `2.1.259`, `claudeMd` `2.1.260`, `deniedModels` `2.1.283`, `managedSourcesBehavior`
    `2.1.242`, `disableSideloadFlags` `2.1.193`; unlisted keys add no floor).
  - `it("is deterministic")` — two compiles, byte-equal files; manifest `files` hashes match.
  - `it("managedInputs lists only locked instruction files and hook scripts")`.
  - Capability matrix: `policy` row present for every built-in adapter.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/adapter-claude-code test` — Expected: FAIL.
- [ ] **Step 3: Implement.** Values are enumerated by the resolver's path forms
  (`permissions.<list>[<rule>]`, `hooks.<event>[<id>]`, `mcp.servers[<name>]`, `instructions[<id>]`,
  `skills[<name>]`, `knowledge[<id>]`, `secrets.providers[<name>]`, `mcp.gateway`) and kept when
  `lockCovers` any IR lock; the entry's `layer` is the lock's layer. `keys.ts` holds the
  passthrough allowlist (the managed-only and enforcement keys listed in the spec's facts section,
  plus `availableModels`, `env`, `cleanupPeriodDays`, `claudeMdExcludes`, `sandbox`,
  `extraKnownMarketplaces`, `enabledPlugins`, `forceLoginMethod`, `forceLoginOrgUUID`,
  `apiKeyHelper`, `permissions`) and the version table. The persona compile adds `managed` to
  `ADAPTER_KEYS` so it never reaches `settings.json` (test: `it("targets.claude-code.managed never
  reaches settings.json")` in `compile.test.ts`). Hook `run` is always a file, as the persona
  compile treats it.
- [ ] **Step 4: Run** the pipeline — Expected: PASS.
- [ ] **Step 5: Commit** `feat(claude-code): compile locks to a managed policy bundle`.

### Task 3: `zzpersona managed build` (`feature/managed-3-build`)

**Files:** Create `src/packages/registry-api/src/managed.ts` (+ test; `registry-api` gains a
dependency on `@zzpersona/adapter-sdk` for types), `src/apps/cli/src/managed/{build.ts,bundle-io.ts}`,
`src/apps/cli/src/commands/managed.ts`, `src/apps/cli/src/managed.test.ts`; modify
`src/apps/cli/src/cli.ts`.

**Interfaces:** consumes `ManagedCompiler` (Task 2); produces, in `@zzpersona/registry-api`,
`compileFromSource(compiler: ManagedCompiler, { source: PersonaSource; ref: Ref; os: ManagedOs;
layers: ManagedLayer[]; zzpersona: string; readFile(path: string): Promise<Uint8Array> }):
Promise<ManagedResult>` (resolves `ref`, reads `compiler.inputs(ir)` through `readFile`, compiles —
shared by the CLI, the mock and the control plane); in the CLI, `buildBundle(context, { layer?, os,
fromRegistry }): Promise<ManagedResult>`, `writeBundle(dir, files)`, `readBundle(dir): Promise<{
files; manifest }>` (verifies every hash; throws naming the first mismatch).

- [ ] **Step 1: Failing tests:** `it("builds the org layer by default")` (a store with one `org/`
  layer); `it("needs --layer when there are several org layers")`; `it("builds a team chain")`
  (`--layer team/payments` takes org and area locks); `it("nothing locked builds an empty policy")`
  (Review Focus 1); `it("refusals exit 1 and name the layer and path")`; `it("--json prints the
  report and the output path")`; `it("--from-registry downloads the bundle")` (mock registry with
  the compile injected; the written files equal a local build's); `it("refuses to overwrite a
  folder that is not a bundle")`, and replaces one that is; layer digests use `bundleDigest` and
  published versions when the layer came from the registry.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/cli exec vitest run managed.test.ts` — Expected:
  FAIL.
- [ ] **Step 3: Implement** `managed build [--layer <ref>] [--os macos|linux|windows] [--out
  <dir>] [--from-registry] [--json]`; default out `./zzpersona-managed/`; default `--os` from
  `process.platform` (`darwin` → `macos`, `win32` → `windows`, else `linux`). The client function
  for the route lands in Task 5; until then `--from-registry` exits with `not supported by this
  registry` — Task 5 replaces it (keep the test skipped with a pointer, un-skipped in Task 5).
- [ ] **Step 4: Run** the pipeline — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): zzpersona managed build`.

### Task 4: Install, uninstall, check (`feature/managed-4-install`)

**Files:** Create `src/apps/cli/src/managed/{env.ts,install.ts,check.ts}`,
`src/apps/cli/src/managed-install.test.ts`; modify `src/apps/cli/src/commands/managed.ts`,
`src/apps/cli/src/doctor/checks.ts`, `src/apps/cli/src/commands/status.ts`, the `CliIo` type (an
optional `managed?: Partial<ManagedEnv>` test seam that `bin.ts` never sets).

**Interfaces (produces):**
```ts
interface ManagedEnv {
  os: ManagedOs; root: string; isAdmin(): boolean;
  /** Parsed MDM policy (macOS profile via `plutil -convert json -o -`, Windows `reg query`), or undefined. */
  mdmPolicy(): Promise<Record<string, unknown> | undefined>;
  /** `<CLAUDE_CONFIG_DIR or ~/.claude>/remote-settings.json` */
  remoteSettingsFile: string;
}
type CheckState = "ignored" | "edited" | "overridden" | "stale" | "missing" | "current";
checkManaged(context, env): Promise<{ state: CheckState; findings: { state: CheckState; detail: string }[] }>
```

- [ ] **Step 1: Failing tests** (temp roots through the seam):
  - install: writes every file, modes 0644/0755, the manifest last; prints the plan and asks unless
    `--yes`; `it("a second identical install writes nothing")` (Review Focus 2);
    `it("replacing a bundle removes only files the old manifest owned")`; `it("never touches
    managed-settings.json or other drop-ins")`; `it("refuses when an org-owned managed-mcp.json
    exists")` (naming the file, nothing written); `it("install refuses a bundle for another OS")`
    (Review Focus 3); `it("refuses a bundle whose hashes do not match")`; not admin → the exact
    copy, exit 1; `it("a newer manifest format stops check and install")` (Review Focus 5).
  - uninstall: removes exactly the manifest's files and the manifest; leaves org files.
  - check: one test per state from planted fixtures — `current`; `stale` (a newer layer version
    in the store); `edited` (a byte changed); `missing`; `ignored` (MDM policy present without
    `managedSourcesBehavior: "merge"`; a remote-settings file likewise; with `"merge"` → not
    ignored); `overridden` (a `90-org.json` drop-in setting `claudeMd`); several at once → the most
    severe is the state, all listed; `--json` shape `{ state, findings }`.
  - doctor shows a `managed` check (ok when current, warn otherwise, skipped when nothing is
    installed and no policy is configured); status prints `managed: <state>`.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/cli exec vitest run managed-install.test.ts` —
  Expected: FAIL.
- [ ] **Step 3: Implement.** Atomic writes (temp in the same folder, then rename); on POSIX chown
  root only when running as root; `isAdmin` = `process.getuid?.() === 0` on POSIX, and on Windows
  a write probe of the root. `stale` compares the installed manifest's `files` with a fresh
  `buildBundle` for its deepest layer and `os`.
- [ ] **Step 4: Run** the pipeline — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): zzpersona managed install, uninstall and check`.

### Task 5: Registry route, e2e, docs (`feature/managed-5-registry`)

**Files:** Modify `src/packages/registry-api/src/{schemas.ts,routes.ts,mock.ts,conformance.ts,
openapi.ts}`, `openapi.json`; `src/packages/store-remote/src/client.ts` (`managedBundle`);
`src/apps/cli/src/managed/build.ts` (`--from-registry`); create
`src/apps/cli/src/managed.e2e.test.ts`; docs (`docs/capabilities.md` if changed, the CLI's usage
docs or README section on managed policy), amendments to spec 21, CLAUDE.md status, changesets
(minor: spec, resolver, adapter-sdk, adapter-claude-code, registry-api, store-remote, cli).

**Interfaces:** `ROUTES.managedBundle` (`GET /v1/managed/bundle`, query `layer`, `os`, `format`
default `bundle`, `include` default `all`), response `ManagedBundleResponse = { manifest, files:
Record<string, string /* base64 */> }`; mock option `managed?: ManagedCompiler` (it calls
`compileFromSource`; 501 `format-unsupported` for non-`bundle` formats and when none is injected);
kit option `managed?: ManagedCompiler` (the kit compiles the same layers locally and compares
manifest `files`); client `managedBundle({ layer, os }): Promise<{ manifest;
files: Record<string, Uint8Array> }>`.

- [ ] **Step 1: Failing tests:** schemas (tolerant client, strict conformance copies); mock:
  `bundle` answers, refusal → 422 `managed-refused` with the path, `console` → 501, bad `os` →
  400, unknown layer → 404, no token → 401; kit case "managed bundle matches a local compile";
  CLI `--from-registry` test un-skipped; OpenAPI snapshot updated.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** `e2e` (`ZZP_E2E_MANAGED=1`, Docker): build a Linux bundle from a
  fixture store on the host; a `node:26-slim` container with `npm i -g @anthropic-ai/claude-code`
  (version pinned in the test) and the built CLI mounted read-only; run `managed install --yes` as
  root, then `claude mcp list` (expects the locked servers) and `claude doctor` (expects no invalid
  managed entries); if `claude doctor` cannot run without a TTY or a login, record the finding and
  assert with `claude mcp list` and the files alone. Remove the container in `afterAll`.
- [ ] **Step 4: Run** the pipeline and `ZZP_E2E_MANAGED=1` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: managed bundle route, e2e and docs`.
