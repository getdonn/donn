# 19 — Publish engine

> Status: design, 2026-10-22. Phase 3, groundwork for sub-project B (the control plane core, a
> private repo). Builds on `18-registry-contract.md`. Built as a `gh stack`: layer 0 is this spec
> and its plan.

## Intent

The mock registry from spec 18 implements the five publish rules inside its HTTP handler. The real
server (B) needs exactly the same rules, run against its own storage inside a transaction. This
spec pulls the rules out into a storage-independent engine in `@zzpersona/registry-api`, so the
mock and the server share one implementation, and hardens the conformance kit before the server
is built against it.

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| One publish engine in OSS, over a `LayerStore` interface; the mock and the server are a store plus HTTP | The server reimplements the rules; the server wraps the mock | One implementation of the subtle parts (check order, descendant sweep, digest); the enterprise value is a server enforcing the rules with identity and audit, not the algorithm, and the client already enforces locks in OSS |
| The engine does not serialise; the caller runs it under its own lock or transaction | The engine takes a lock | Locking belongs to the storage (an advisory lock in Postgres, nothing in memory) |
| Kit hardening ships before the server | After | The server is built against the stricter kit, not changed afterwards |
| The private repo consumes this repo as a git submodule pinned to a release tag, through package `exports` only | A `zzpersona` GitHub org with GitHub Packages; publishing under `@jbjsoftware/*` | The scope is a placeholder and both of those are redone at the rename; `exports` maps already block deep imports, so the boundary matches a published package (decided 2026-10-22; revisit when the name and org exist) |

## 1. The engine

In `@zzpersona/registry-api` (`src/engine.ts`, exported from the package root):

```ts
export interface LayerStore {
  /** The latest version of `ref`, or undefined when it was never published. */
  latest(ref: string): Promise<LayerVersion | undefined>;
  /** Every published ref. */
  refs(): Promise<string[]>;
  /** Store a new version; called at most once per publish, after every check passed. */
  insert(version: LayerVersion): Promise<void>;
}

export type PublishOutcome =
  | { status: 201; result: PublishResult; inserted: LayerVersion; broken: string[] }
  | { status: 200; result: PublishResult }          // unchanged or dry run
  | { status: 401 | 404 | 409 | 413 | 422; problem: Problem };

export function publishLayer(
  store: LayerStore,
  ref: string,
  request: unknown,                                 // validated here with PublishRequest
  context: { subject: string; now: Date },
): Promise<PublishOutcome>;
```

- `publishLayer` runs spec 18 §2 in the amended order: validate the bundle; digest; `stale-base`
  (409) and `unchanged` (200), both skipped on a dry run; `unpublished-ancestor`; the lock resolve
  (`lock-violation`); the descendant sweep (`breaks-descendants` unless `force`). It returns
  problems instead of throwing; an unexpected error (a store failure) is thrown to the caller.
- `inserted.publishedBy` is `context.subject`, `inserted.publishedAt` is `context.now`.
- The engine never serialises. Two concurrent calls on one store can both pass `stale-base`; the
  caller must run each call under a lock (in memory: one at a time; in Postgres: a transaction
  holding an org-wide advisory lock).
- `getVersion` and `listLayers` stay with the caller; they are reads of the store.

## 2. The mock on the engine

`startMockRegistry` keeps its signature and behaviour: an in-memory `LayerStore` plus the same
`node:http` routes and auth, calling `publishLayer` one request at a time. The mock's own rule code
is removed. Its existing conformance run must pass unchanged before the kit hardening lands.

## 3. Kit hardening

New conformance cases, each one a requirement on any server:

- **Strict base64:** a `files[].content` that is not canonical base64 (bad padding, stray
  characters) is 422 `invalid`, naming the path. The mock adopts the same check.
- **Refs:** `org`, `Team/x`, `team/`, `team/x/` and a ref with `..` are 422 `invalid` (or
  `not-publishable` for `project/` and `user/`), never 500.
- **Malformed requests:** an unknown route is 404 `not-found`; a body that is not JSON, or JSON that
  is not an object, is 422 `invalid`; a malformed `%` sequence in `{ref}` is 404 `not-found`.
- **Concurrency:** two publishes of different bundles from the same `baseVersion`, started
  together, give exactly one 201 and one 409 `stale-base`, and the listing shows one new version.
- **`lock-violation`** is checked through the problem's `ref` field (the locking layer) as well as
  its message, so a server may word the message its own way.

## 4. Stack and testing

| Layer | Contents |
|---|---|
| 0 `spec` | this spec and its plan |
| 1 `engine` | `engine.ts`, `LayerStore`, `publishLayer`; unit tests against an in-memory store; the mock rebuilt on it, its conformance run unchanged |
| 2 `kit` | the §3 cases in `conformance.ts`; the mock's strict base64, ref, route and body handling |
| 3 `docs` | spec 18 cross-reference, `03` note, CLAUDE.md item 19, changeset (minor `@zzpersona/registry-api`) |

- Engine unit tests: every outcome and problem code through `publishLayer` with an in-memory store,
  `insert` never called on any non-201 outcome, `publishedBy`/`publishedAt` from the context, a
  store error propagates.
- The conformance suite against the mock, before and after layer 2.

## Non-goals

The server itself (B, private); storage locking inside the engine; new routes; changing any wire
format from spec 18.

## Open questions

None.
