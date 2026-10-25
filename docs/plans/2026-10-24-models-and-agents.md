# Models and agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Personas can declare `models` (gateway routing, lockable) and `agents` (project agents),
which resolve through the existing layer merge into two new IR fields, and every harness adapter
declares `models` in its capability matrix.

**Architecture:** A `gh stack` on `develop` (`gh stack init --base develop`, then `gh stack add` per
layer): 1 `feature/models-1-fields` (Task 1: schemas, IR, codes), 2 `feature/models-2-resolve`
(Tasks 2–3: merge rules, locks, overlay refusal, explain, fixtures), 3 `feature/models-3-matrix`
(Task 4: the capability field, adapter declarations, report entries, docs, changesets). Spec 23's
layer 0 (specs and amendments) already merged as #173.

**Tech Stack:** TypeScript, zod 4, vitest, the resolver's YAML fixture suite. No new dependencies.

**Spec:** `docs/planning/23-models-and-agents.md`

## Global Constraints

- Field shapes, merge rules and lock paths are spec 23 §1–§4 verbatim. Agent names: lowercase
  kebab-case, at most 64 characters. `target`: `local | self-host | vercel`. `gateway.type`:
  `openai-compatible | anthropic | vercel-ai-gateway`.
- `models` is allowed in persona files AND the user overlay; `agents` is persona files only (an
  overlay carrying `agents` fails with error code `agents-in-overlay`).
- New codes, exactly: error `agents-in-overlay`; warning `agent-removed`. Path and name rule
  violations are schema errors (`invalid-persona`), like every other shape error.
- `IR_VERSION` does not change: `models` and `agents` are added to `ResolvedPersona` with
  `.default({})`, as `policy` was (spec 21).
- Persona-side paths (locks, guard): `models`, `models.gateway`, `models.default`, `agents.define`,
  `agents.define.<name>`. IR-side paths (provenance, history, warnings, explain): `models.gateway`,
  `models.default`, `agents.<name>`.
- Every layer passes `pnpm turbo run build check-types lint test` and `pnpm format:check`.
  Commits: `git commit -s`, ending with `Co-Authored-By: Claude Opus 5.5
  <noreply@anthropic.com>` and `Claude-Session:
  https://claude.ai/code/session_01GmLJYkbT5dYe37adTR8fab`.

## Review Focus

1. A child layer that sets `models.gateway` with fewer keys than its parent's (drops `headers`) →
   the parent's `headers` must NOT survive (replaced whole, not deep-merged) → fixture 100.
2. `agents.remove: [x]` then a later layer re-adds `x` → `x` is back, with the removal in history
   and an `agent-removed` warning from the removing layer → fixture 103.
3. An agent `path` of `./agents/../..`, `/abs`, `.donn/x`, `.donn` or `agents/../.donn/x` → all
   refused (normalize, then check), while `agents/./pr` is accepted and stored normalized →
   Task 1 tests "path rules".
4. A path-form `template` (`templates/reviewer`) declared in `team/t.yaml` → stored relative to
   the personas root (`team/templates/reviewer`), like `instructions[].file`; `eve:<slug>` is kept
   verbatim → fixture 102.
5. An overlay that sets only `models.default` while an org layer locks `models` → dropped with
   `overlay-lock-ignored`, not an error (overlay lock semantics, `078`) → fixture 105.

---

### Task 1: `models` and `agents` in `@getdonn/spec` (`feature/models-1-fields`)

**Files:** Modify `src/packages/spec/src/{common.ts,persona.ts,ir.ts}`; tests
`src/packages/spec/src/persona.test.ts`, `src/packages/spec/src/index.test.ts`.

**Interfaces (produces):**
- `common.ts`: `ModelGateway` (strictObject: `type`, `baseURL?: url`, `apiKey?: string` matching
  `^secret://`, `headers?: record<string,string>`; `superRefine`: `baseURL` required for
  `openai-compatible`/`anthropic`, forbidden for `vercel-ai-gateway`); `Models` (strictObject:
  `gateway?: ModelGateway`, `default?: string.min(1)`); `AgentName` (`Id` + `.max(64)`);
  `AgentTarget` (`z.enum(["local","self-host","vercel"])`); `AgentPath` (string; refine: after
  `posix.normalize`, not absolute, not `..` or starting `../`, not `.donn` and not under `.donn/`);
  `EnvName` (`^[A-Z][A-Z0-9_]*$`, refine: not starting `DONN_`); `AgentTemplate` (string: either
  `^eve:[a-z0-9]+(-[a-z0-9]+)*$` or a relative path — not absolute, no `..` after normalize).
  Types exported alongside.
