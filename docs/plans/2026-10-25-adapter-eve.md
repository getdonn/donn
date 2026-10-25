# adapter-eve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure `AgentAdapter` contract in `@getdonn/adapter-sdk`, and `@getdonn/adapter-eve`,
which compiles one resolved agent (persona + `agents.define` entry + `models`) into donn-owned
files in an eve 0.83.2 agent's slots, with a compile report, a portability report and the
ownership manifest's file list.

**Architecture:** A `gh stack` on `develop` whose layer 0 is `feature/spec-24-eve-083` (PR #199:
spec amendments + this plan). Layer 1 `feature/eve-1-sdk` (Tasks 1–2: contract, agent
conformance kit, the eve spike), layer 2 `feature/eve-2-compile` (Tasks 3–4: the adapter's
compile), layer 3 `feature/eve-3-templates` (Tasks 5–6: templates, portability, `agent.ts`
patch, docs, e2e). Nothing in the CLI changes: `donn agent` is spec 25.

**Tech Stack:** TypeScript, zod 4, vitest, `@babel/parser` 8 (the `agent.ts` patch), eve 0.83.2
(spike and opt-in e2e only, never a dependency of donn's packages).

**Spec:** `docs/planning/24-adapter-eve.md` (amended 2026-10-25; Option A: write into slots).

## Global Constraints

- Every type, error code and file path is spec 24 §1–§5 verbatim: `AgentAdapter`,
  `AgentCompileInput`, `AgentCompileOutput`, `TemplateInfo`, `PortabilityEntry`, `VercelService`
  (`connect | sandbox | drive | daemons | ai-gateway | github-checkout`); codes
  `model-needs-gateway`, `name-unmappable`, `name-collision`, `slot-collision`,
  `portability-unknown`, `agent-ts-unrecognised`, `owned-file-edited`.
- donn-owned paths, exactly: `agent/instructions/donn.md`, `agent/skills/donn-<name>/…`,
  `agent/connections/donn-<name>.ts`, `agent/lib/donn/config.ts`, `agent/lib/donn/env.ts`,
  `agent/sandbox.ts` (self-host, only when `project.hasSandbox` is false). Output paths are
  agent-directory-relative.
- `frameworkRange` is `>=0.83.2 <0.84.0`; the pinned version in examples and goldens is 0.83.2.
- The compile is pure and synchronous: no I/O, no clock, no randomness; same input → same bytes.
  No file contains a `secret://` string or a secret value; secrets are read as
  `process.env.DONN_SECRET_<n>` with `secretEnv` mapping each to its ref. `<n>` is a stable,
  deterministic index or name (pick one and document it in the adapter; never depends on map
  iteration order beyond the IR's own sorted order).
- No donn package depends on `eve`, `ai` or `@ai-sdk/*`; generated files import them, and spec 25
  adds them to the agent's `package.json`.
- `@getdonn/spec` rules stand (no Node built-ins there). `@getdonn/adapter-sdk` and
  `@getdonn/adapter-eve` may use Node, but `compile` itself does no I/O.
- Every layer passes `pnpm turbo run build check-types lint test` and `pnpm format:check`.
  Commits: `git commit -s`, ending with `Co-Authored-By: Claude Opus 5.5
  <noreply@anthropic.com>` and `Claude-Session:
  https://claude.ai/code/session_01GmLJYkbT5dYe37adTR8fab`.

## Review Focus

1. A persona MCP server named `my_db` and another `My-DB` → `name-collision` naming both (not a
   silent drop of one) → Task 3 test "two servers mapping to one name".
2. A template that already has `agent/skills/donn-x/` (or `skills/donn-x.md`), and the persona has
   skill `x` → `slot-collision` naming both, even though donn's own manifest is empty → Task 3.
3. A header `Authorization: Bearer secret://vault/k` becomes `auth.getToken` reading
   `process.env.DONN_SECRET_<n>`; `Authorization: Basic secret://…` stays in `headers`; a plain
   header stays plain → Task 4 test "secrets in headers".
4. `models` absent entirely and `agents.<x>.model` unset → a sensible error (`model-needs-gateway`
   or a clear "no model" refusal), never a config file with `undefined` → Task 4.
5. A skill copied whole that contains a `scripts/` folder, compiled for `local` (no sandbox) →
   compiled, with the caveat in the report, not dropped → Task 3.

---

### Task 1: The `AgentAdapter` contract and the agent conformance kit (`feature/eve-1-sdk`)

**Files:** Create `src/packages/adapter-sdk/src/agent.ts` (types + `defineAgentAdapter`), extend
`src/packages/adapter-sdk/src/index.ts`; create
`src/packages/adapter-sdk/src/conformance/agent.ts` (checks + `runAgentConformance` +
`agentConformanceSuite`), export from `conformance/index.ts`; tests `agent.test.ts`,
`conformance/agent.test.ts`.

**Interfaces (produces):** the spec 24 §1 types verbatim; `defineAgentAdapter(adapter):
AgentAdapter` validating as `defineAdapter` does (apiVersion 1, kebab-case id, every fixed
capability field declared with a note when not native, `frameworkRange` a valid semver range —
check with a small local parser, no new dependency, or reuse one the SDK has);
`runAgentConformance(adapter, cases): AgentConformanceResult[]` and
`agentConformanceSuite(adapter, cases)` (vitest wrapper, like `conformanceSuite`). A case is
`{ name, input: AgentCompileInput }`. Checks (spec 24 §1): `complete-matrix`; `deterministic`
(compile twice, deep-equal); `no-secrets` (no `secret://` and no secret ref target text in any
file content); `paths-inside` (every output path relative, normalized, no `..`, under `agent/`);
`env-declared` (every `process.env.X` a file reads is a key of `env` or `secretEnv`, or a
documented provider var — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AI_GATEWAY_API_KEY`,
`DATABASE_URL`-style world var named by the adapter); `unique-templates`; `donn-names`
(every `agent/skills/*` and `agent/connections/*` path donn writes starts `donn-` and passes
eve's rules: connections `^donn-[a-z][a-z0-9-]{0,58}$`-style with total ≤ 64, skills
`^donn-[A-Za-z0-9][A-Za-z0-9_-]*$` ≤ 64).

- [ ] **Step 1: Failing tests** with a toy agent adapter: a good one passes every check; one
  broken adapter per check fails exactly that check (table-driven, like
  `conformance/checks.test.ts`); `defineAgentAdapter` rejects a bad id, a missing fixed field and
  an invalid range.
- [ ] **Step 2: Run** `pnpm --filter @getdonn/adapter-sdk exec vitest run` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; full pipeline.
- [ ] **Step 5: Commit** `feat(adapter-sdk): the AgentAdapter contract and its conformance kit`.

### Task 2: The eve 0.83.2 spike (same branch)

**Files:** Create `spikes/eve-slots/` (throwaway, never imported; not in the pnpm workspace) with
`FINDINGS.md` and the minimal scripts/fixtures used.

Answer each question with evidence (commands run and their output, eve source lines) in
`FINDINGS.md`:
1. `agent/instructions/donn.md` composes after the template's root `instructions.md` and sorts
   among the template's own `instructions/` fragments by filename.
2. What `eve build` does when a template file and a donn file resolve to one skill name and one
   connection name (e.g. `skills/donn-x.md` + `skills/donn-x/`): error, shadow, or merge — so
   `slot-collision` matches eve's own rule.
3. The name rule for static connection files (`connections/<name>.ts`): lowercase-only? max
   length? (documented only for dynamic connections).
4. The `@ai-sdk/openai-compatible` and `@ai-sdk/anthropic` majors that type-check and build with
   `ai@^7` and eve 0.83.2, using the exact `createOpenAICompatible({ name: "donn-gateway",
   baseURL, apiKey, headers, includeUsage: true })` and `createAnthropic({ baseURL, apiKey,
   headers })` forms.
5. An SSE-only MCP server connects by URL with `defineMcpClientConnection({ url, description })`
   (a tiny local SSE MCP stub is enough).
6. `defineAgent` from `eve` still accepts a spread `...donn` with `{ model, modelContextWindowTokens?,
   experimental? }`, and a created minimal `agent.ts` (`export default defineAgent({ ...donn })`)
   builds; whether a pinned Docker `sandbox.ts` makes `eve build` fail on a host without Docker.

Work in a scratch directory under the spike folder (gitignore `node_modules`, `.output`); install
eve@0.83.2 with pnpm. Do not add eve to any workspace package.

- [ ] **Step 1:** Run the experiments; record results.
- [ ] **Step 2:** If any answer contradicts spec 24, STOP and report BLOCKED with the finding — the
  controller amends the spec with the user before Task 3.
- [ ] **Step 3: Commit** `spike: eve 0.83.2 slots, names, AI SDK pairing`.

### Task 3: `@getdonn/adapter-eve`: package, matrix, names, instructions, skills (`feature/eve-2-compile`)

**Files:** Create `src/packages/adapters/eve/` (copy `adapters/agents-md`'s package shape:
package.json `@getdonn/adapter-eve`, version 0.0.0, Apache-2.0, repository/directory, files incl.
NOTICE and `!dist/**/*.map`, deps `@getdonn/adapter-sdk`, `@getdonn/spec`), `src/index.ts`
(default export: the adapter via `defineAgentAdapter`), `src/capabilities.ts`, `src/names.ts`,
`src/compile.ts`, tests `src/names.test.ts`, `src/compile.test.ts`, `src/conformance.test.ts`.

**Interfaces:** `capabilities()` per spec 24 §3's Support column and notes verbatim;
`connectionName(serverName): string | undefined` (lowercase, `_`→`-`, must match the Task 2
static rule, prefix `donn-`, ≤ 64); `skillName(skill): string | undefined`; collision detection
against `project.existing` and among persona servers. `compile` (this task): `instructions/donn.md`
(fragments in IR order; inline text verbatim, file fragments from `texts`; knowledge pointer lines
as agents-md renders them, `mcp://<server>` → `donn-<server>` connection), skills (`copyFrom` the
skill directory to `agent/skills/donn-<name>/`; a packaged `SKILL.md` without `description`
frontmatter → dropped with the reason), the report for every non-native field and dropped item.

- [ ] **Step 1: Failing tests:** `names.test.ts` (`my_db` → `donn-my-db`; `Café` → undefined;
  65-char → undefined; skill names); `compile.test.ts`: "two servers mapping to one name" →
  `name-collision` (Review Focus 1); "a template file on a donn path" → `slot-collision` for each
  slot kind (Review Focus 2); "instructions and knowledge render to instructions/donn.md";
  "a skill with scripts compiles with the caveat for local" (Review Focus 5); "a skill without a
  description is dropped with the reason"; `conformance.test.ts` runs `agentConformanceSuite` on a
  small case list (built from the SDK corpus IRs plus an `agents` entry).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; pipeline.
- [ ] **Step 5: Commit** `feat(adapter-eve): names, instructions and skills`.

### Task 4: Models, connections, env, sandbox, golden builds

**Files:** Modify `src/packages/adapters/eve/src/compile.ts`; create `src/config.ts`,
`src/connections.ts`, `src/env.ts`, `src/golden.test.ts`, `test/golden/eve/*.txt`.

**Interfaces:** `lib/donn/config.ts` per spec 24 §2's table (model per gateway type or direct
provider, using the AI SDK majors Task 2 confirmed; `name: "donn-gateway"`; `includeUsage: true`;
`modelContextWindowTokens` from `targets.eve.contextWindow`, else an `approximated` report entry;
`experimental.workflow.world` = `@workflow/world-postgres` for `self-host`); the agent's model is
`agents.<name>.model ?? models.default` (neither → `model-needs-gateway`-style refusal with a clear
message; Review Focus 4). Connections per §3 (description default or
`targets.eve.connections.<name>.description`; bearer secret → `auth.getToken`; other headers
stay; stdio and `gateway://` dropped; `transport` not written). `lib/donn/env.ts` lists every env
name donn's files read and throws at start when one is missing. `sandbox.ts` per §2 for
`self-host` without a template sandbox. `env` = the agent's plain env; `secretEnv` = refs.

- [ ] **Step 1: Failing tests:** one per `config.ts` row (three gateway types, two direct
  providers, the refusal); "secrets in headers" (Review Focus 3); stdio/gateway servers dropped
  with reasons; `env.ts` lists exactly the names read; `sandbox.ts` only for self-host without a
  template sandbox; golden builds (spec 24 §6 list) rendered with `renderBuild`-style text into
  `test/golden/eve/`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**; generate goldens with `-u` and read each.
- [ ] **Step 4: Run** — PASS; pipeline.
- [ ] **Step 5: Commit** `feat(adapter-eve): model config, connections, env and sandbox`.

### Task 5: Templates, portability, the manifest and the `agent.ts` patch (`feature/eve-3-templates`)

**Files:** Create `src/packages/adapters/eve/src/{templates.ts,portability.ts,manifest.ts,
agent-ts.ts}` + tests; `test/fixtures/agent-ts/*.ts` (each in-repo template's real `agent.ts`
at the eve@0.83.2 tag, plus refusal cases). Add `@babel/parser` (latest 8.x) to the adapter's
dependencies.

**Interfaces:** `templates(): TemplateInfo[]` — rows for the six gallery templates in eve's repo
(and the two repo-only ones) with `repoPath` and the Vercel-only services their code uses, read
from `vercel/eve` at tag `eve@0.83.2` (record the commit SHA in a comment); `portability(template,
target): PortabilityEntry[]` per §5's table (unknown template → one `portability-unknown`
warning entry, not an error; `blank`/path templates → route auth only); compile fills
`AgentCompileOutput.portability`. `manifestFiles(output, hash: (s) => string)` returns the
manifest's `files` map (paths → `sha256:<hex>`; `copyFrom` entries are listed but hashed by the
CLI later — mark them so spec 25 knows). `patchAgentTs(source: string): { ok: true; text: string }
| { ok: false; code: "agent-ts-unrecognised"; hint: string }` per §2 (exactly one
default-exported `defineAgent({...})` with an object literal; add `import { donn } from
"./lib/donn/config";`, append `...donn` as the last property, remove a literal `model`
property; preserve everything else byte-for-byte outside the edited spans) and
`createdAgentTs(): string`.

