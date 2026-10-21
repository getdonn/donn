# Capability Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every adapter declares every capability field with a reason; `zzpersona capabilities`
prints the matrix, and a committed `docs/capabilities.md` generated from it cannot go stale.

**Architecture:** A `gh stack` on `feature/matrix-0-spec`, one layer per task
(`gh stack add feature/matrix-<n>-<name>`). The SDK gains `caveat`, `capabilityFields()` and a
`complete-matrix` conformance check, and `requiredEntries` takes reasons from notes; adapters move
their field-level reasons into `capabilities()`; the CLI renders matrices as a grid, Markdown or
JSON.

**Tech Stack:** TypeScript, pnpm, turborepo, vitest.

**Spec:** `docs/planning/13-capability-matrix.md`

## Global Constraints

- Symbols, verbatim: `●` native, `◐` approximated, `○` advisory, `✕` none; `*` on a cell with a
  caveat.
- Every fixed field, each `hooks.<event>` (in `HOOK_EVENTS` order) and `targets.<own id>` is
  declared; a non-`native` field has a `note`.
- Adapters keep today's reason wording as their notes, so golden builds do not change unless a
  task says so.
- The grid for the three first-party adapters fits 80 columns.
- `docs/capabilities.md` is generated, never hand-edited; the staleness message names
  `pnpm docs:capabilities`.
- Every layer passes `pnpm turbo run build check-types lint test` and `pnpm format:check`;
  commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A third-party adapter written before this spec (matrix with only `instructions`) still shows in
   `zzpersona capabilities`: undeclared fields render as `✕` with the note "not declared by the
   adapter", never a crash → Task 3 test "shows an incomplete third-party matrix".
2. `--detect` with a harness not installed shows its column with "(not installed)" and its full
   matrix, not an error → Task 3 test "marks a harness that is not installed".