- `persona.ts`: `Agent` (strictObject: `template: AgentTemplate`, `target: AgentTarget`, `path?:
  AgentPath`, `model?: string.min(1)`, `env?: record(EnvName, string)`); `LayerBody` gains
  `models: Models.optional()`; `Persona` gains `agents: strictObject({ define?: record(AgentName,
  Agent), remove?: array(AgentName) }).optional()` (Persona only, beside `policy`).
- `ir.ts`: `ResolvedAgent` (strictObject: `template`, `target`, `path` (always set), `model?`,
  `env: record(string,string)`); `ResolvedPersona` gains `models: Models.default({})` and
  `agents: z.record(AgentName, ResolvedAgent).default({})` after `policy`; `ERROR_CODES` gains
  `"agents-in-overlay"`; `WARNING_CODES` gains `"agent-removed"`.

- [ ] **Step 1: Failing tests** in `persona.test.ts` (`describe("models")`, `describe("agents")`):
  "accepts the spec 23 §1 example" and "accepts the spec 23 §2 example" (copy the YAML blocks as
  objects); "baseURL is required for openai-compatible and anthropic, refused for
  vercel-ai-gateway"; "apiKey must be a secret ref"; "unknown gateway type is refused"; "agent
  name rules" (`PR-Reviewer`, a 65-char name refused; 64 accepted); "path rules" (Review Focus 3,
  each case); "env names are uppercase and DONN_ is reserved"; "template is eve:<slug> or a
  relative path" (`eve:Bad Slug`, `/abs`, `../x` refused); "an overlay may carry models";
  "an overlay cannot carry agents" (schema: `PersonaOverlay.safeParse` fails — the resolver turns
  this into `agents-in-overlay`, Task 2). In `index.test.ts`: the exported JSON Schemas contain
  `models` (persona and overlay) and `agents` (persona only). IR: `ResolvedPersona.parse` of an
  IR without the two fields yields `models: {}` and `agents: {}`.
- [ ] **Step 2: Run** `pnpm --filter @getdonn/spec exec vitest run` — Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above. `AgentPath` stores the user's string; the
  resolver normalizes (Task 2).
- [ ] **Step 4: Run** the spec tests — PASS — then the full pipeline. If adapter-sdk's conformance
  corpus or any golden embeds a full IR and now differs only by `models: {}`/`agents: {}`,
  regenerate it with its tool (`pnpm --filter @getdonn/adapter-sdk corpus:update`; vitest `-u`
  for goldens), review the diff, and say so.
- [ ] **Step 5: Commit** `feat(spec): models and agents fields`.

### Task 2: Merge rules, locks and the overlay refusal (`feature/models-2-resolve`)

**Files:** Modify `src/packages/spec/src/path.ts` (+ `path.test.ts`),
`src/packages/resolver/src/{merge.ts,graph.ts,resolve.ts}`; tests
`src/packages/resolver/src/resolve.test.ts`.

**Interfaces:**
- Consumes: Task 1's schemas and codes.
- `isValidLockPath`: `case "models"`: no entry, and depth 1, or depth 2 with `gateway` or
  `default`. `case "agents"`: no entry, second key `define`, depth 2 or 3.
- `Merge` gains `private models: Models` (gateway, default) and `private readonly agents =
  new Map<string, ResolvedAgent>()`; `apply` calls `this.mergeModels(doc.models ?? {})` (all docs)
  and `this.mergeAgents(doc.kind === "Persona" ? doc.agents : undefined)`; `finish` emits
  `models` and `agents` (sorted by name).
- `mergeModels`: `gateway` — if not deep-equal to the current one: `guard(at(["models",
  "gateway"]), current === undefined ? "add" : "set")`, then replace whole and
  `record("models.gateway")`; `default` — same pattern on `models.default` (as `mcp.gateway`).