- [ ] **Step 1: Failing tests:** portability per service × target (§5 table, including
  `github-checkout` not blocking on self-host); unknown template → `portability-unknown`;
  `patchAgentTs` on every fixture (golden output) and on refusal cases (two `defineAgent` calls,
  a non-literal argument, no default export, `defineAgent` imported under another name);
  `manifestFiles` shape.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; pipeline.
- [ ] **Step 5: Commit** `feat(adapter-eve): templates, portability, manifest and agent.ts patch`.

### Task 6: Docs, changeset and the real-eve e2e

**Files:** `src/apps/cli/scripts/capabilities-doc.mjs` + `src/apps/cli/src/capabilities/render.ts`
(an "agent adapters" section listing `eve`'s matrix; the CLI imports `@getdonn/adapter-eve` only
for this — check it's acceptable as a CLI dependency, since spec 25 needs it anyway);
`docs/capabilities.md` regenerated; `src/packages/adapters/eve/README.md`;
`.changeset/adapter-eve.md` (minor `@getdonn/adapter-sdk`, minor `@getdonn/adapter-eve`, patch
`@getdonn/cli`); `src/packages/adapters/eve/src/e2e.test.ts` (opt-in `DONN_E2E=1`): copy an
in-repo template at the pinned tag into a temp dir, compile into it, patch `agent.ts`, install,
`eve build`, start it with a stub OpenAI-compatible gateway that records requests; one HTTP-channel
turn; assert the gateway saw the call with the configured key and headers.

- [ ] **Step 1:** Docs section + test that `docs/capabilities.md` lists `eve`; README.
- [ ] **Step 2:** The e2e test; run it once locally with `DONN_E2E=1` and record the output in the
  report (skip in CI).
- [ ] **Step 3: Run** the full pipeline, `pnpm format:check`, `pnpm pack:check` (now 14 packages:
  `@getdonn/adapter-eve` becomes public — set its package.json like the other public packages and
  confirm the release tooling picks it up), `pnpm release:smoke`.
- [ ] **Step 4: Commit** `feat(adapter-eve): docs, changeset and real-eve e2e`.

## After the tasks

The controller pushes the stack and opens the PRs (`gh stack submit`) on the user's go-ahead.
Making `@getdonn/adapter-eve` public means its first publish needs the same trusted-publisher
setup as the others (spec 27 §4 step 3: claim, `npm trust github`, deprecate) before the release
that carries it — call that out to the user before cutting the release.