3. The same note on several cells (Codex and agents-md share none; agents-md's hooks share one)
   is listed once and every cell cites the same number → Task 3 test "numbers a shared note once".
4. A third-party adapter in config that fails to load fails `capabilities` with the same plugin
   error `compile` gives, rather than vanishing from the matrix → Task 3 test "fails on a broken
   adapter plugin".
5. A degraded Claude Code mode reports drops with the mode's note, identical to the matrix's →
   Task 2 test "reports partial-mode drops with the matrix note".

---

### Task 1: SDK (`feature/matrix-1-sdk`)

**Files:** Modify the three adapters' `capabilities.ts` (Step 4); `src/packages/adapter-sdk/src/types.ts`, `report.ts`, `conformance/checks.ts`,
`conformance/checks.test.ts`, `report.test.ts`, `testing/toy.ts`; the test plugins
`src/apps/cli/src/test/plugins/{class-adapter,whole-file-adapter}/index.js` (full matrices, so
they keep passing conformance).

**Interfaces (produces):**
```ts
export interface CapabilityEntry { support: Support; note?: string; caveat?: string }
export interface CapabilityMatrix { fields: Partial<Record<CapabilityField, CapabilityEntry>> }
export function capabilityFields(adapterId: string): CapabilityField[]; // fixed fields, hooks.<e> in HOOK_EVENTS order, targets.<id>
export function requiredEntries(adapterId, matrix, ir): { path: string; outcome: ReportEntry["outcome"]; reason: string }[];
// reason = the field's note, or "not declared by the adapter" when the field is missing
export const UNDECLARED = "not declared by the adapter";
```
`CHECK_NAMES` gains `"complete-matrix"` (per adapter, run against the conformance detection).
Problems: `missing field <field>`; `<field> is <support> without a note`.

- [ ] **Step 1: Failing tests** — `report.test.ts`: `capabilityFields("x")` starts with
  `instructions` and ends with `targets.x`, and contains `hooks.<e>` for every event;
  `requiredEntries` gives each entry its field's note as `reason`, and `UNDECLARED` for a missing
  field. `checks.test.ts`: the broken-toy table gains `["complete-matrix", <toy missing skills>]`
  and `["complete-matrix", <toy with skills: { support: "none" } and no note>]`; the good toy
  passes.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/adapter-sdk exec vitest run` — Expected: FAIL.
- [ ] **Step 3: Implement**; the good toy declares every field from `capabilityFields("toy")`
  (`instructions` native, the rest `none` with note "toy expresses instructions only") and drops
  its own reason mapping. Update the two CLI test plugins the same way.
- [ ] **Step 4: Fill the three adapters' `capabilities.ts`** so each declares every field from
  `capabilityFields(<id>)` with the notes and caveats listed in Task 2 (matrices only; compile is
  Task 2). Run `pnpm turbo run build check-types lint test` — Expected: PASS, golden files
  unchanged.
- [ ] **Step 5: Commit** `feat(adapter-sdk): complete capability matrices with reasons`.

### Task 2: Adapters (`feature/matrix-2-adapters`)

**Files:** Modify `compile.ts` (and `capabilities.ts` only if a note moves) in `src/packages/adapters/{claude-code,agents-md,codex}/src/`, their compile tests.

**Notes (verbatim, today's reasons):**
- claude-code: knowledge `rendered as text in the system prompt` (advisory); in `partial`, skills,
  hooks, `mcp.servers`, secrets `disableSideloadFlags blocks --plugin-dir and --mcp-config`; in
  `relaunch-no-mcp`, `mcp.servers`, secrets `managed-mcp.json makes --mcp-config exit`. Caveat on
  `mcp.servers`: `gateway:// refs are dropped until gateway resolution exists`.
- agents-md: approximated `rendered as guidance; not enforced`; knowledge `listed as pointers in
  AGENTS.md`; none `AGENTS.md is plain text; use a harness adapter for <skills | MCP servers |
  secrets | hooks | harness settings>`.
- codex: permissions `rendered as guidance; Codex enforces only its sandbox and approval policy`,
  caveat on `permissions.allow` `MCP tool allow rules with bare tool names become approvals`;
  knowledge `listed as pointers in the instructions`; skills `Codex has no per-launch skill
  root`; hooks `untrusted hooks do not run, and zzpersona never bypasses Codex's hook trust`;
  caveat on `mcp.servers` `servers whose secret cannot be forwarded by name are dropped; see the
  report`; caveat on `targets.codex` `only sandbox, approval and model are read`.

Compile reads field-level reasons from its own `capabilities(detection)` (claude-code's
`dropAll` calls and knowledge entries; agents-md's `reasonFor` and codex's `reasons` map go
away). Item-specific reasons stay.

- [ ] **Step 1: Failing tests** — per adapter: `it("reports field-level drops with the matrix note")`
  (every `requiredEntries` path in the kitchen-sink report has `reason ===
  capabilities().fields[field].note`); claude-code `it("reports partial-mode drops with the matrix
  note")` with `detection.facts.sideloadBlocked`.
- [ ] **Step 2: Run** each adapter's `vitest run` — Expected: FAIL where reasons are still local.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` — Expected: PASS, golden files
  unchanged (`git diff --stat -- '*/test/golden/*'` empty); any golden change is read and ledgered.
- [ ] **Step 5: Commit** `refactor(adapters): reasons come from the capability matrix`.

### Task 3: `zzpersona capabilities` (`feature/matrix-3-cli`)

**Files:** Create `src/apps/cli/src/capabilities/render.ts`, `src/apps/cli/src/commands/capabilities.ts`, `src/apps/cli/src/capabilities.test.ts`. Modify `cli.ts` (register), `plugins.ts` (export a helper listing built-in plus loaded adapters, reusing `loadAdapters`).

**Interfaces (produces):**
```ts
interface Column { id: string; detected?: { installed: boolean; version?: string }; matrix: CapabilityMatrix }
function renderGrid(columns: Column[]): string;      // text, ≤ 80 columns for the first-party three
function renderHarness(column: Column): string;      // one line per field: "<field>  <symbol> <support>  <note>[  * <caveat>]"
function capabilitiesDoc(columns: Column[]): string; // the Markdown form, header included (the --markdown output)
function capabilitiesJson(columns: Column[]): { harnesses: { id; detected?; fields: Record<CapabilityField, CapabilityEntry> }[] };
function capabilitiesCommand(io, options: { harness?: string; detect?: boolean; markdown?: boolean; json?: boolean }): Promise<number>;
```
Rows: `instructions`, `skills`, `mcp.servers`, `secrets`, `knowledge`, `permissions` (or its three
fields), `hooks` (or one row per event), `targets` (each column's own `targets.<id>`). A group
collapses when every column gives every member the same support, note and caveat. Cells: symbol,
then `*` if a caveat applies, then the note numbers (`◐ 3`, `●* 7`, `✕ 1`); notes and caveats share
one numbering, listed under the grid as `<n>  <text>`; equal text gets one number. Undeclared
fields render as `✕` with note `UNDECLARED`. Header cell with `--detect`: `<id> <version>` or
`<id> (not installed)`.

The doc header (verbatim, above the table): `# Capability matrix`, a blank line, `Generated by
\`zzpersona capabilities --markdown\`; regenerate with \`pnpm docs:capabilities\`. Do not edit by
hand.`, then a legend line per symbol (`● native — carried and enforced as the persona says`,
`◐ approximated — carried, but weaker or as guidance`, `○ advisory — shown to the model, not
enforced`, `✕ none — not carried; the compile report lists each item`), then `Harnesses without an
adapter yet: Copilot CLI, Cursor, Gemini CLI, Antigravity.`

- [ ] **Step 1: Failing tests** — grid for the three first-party adapters: every line ≤ 80
  columns; rows in the order above; `permissions` shows as three rows (Codex's
  `permissions.allow` has a caveat its siblings lack); `hooks` is one row;
  `it("expands hook rows when events differ")` with a toy column; `it("numbers a shared note
  once")`; `--harness codex` lists `skills  ✕ none  Codex has no per-launch skill root`;
  `--json` shape with every field per harness; `--harness nope` → `unknown-harness`;
  `it("marks a harness that is not installed")` (`--detect`, probe 127);
  `it("shows Claude Code partial with --detect")` (probe returns managed settings blocking
  sideload, as `doctor.test.ts` does); `it("shows an incomplete third-party matrix")` (the
  `class-adapter` test plugin with its old one-field matrix, via a copy); `it("fails on a broken
  adapter plugin")` (`bad-version`).
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/cli exec vitest run src/capabilities.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): zzpersona capabilities`.

### Task 4: The published doc (`feature/matrix-4-docs`)

**Files:** Create `docs/capabilities.md` (generated), `src/apps/cli/scripts/capabilities-doc.mjs`
(imports `capabilitiesDoc` and the first-party columns from `dist`, writes the doc), `.changeset/capability-matrix.md`.
Modify root `package.json` (`"docs:capabilities": "turbo run build --filter=@zzpersona/cli && node src/apps/cli/scripts/capabilities-doc.mjs"`),
`src/apps/cli/src/capabilities.test.ts`, `README.md` (link), `docs/planning/03-architecture.md`
(dated note at §Capability matrix: superseded by `docs/capabilities.md`),
`docs/planning/05-adapter-sdk.md` (dated note: every field declared, notes required, reasons from
notes), `CLAUDE.md` (current phase).

- [ ] **Step 1: Failing test** — `it("keeps docs/capabilities.md current")`: reads the committed file
  and expects it to equal `capabilitiesDoc(firstPartyColumns())`, failure message
  `docs/capabilities.md is stale; run pnpm docs:capabilities`.
- [ ] **Step 2: Run** it — Expected: FAIL (file missing).
- [ ] **Step 3: Run** `pnpm docs:capabilities`; read the generated doc whole.
- [ ] **Step 4: Run** the test, then edit one character of the doc and re-run — Expected: PASS,
  then FAIL naming `pnpm docs:capabilities`; restore. Then docs, changeset (minor
  `@zzpersona/adapter-sdk` noting the breaking conformance check, minor `@zzpersona/cli`, patch for
  the three adapters), `pnpm turbo run build check-types lint test`, `pnpm format:check` — PASS.
- [ ] **Step 5: Commit** `docs: the capability matrix`.