- `mergeAgents({ define = {}, remove = [] })`: for each define entry, build the `ResolvedAgent`
  (`path` = `posix.normalize(path ?? "agents/<name>")`; a non-`eve:` template becomes
  `this.local(template)`; `env` default `{}`), then guard on persona path
  `agents.define.<name>` (`add`/`set`), skip if deep-equal, `map.set`, `record("agents.<name>")`.
  For each remove: absent → `warn("remove-unmatched", agents.define.<name>)`; present →
  `guard(agents.define.<name>, "remove")` (a lock throws `lock-violation` naming `lockedBy` and
  `layer`), delete, `forget("agents.<name>")`, and `warnings.push({ code: "agent-removed", path:
  "agents.<name>", layer })`. Defines are applied before removes within one layer, as `mcp` does.
- Overlay refusal: in `graph.ts` `loadDocument`, before `PersonaDocument.safeParse`, a raw
  document with `kind: PersonaOverlay` and an `agents` key throws `ResolveError(
  "agents-in-overlay", { layer: ref })` (the schema would otherwise report a generic
  `invalid-persona`). `models` in the overlay merges like any field
  (locks in the overlay are skipped with `overlay-lock-ignored`, existing `guard` behaviour).

- [ ] **Step 1: Failing tests:** `path.test.ts` — the new valid lock paths and invalid ones
  (`models.gateway.baseURL`, `agents`, `agents.remove`, `agents.define.x.env`, `models[x]`).
  `resolve.test.ts` — "an agent resolves against the persona it is used in" (team layer defines
  `pr-reviewer`; resolve `project/a` and `project/b` with different instructions: both IRs have the
  same `agents.pr-reviewer` and different `instructions`); "an overlay with agents fails with
  agents-in-overlay"; "the agent path is stored normalized and defaults to agents/<name>".
- [ ] **Step 2: Run** spec and resolver tests — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS (existing fixtures unchanged except `explain.txt`, which Task 3 owns;
  if an existing `explain.txt` changes here, something is wrong).
- [ ] **Step 5: Commit** `feat(resolver): merge models and agents`.

### Task 3: Fixtures and `explain`

**Files:** Create `src/packages/resolver/fixtures/{100..108}-*/` (case.yaml, personas/,
explain.txt for resolving cases); modify `src/packages/resolver/src/explain.ts` (+
`explain.test.ts`); update `src/packages/resolver/fixtures/README.md` (IR shape table rows for
`models` and `agents`; the two new codes) and `fixtures/002-full-stack/case.yaml` only if it lists
every IR field (it does: add `models: {}`, `agents: {}`).

**Interfaces:** `explain` gains two sections, rendered only when non-empty, in this order: `models`
after `mcp` (rows `gateway` → `<type> <baseURL>` with notes for `headers` keys and `apiKey` shown
as the ref, path `models.gateway`; `default` → the id, path `models.default`) and `agents` after
`targets` (one row per agent: label the name, value `<template> → <target> at <path>`, notes
`model: …` and `env: <names>` (names only, never values), path `agents.<name>`).

Fixtures (each a directory; error cases have no `explain.txt`):
- `100-models-gateway-replaced-whole` — org sets gateway with `headers`; team sets a gateway with
  a different `baseURL` and no `headers` → resolved gateway has no `headers` (Review Focus 1).
- `101-models-default-overridden` — org `default`, project overrides it; provenance shows project.
- `102-agent-replaced-by-key` — `team/t` defines `pr-reviewer` (`template: eve:blank`, `target:
  self-host`, `path: tools/reviewer`, `env: { GITHUB_APP_PRIVATE_KEY:
  secret://vault/gh/key }`) and `docs-bot` (`template: templates/docs`, `target: local`);
  `project/p` extends `team/t` and redefines `pr-reviewer` as `{ template:
  eve:github-project-maintainer, target: vercel }`. Expect `agents.pr-reviewer` = `{ template:
  eve:github-project-maintainer, target: vercel, path: agents/pr-reviewer, env: {} }` (replaced
  whole: no env, default path; provenance `project/p`) and `agents.docs-bot` = `{ template:
  team/templates/docs, target: local, path: agents/docs-bot, env: {} }` (Review Focus 4).
- `103-agents-remove-warns` — `team/t` defines agents `a` and `b`; `project/base` extends
  `team/t` and removes `a`; `project/p` extends `project/base` and re-adds `a` (a different
  `target`). Expect `a` (provenance `project/p`) and `b` present; warnings `[{ code:
  agent-removed, path: agents.a, layer: project/base }]`; history includes `{ path: agents.a,
  layer: project/base, kind: remove, from: team/t }` (Review Focus 2).
