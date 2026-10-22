# Registry Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The registry contract, mock and kit gain sign-in (server-brokered login routes), roles in
`whoami` and `403 forbidden`; clients read responses tolerantly; `zzpersona login <url>` signs in
through the browser.

**Architecture:** A `gh stack` on `feature/identity-0-spec` (`gh stack add
feature/identity-<n>-<name>`). `registry-api` (schemas, routes, mock with a fake provider and grants,
kit cases), `store-remote` (login client functions), CLI (`login`, `whoami`, `publish`, `doctor`).

**Tech Stack:** TypeScript, Node 26, zod 4, vitest. No new dependencies.

**Spec:** `docs/planning/20-registry-identity.md`

## Global Constraints

- New problem codes: `forbidden` (403), `authorization-pending` (428), `slow-down` (429),
  `login-expired` (410).
- Login routes: `POST /v1/auth/logins` → `201 { loginId, verifyUrl, code, pollSecret, interval,
  expiresIn }`; `POST /v1/auth/logins/{loginId}/token` body `{ pollSecret }` → `200 { token,
  subject, expiresAt }`. No bearer token on either. Unknown login and wrong `pollSecret` are both
  `404 not-found`.
- `code`: 8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, shown `XXXX-XXXX`; `interval`
  default 5, `expiresIn` default 600 (seconds).
- `whoami` gains optional `kind: "session" | "service"`, `roles: { role: "publish" | "lock"; path:
  string }[]`, `expiresAt` (ISO).
- Grant matching: a grant on path `p` covers ref `r` when `r === p` or `r` starts with `p + "/"`;
  `*` covers everything. A publish needs `publish`; if the bundle's YAML parses and its `locks`
  (as a sorted set) differ from the latest version's (empty when none), it also needs `lock`. Dry
  runs need no grant. `forbidden` message: `<subject> may not publish <ref>: needs <role> on <ref>`.
- Response schemas exported for clients are tolerant (unknown keys stripped, unknown problem codes
  kept); `ConformanceSchemas` holds strict copies the kit uses.
- CLI copy: `Open <verifyUrl> and confirm the code <code>`; `logged in to <url> as <subject>
  (session until <date>)`; no sign-in: `this registry has no sign-in; use zzpersona login <url>
  --token-stdin`; forbidden hint: `ask a registry admin for <role> on <ref>`.
- Every layer passes `pnpm turbo run build check-types lint test` and `pnpm format:check`; commits
  end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Tests never open a browser,
  never touch the real keychain, `~/.zzpersona` or `~/.claude`.

## Review Focus

1. The session token or `pollSecret` printed anywhere (stdout, stderr, `--json`, errors) → never;
   `login --json` returns `{ url, subject, expiresAt }` only → Task 2 test "login never prints the
   token or poll secret".
2. The login expires while polling, or the person is refused → the CLI stops with the server's
   reason and exits 1, nothing stored → Task 2 test "an expired or refused login stores nothing".
3. A registry running the previous contract (no `kind`, no `roles`) answers `whoami` → the new CLI
   reads it fine and prints no roles → Task 1 test "tolerant schemas read older and newer answers".
4. `--no-browser`, `CI=true`, or a failing browser opener → the URL and code are still printed and
   polling continues → Task 2 test "the browser is optional".
5. A grant on `team/pay` must not cover `team/payments` → Task 1 mock test "grants match by whole
   segment".

---

### Task 1: Contract, mock and kit (`feature/identity-1-contract`)

**Files:** Modify `src/packages/registry-api/src/{schemas.ts,routes.ts,mock.ts,conformance.ts,
openapi.ts}`, `openapi.json` (regenerated), tests `schemas.test.ts` (new), `mock.test.ts`.

**Interfaces (produces):**
```ts
// schemas.ts
export const PROBLEM_CODES; // + "forbidden" | "authorization-pending" | "slow-down" | "login-expired"
export const Role = z.enum(["publish", "lock"]);
export const Whoami;          // tolerant: { subject, org, kind?, roles?, expiresAt? }
export const LoginStart;      // { loginId, verifyUrl, code, pollSecret, interval, expiresIn }
export const LoginPoll;       // request { pollSecret }
export const LoginToken;      // { token, subject, expiresAt }
export const ConformanceSchemas: { Whoami; LayerSummary; LayerVersion; PublishResult; Problem; LoginStart; LoginToken }; // strict copies
export function grantCovers(path: string, ref: string): boolean;
// routes.ts: ROUTES.startLogin, ROUTES.pollLogin (auth: false)
// mock.ts
export interface MockRegistryOptions { token?; subject?; org?; loginInterval?: number /* default 0 */; loginExpiresIn?: number }
export interface MockRegistry { /* existing */ completeLogin(verifyUrl: string, identity: { email: string; groups?: string[] }): void; refuseLogin(verifyUrl: string, reason: string): void; grant(principal: string, role: "publish" | "lock", path: string): void; limitedToken(): string }
// conformance.ts: RegistryUnderTest gains limitedToken?: string; completeLogin?(verifyUrl: string, identity: { email: string; groups?: string[] }): Promise<void>
```

