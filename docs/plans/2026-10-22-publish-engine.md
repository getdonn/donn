# Publish Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract spec 18's publish rules into a storage-independent `publishLayer` engine in
`@zzpersona/registry-api`, rebuild the mock on it, and harden the conformance kit.

**Architecture:** A `gh stack` on `feature/engine-0-spec` (`gh stack add feature/engine-<n>-<name>`).
`src/packages/registry-api/src/engine.ts` holds `LayerStore`, `PublishOutcome` and `publishLayer`;
`mock.ts` becomes an in-memory store, a request queue and the existing routes; `conformance.ts`
gains the §3 cases.

**Tech Stack:** TypeScript, Node 26, zod 4, yaml, vitest. No new dependencies.

**Spec:** `docs/planning/19-publish-engine.md`

## Global Constraints

- Wire formats from spec 18 (routes, schemas, problem codes, digest v1) do not change.
- Rule order (spec 18 §2 as amended): validate the bundle; digest; `stale-base` (409) and
  `unchanged` (200), both skipped on a dry run; `unpublished-ancestor`; lock resolve
  (`lock-violation`); descendant sweep (`breaks-descendants` unless `force`).
- `publishLayer` returns problems, never throws them; a store error is thrown to the caller.
  `insert` is called at most once, only on a 201.
- The engine does not serialise; the mock runs publishes one at a time.
- `startMockRegistry`'s signature and behaviour are unchanged.
- Every layer passes `pnpm turbo run build check-types lint test` and `pnpm format:check`; commits
  end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A store whose `latest` throws (a database error) → `publishLayer` rejects with that error,
   no partial insert → Task 1 test "a store error propagates".
2. A `request` that is not an object, or misses fields → 422 `invalid`, never a thrown zod error →
   Task 1 test "an invalid request is a problem".
3. Two publishes to the mock from the same base, started together → one 201, one 409, the
   listing shows one new version → Task 2 conformance case (needs the mock's queue).
4. A descendant that was already broken before the candidate does not count as broken → Task 1 test
   "an already-broken descendant is not counted".
5. A dry run on a stale base still answers 200 with `diff` and `broken` → Task 1 test "a dry run
   ignores the base".

---

### Task 1: The engine (`feature/engine-1-engine`)

**Files:** Create `src/packages/registry-api/src/engine.ts`, `src/packages/registry-api/src/engine.test.ts`.
Modify `src/index.ts` (export), `src/mock.ts` (use the engine; delete its rule code).

**Interfaces (produces):** exactly spec 19 §1:
```ts
export interface LayerStore { latest(ref: string): Promise<LayerVersion | undefined>; refs(): Promise<string[]>; insert(version: LayerVersion): Promise<void>; }
export type PublishOutcome =
  | { status: 201; result: PublishResult; inserted: LayerVersion; broken: string[] }
  | { status: 200; result: PublishResult }
  | { status: 401 | 404 | 409 | 413 | 422; problem: Problem };
export function publishLayer(store: LayerStore, ref: string, request: unknown, context: { subject: string; now: Date }): Promise<PublishOutcome>;
export function memoryStore(): LayerStore & { versions(ref: string): LayerVersion[] }; // used by the mock and tests
```

- [ ] **Step 1: Failing tests** in `engine.test.ts`, all through `publishLayer` with `memoryStore()`
  and a spy wrapper counting `insert` calls:
  - `it("publishes a first version")`: 201, `inserted.version === 1`, `publishedBy` and
    `publishedAt` from the context, `digest === bundleDigest(source, files)`.
  - One `it` per problem code: `invalid` (bad YAML, schema, control char in a path, bad request
    shape), `not-publishable`, `missing-file`, `path-escapes-layer`, `bundle-too-large`,
    `stale-base`, `unpublished-ancestor`, `lock-violation` (problem `ref` is the locking layer),
    `breaks-descendants`; each asserts the status and that `insert` was not called.
  - `it("unchanged returns 200 and inserts nothing")`; `it("force publishes and reports broken")`.
  - `it("a dry run ignores the base")` (stale base, dry run → 200 with `diff` and `broken`).
  - `it("an already-broken descendant is not counted")`.
  - `it("an invalid request is a problem")` (`null`, `"x"`, `{}`) → 422 `invalid`.
  - `it("a store error propagates")` (`latest` rejects → `publishLayer` rejects with it).
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/registry-api exec vitest run src/engine.test.ts` —
  Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `engine.ts` by moving the mock's rule code (`checkBundle`, the resolve
  helpers, the descendant sweep, the dry-run diff) behind `publishLayer`, reading only through the
  store. Rebuild the mock: `memoryStore()` plus a promise queue so publishes run one at a time;
  the route maps `PublishOutcome` to the HTTP reply.
- [ ] **Step 4: Run** `pnpm --filter @zzpersona/registry-api exec vitest run` — Expected: PASS,
  including the unchanged conformance suite against the mock. Then
  `pnpm turbo run build check-types lint test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(registry-api): publish engine over a LayerStore`.

### Task 2: Kit hardening (`feature/engine-2-kit`)

**Files:** Modify `src/packages/registry-api/src/conformance.ts`, `src/mock.ts`, `src/engine.ts`
(strict base64).

**Interfaces:** consumes Task 1; produces no new exports.

- [ ] **Step 1: Failing conformance cases** (spec 19 §3):
  - `it("non-canonical base64 is invalid")`: `"YQ"` (missing padding) and `"Y Q=="` → 422 `invalid`
    with `problems[0].path` naming the file.
  - `it("malformed refs are invalid, never 500")`: `org`, `Team/x`, `team/`, `team/x/`,
    `team/../x` (URL-encoded) → 422 `invalid`; `project/x`, `user/x` → 422 `not-publishable`.
  - `it("an unknown route is not-found")`: `GET /v1/nope` → 404 `not-found`.
  - `it("a body that is not a JSON object is invalid")`: `not json`, `[]`, `"x"` → 422 `invalid`.
  - `it("a malformed % in the ref is not-found")`: `/v1/layers/%E0%A4%A/versions/1` → 404 `not-found`.
  - `it("concurrent publishes from one base: one wins")`: two different bundles of `org/base` with
    `baseVersion: 1`, `Promise.all` → statuses sorted `[201, 409]`, listing shows version 2.
  - Change the existing lock-violation case to assert `problems[0].ref` is the locking layer, and
    accept any message.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/registry-api exec vitest run` — Expected: FAIL on
  the cases the mock does not yet meet.
- [ ] **Step 3: Implement** in the engine: canonical base64 check (decode then re-encode must equal
  the input); in the mock: unknown route, non-object body and bad `%` handling.
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` — Expected: PASS.
- [ ] **Step 5: Commit** `test(registry-api): harder conformance kit`.

### Task 3: Docs (`feature/engine-3-docs`)

**Files:** Modify `docs/planning/18-registry-contract.md` (dated note: the rules now live in
`publishLayer`, spec 19), `docs/planning/03-architecture.md` (dated note under "Control plane": the
server runs the shared engine; the private repo consumes this repo's packages),
`docs/planning/19-publish-engine.md` (amendments from Tasks 1–2), `CLAUDE.md` (reading list item 19;
status line). Create `.changeset/publish-engine.md` (minor `@zzpersona/registry-api`).

- [ ] **Step 1: Docs**, prose wrapped at 100, dated 2026-10-22.
- [ ] **Step 2: Run** `pnpm turbo run build check-types lint test` and `pnpm format:check` —
  Expected: PASS.
- [ ] **Step 3: Commit** `docs: publish engine`.