- `104-models-gateway-locked-below` — org locks `models.gateway`; team sets a different gateway
  → `error: { code: lock-violation, path: models.gateway, lockedBy: org/base, layer: team/t }`.
- `105-overlay-models-under-lock` — org locks `models`; overlay sets `models.default` → resolves,
  warning `overlay-lock-ignored` at `models.default` (Review Focus 5).
- `106-agent-locked-removed` — org defines and locks `agents.define.pr-reviewer`; team removes it
  → `lock-violation` naming both layers.
- `107-agents-in-overlay` — overlay with `agents` → `error: { code: agents-in-overlay, layer:
  user/overrides }`.
- `108-agent-path-outside-project` — `path: ../elsewhere` → `error: { code: invalid-persona }`.

- [ ] **Step 1:** Write the fixtures (case.yaml + personas) and the `explain.test.ts` cases for the
  two sections (non-empty rendering; env values never printed; empty sections omitted).
- [ ] **Step 2: Run** `pnpm --filter @getdonn/resolver exec vitest run` — Expected: the new
  resolving fixtures FAIL on missing `explain.txt`/sections, error fixtures PASS or FAIL per Task 2.
- [ ] **Step 3: Implement** the explain sections; generate the new `explain.txt` files with
  `pnpm --filter @getdonn/resolver exec vitest run -u`, then read each one and check it says what
  the case's `description` claims (it is the reviewer-facing spec).
- [ ] **Step 4: Run** the full pipeline — PASS; `git status` shows only intended files.
- [ ] **Step 5: Commit** `test(resolver): models and agents fixtures; explain sections`.

### Task 4: The capability field, reports and docs (`feature/models-3-matrix`)

**Files:** Modify `src/packages/adapter-sdk/src/{types.ts,report.ts}` (+ `report.test.ts`,
`define.test.ts`); `src/packages/adapters/{claude-code,codex,agents-md}/src/capabilities.ts`;
regenerate `docs/capabilities.md` (`pnpm docs:capabilities`); create
`.changeset/models-and-agents.md`.

**Interfaces:**
- `FIXED_CAPABILITY_FIELDS` gains `"models"` (after `"policy"`).
- `valuesByField` gains `["models", [...(ir.models.gateway ? ["models.gateway"] : []),
  ...(ir.models.default ? ["models.default"] : [])]]`. (`policy` stays as it is.)
- Declarations, exact notes (spec 23 §4): `claude-code` → `models: { support: "none", note: "Not
  yet: Claude Code reads a gateway from ANTHROPIC_BASE_URL; a later spec" }`; `codex` → `{
  support: "none", note: "Not yet: Codex takes a model_provider; a later spec" }`; `agents-md` →
  `{ support: "none", note: "AGENTS.md is text; model routing is the harness's" }`.
- Changeset: minor for `@getdonn/spec`, `@getdonn/resolver`, `@getdonn/adapter-sdk`,
  `@getdonn/adapter-claude-code`, `@getdonn/adapter-codex`, `@getdonn/adapter-agents-md`; body:
  "Personas can declare `models` (gateway routing, lockable) and `agents`; every harness adapter
  reports `models` (not yet supported). See docs/planning/23-models-and-agents.md."

- [ ] **Step 1: Failing tests:** `report.test.ts` — "an IR with models gets a dropped models entry
  per set key, with the adapter's note" and "an IR without models gets none"; `define.test.ts` —
  "an adapter that does not declare models fails" (as for any fixed field; extend the existing
  table-driven test if there is one).
- [ ] **Step 2: Run** adapter-sdk tests — Expected: FAIL.
- [ ] **Step 3: Implement**; add the three declarations; run the adapters' tests and the
  conformance suites; regenerate goldens/corpus only if they embed the matrix or the IR, reviewing
  the diff; `pnpm docs:capabilities` and check the new `models` row reads `✕` with the three notes.
- [ ] **Step 4: Run** the full pipeline and `pnpm format:check` — PASS.
- [ ] **Step 5: Commit** `feat(adapter-sdk): models capability field; adapters report it`.

## After the tasks

The controller pushes the stack and opens the PRs (`gh stack submit`) on the user's go-ahead;
CI runs on each layer. A changeset is in layer 3, so the next release carries it.