- [ ] **Step 1: Failing tests.**
  - `schemas.test.ts`: `it("tolerant schemas read older and newer answers")` (a `whoami` without
    `kind`/`roles` parses; one with an extra field parses and drops it; a `Problem` with code
    `"teapot"` parses); `it("the strict copies refuse unknown fields")`; `grantCovers` cases:
    `("team/pay","team/payments")` false, `("team","team/payments")` true, `("*","org/x")` true,
    `("team/payments","team/payments")` true.
  - Kit cases (run by `mock.test.ts`): login start shape (strict); pending → 428
    `authorization-pending`; a second poll inside `interval` → 429 `slow-down` (the mock uses a
    non-zero interval for this case via `start()`'s per-case options — add `start(options?)`);
    expired → 410 `login-expired`; unknown login and wrong `pollSecret` → 404; completed → token
    whose `whoami` has `subject` = the email and `kind: "session"`, reads work; refused → 403
    `forbidden`; with `limitedToken`: reads work, publish → 403 `forbidden` naming the ref, dry run
    → 200, `whoami.roles` → `[]`.
  - Mock-only tests: `it("grants match by whole segment")`; `it("a locks change needs lock")`;
    group grants via `grant("group:leads", …)` apply to a session whose identity has that group.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/registry-api exec vitest run` — Expected: FAIL.
- [ ] **Step 3: Implement.** The mock keeps its default token as a service token holding `publish`
  and `lock` on `*`; sessions are `zzp_`-prefixed random tokens; enforcement runs before
  `publishLayer` exactly per the Global Constraints. Regenerate `openapi.json` (`vitest run -u`).
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` — Expected: PASS (store-remote and
  CLI still pass on the tolerant schemas).
- [ ] **Step 5: Commit** `feat(registry-api): sign-in routes, roles, forbidden, tolerant reading`.

### Task 2: CLI sign-in (`feature/identity-2-cli`)

**Files:** Modify `src/packages/store-remote/src/client.ts` (login functions), its test;
`src/apps/cli/src/commands/registry.ts` (`login`, `whoami`, `publish` hint), `doctor/checks.ts`
(expiry), `cli.ts` (`login --no-browser`, `--token`), `cli.ts` `CliIo.openBrowser?`,
`CliIo.sleep?`; tests `src/apps/cli/src/registry-login.test.ts`.

**Interfaces:**
- Consumes: Task 1's `LoginStart`, `LoginToken`, `ROUTES.startLogin`/`pollLogin`, mock helpers.
- Produces:
```ts
// store-remote/client.ts
export function startLogin(url: string, options?: { signal?: AbortSignal }): Promise<LoginStart>; // RegistryError("not-found") when the registry has no sign-in
export function pollLogin(url: string, loginId: string, pollSecret: string, options?: { signal?: AbortSignal }): Promise<LoginToken>; // throws RegistryError with code authorization-pending | slow-down | login-expired | forbidden | not-found
// CliIo
openBrowser?: (url: string) => Promise<void>; // default: open / xdg-open / cmd /c start, errors ignored
sleep?: (ms: number) => Promise<void>;
```

- [ ] **Step 1: Failing tests** (`registry-login.test.ts`, mock + seeded temp home + injected
  `openBrowser`, `sleep` and `runInput`):
  - `it("signs in through the browser")`: `login <url>` prints `Open <verifyUrl> and confirm the code
    <code>`, `openBrowser` called with `verifyUrl`, the test completes the login after the first
    poll, output `logged in to <url> as alice@corp.com (session until <date>)`, the token stored
    (keychain fake receives it via stdin), `config.yaml` has the URL.
  - `it("backs off on slow-down")`: the injected `sleep` sees `interval` then `interval + 5` seconds.
  - `it("an expired or refused login stores nothing")`: exit 1, message from the problem, no token
    stored, no config change.
  - `it("the browser is optional")`: `--no-browser`, `CI=true`, and an `openBrowser` that rejects —
    all still print the URL and finish.
  - `it("login never prints the token or poll secret")`: scan stdout/stderr of text and `--json`
    runs; `--json` is `{ url, subject, expiresAt }`.
  - `it("a registry without sign-in points to --token-stdin")`.
  - `it("--token prompts for a pasted token as before")` (the old hidden prompt moves behind
    `--token`); `--token-stdin` unchanged.
  - `it("whoami shows the session and roles")`; `it("publish forbidden hints the grant")`;
    `it("doctor warns when the session ends within 2 days")`.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/cli exec vitest run src/registry-login.test.ts` —
  Expected: FAIL.
- [ ] **Step 3: Implement**; the poll loop stops at `expiresIn` or SIGINT (exit 130, nothing stored);
  Ctrl-C is wired through an `AbortController`.
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): sign in through the browser`.

### Task 3: Docs (`feature/identity-3-docs`)

**Files:** Modify `README.md` (Registry: sign-in, `--no-browser`, roles, the CLI ≥ 0.11 note),
`CLAUDE.md` (item 20; status; replace "next is B" with B shipped as the private control plane and C
in progress), `docs/planning/03-architecture.md` (dated note under Control plane: identity),
`docs/planning/18-registry-contract.md` (dated note: tolerant reading, identity in spec 20),
`docs/planning/20-registry-identity.md` (amendments). Create `.changeset/registry-identity.md`
(minor `@zzpersona/registry-api`, `@zzpersona/store-remote`, `@zzpersona/cli`; says a registry with
sign-in needs `@zzpersona/cli` 0.9.0 or later — the CLI package is at 0.8.1, so this minor bump
makes it 0.9.0 inside product release 0.11.0; the README states both numbers).

- [ ] **Step 1: Docs**, prose wrapped at 100, dated 2026-10-22.
- [ ] **Step 2: Run** `pnpm turbo run build check-types lint test` and `pnpm format:check` —
  Expected: PASS.
- [ ] **Step 3: Commit** `docs: registry identity`.
