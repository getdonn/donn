# 20 — Registry identity

> Status: design, 2026-10-22. Phase 3, the open-source half of sub-project C (identity: OIDC and
> roles; see `18-registry-contract.md` → "Phase 3 decomposition"). The server half is the private
> repo's spec 02. Builds on `18-registry-contract.md` and `19-publish-engine.md`. Built as a
> `gh stack`: layer 0 is this spec and its plan.
> 2026-10-23: renamed zzpersona/hatrack → donn (spec 22).

## Intent

Developers sign in to a registry with their company identity instead of pasting a token:
`donn login <url>` opens a browser, the person signs in with the organisation's identity
provider, and the CLI receives a session token that expires. Publishing becomes a privilege granted
per layer path (`publish`, and `lock` for changing locks), so a registry can be shared by a whole
organisation. This spec adds what the contract and the CLI need; the server enforces it.

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| The server brokers the login: the CLI starts a login, the person finishes it in a browser on the server, the CLI polls and receives a server-issued `donn_` session token | The CLI runs OIDC against the identity provider itself; both | Works with every OIDC provider (no device-flow support needed); the CLI only needs the server URL; provider secrets stay on the server; revoking a person is one row |
| Role grants (`publish`, `lock` per layer path) live in the server, managed with its admin CLI, naming identity-provider groups, users or service tokens | Grants declared in the org persona; grants derived from group names | Explicit, auditable, no bootstrap circularity, no access list inside every build |
| Every signed-in principal of the org may view every layer | Explicit view grants; view grants that include ancestors | Layers hold `secret://` references, never values; a layer whose ancestors are hidden cannot resolve |
| Responses are read tolerantly from this release on: unknown fields are ignored and unknown problem codes kept | Strict response schemas | Spec 18's strict schemas make any added field a `registry-protocol` error in older CLIs; servers will keep adding fields |

## 1. Login routes

All under `/v1/auth`, no bearer token required.

| Route | Answer |
|---|---|
| `POST /v1/auth/logins` | `201 { loginId, verifyUrl, code, pollSecret, interval, expiresIn }` |
| `POST /v1/auth/logins/{loginId}/token` body `{ pollSecret }` | `200 { token, subject, expiresAt }` once the person finished; else a problem |

- `code` is 8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, shown as `ABCD-EFGH`;
  `verifyUrl` is on the registry and shows the same code. `interval` is the minimum seconds between
  polls (default 5); `expiresIn` is seconds (default 600).
- Poll problems: `428 authorization-pending` (not finished yet), `429 slow-down` (polled faster than
  `interval`; the CLI adds 5 seconds), `410 login-expired` (expired, refused or already redeemed),
  `404 not-found` (unknown login or wrong `pollSecret` — indistinguishable on purpose), `403
  forbidden` (the person finished but was refused, e.g. their domain is not allowed; `detail` says
  why).
- A registry without an identity provider answers `404 not-found` on `POST /v1/auth/logins`; the
  CLI then says `this registry has no sign-in; use donn login <url> --token-stdin`.
- A login is redeemed once; its token is returned once.

## 2. Contract changes

- **Problem codes** gain `forbidden`, `authorization-pending`, `slow-down`, `login-expired`.
- **`whoami`** gains optional `kind: "session" | "service"`, `roles: [{ role: "publish" | "lock",
  path }]` (the caller's effective grants; `path` is a layer path or `*`) and, for sessions,
  `expiresAt`.
- **Publish** may answer `403 forbidden` with `problems: [{ code: "forbidden", ref, message }]`,
  the message naming the missing role and path. A dry run never answers 403.
- **Tolerant reading:** the exported response schemas (`Whoami`, `LayerSummary`, `LayerVersion`,
  `PublishResult`, `Problem`, the login responses) ignore unknown fields, and `Problem`'s codes
  accept any string; `ProblemCode` stays the list a server may send. The conformance kit keeps
  checking servers strictly (`ConformanceSchemas`, strict copies), so servers stay exact while
  clients stay forgiving.
- **Compatibility:** CLIs before this release reject the new `whoami` fields and codes, so a
  registry with identity (control plane 0.2) needs this CLI or later. Said in the README and the
  changeset.

## 3. CLI

- `donn login <url>` (no token): starts a login, prints `Open <verifyUrl> and confirm the code
  <code>`, opens the browser (`open`, `xdg-open`, or `start`; never with `--no-browser` or when
  `CI` is set), polls at `interval` (adding 5 s on `slow-down`) until a token or `expiresIn`, then
  stores the token as today (keychain, file fallback) and prints `logged in to <url> as <subject>
  (session until <date>)`. Ctrl-C stops cleanly. `--token-stdin` is unchanged.
- `donn whoami` prints `<subject> at <url>` plus, when present, `session until <date>` and the
  roles (`publish team/payments, lock org`); `--json` returns the whole answer.
- `publish` shows `forbidden` with the hint `ask a registry admin for publish on <path>` (or `lock`).
- Freshness: an expired session is `401 unauthorized`, already reported as `registry refused the
  token …; donn login <url>`.
- `doctor` `registry-token` shows the session's expiry and warns within 2 days of it.

## 4. Mock and conformance kit

- The mock implements §1–§2 with a fake provider: `startMockRegistry({ identities? })`, plus
  `mock.completeLogin(verifyUrl, { email, groups })`, `mock.refuseLogin(verifyUrl, reason)` and
  `mock.grant(principal, role, path)`. Its login `interval` is 0 in tests (configurable). It enforces
  `publish`/`lock` exactly as spec 02 will: grants on a path cover it and everything under it, by
  whole segment; `*` covers everything; a change to `locks` also needs `lock`. Its default token is
  a service token with `publish` and `lock` on `*`, so spec 18's cases keep passing.
- `registryConformance(start)`: `start()` may also return `limitedToken` (a valid token with no
  grants) and `completeLogin(verifyUrl, identity)`. New cases: login start shape; pending; slow
  down; expired; unknown login and wrong poll secret both 404; a completed login yields a token
  whose `whoami` names the identity, `kind: "session"`, and works for reads; a limited token can
  read, gets `403 forbidden` on publish, can dry-run, and has `roles: []`. Cases needing an
  optional hook are skipped when the hook is absent.

## 5. Stack and testing

| Layer | Contents |
|---|---|
| 0 `spec` | this spec and its plan |
| 1 `contract` | schemas (codes, `whoami`, login routes, tolerant reading, strict kit copies), `openapi.json`, the mock's login and grants, kit cases |
| 2 `cli` | `login` browser flow, `whoami` and `publish` output, `doctor` expiry, store-remote client methods |
| 3 `docs` | README, CLAUDE.md, `03` note, spec 18 note, changeset (minor `registry-api`, `store-remote`, `cli`) |

- Client: the login loop against the mock (pending, slow-down back-off, expiry, refusal), the
  browser never opened with `--no-browser` or `CI`, the token stored once, never printed.
- Tolerance: a client reading a `whoami` and a problem with fields and codes it does not know.
- Kit: every new case against the mock.

## Non-goals

The server's OIDC client, pages, sessions and grants (private spec 02); view restrictions; SCIM;
SAML; refreshing groups between logins.

## Open questions

None.

## Amendments from implementation (2026-10-22)

Rulings made while building, each changing or settling what is written above.

- **`PublishResult` variant order.** The union tries the dry run and the unchanged result before
  the publish, so tolerance for unknown fields never reads a dry run or an unchanged answer as a
  publish.
- **Tolerant `BundleFile` in responses.** Responses are read with a tolerant file shape; requests
  and the conformance kit stay strict.
- **`openapi.json`** is built from `ConformanceSchemas`, so it lists the problem codes and closes
  its objects.
- **Unknown problem codes map by HTTP status:** 401 `unauthorized`, 403 `forbidden`, 404
  `not-found`, 409 `stale-base`. This keeps the login hint on a 401 whose code the client does not
  know.
- **Kit hooks.** The kit's start signature is `start(options?)`, so a case can ask for a non-zero
  `interval`. Optional hooks: `supportsLoginTiming` (the slow-down and expiry cases are skipped
  without it), `limitedToken` (the grant cases), `completeLogin`, and `refuseLogin` (the login
  cases). A registry without a hook skips the cases that need it. `signIn` gates
  only the `404 not-found` case for `POST /v1/auth/logins`: `signIn: false` declares a registry
  without sign-in and runs that case; when `signIn` is unset or `true`, that case is skipped. The
  other sign-in cases are gated by `completeLogin`, `refuseLogin`, `supportsLoginTiming` and
  `limitedToken`.
- **Strict kit problems.** The kit's `ConformanceSchemas.Problem` items are strict: an unknown
  field inside `problems[]` fails a server (clients stay tolerant).
- **The sign-in link must have the registry's own protocol and origin, or it is refused** with
  `registry-protocol` (a `blob:` link has a matching origin, so the protocol is checked too). Only
  the parsed `href` is printed or opened.
- **A 401 on `POST /v1/auth/logins` is read as no sign-in** (registries before control plane 0.2
  check auth before routing, and a route that takes no token cannot answer 401 on purpose). The
  CLI treats it like 404 and prints the no-sign-in message.
- **Order of checks on `POST /v1/layers/{ref}/versions`** (the mock's order; private spec 02 must
  match): token, then body parse, then (a dry run skips grants) the `publish` grant, then the
  `lock` grant, then the engine. A body that does not parse skips the grant checks, and the
  engine reports `invalid`.
- **The tolerant `Whoami` reads any `kind` and any role string**, and the tolerant datetimes
  accept an offset; the strict copies in `ConformanceSchemas` keep the enums and `Z` datetimes.
  The kit also checks that `verifyUrl` has the registry's own origin and protocol.
- **The opener.** `open` on macOS, `xdg-open` elsewhere, and on Windows `rundll32
  url.dll,FileProtocolHandler`. No shell is ever used.
- **Polling.** The interval is floored at 1 second, and each sleep is capped at the time remaining,
  so there is always a last poll before expiry.
- **One helper strips control characters** from every server string the CLI prints (subject, code,
  messages, hints).
- **The grant hint** (`ask a registry admin for <role> on <ref>`) appears only on `publish`.
- **`--token`** now carries the old hidden paste prompt; `--token-stdin` is unchanged.
- **`doctor`** shows the session end date, and warns when it is close.

Deferred minors:

- Contract: a malformed `{ dryRun: true, version, digest, ... }` body without `diff` parses as a
  publish (`dryRun` is stripped); a discriminated union would refuse it.
- Mock and kit: the mock compares `pollSecret` with `!==` (use `timingSafeEqual`); the "same locks
  again" assertion is vacuous; the expiry case sleeps 1.2 s (poll until 410 instead); `openapi.json`
  attaches every error status to every route.
- CLI: a transient unreachable or timeout ends the login (retry until `expiresIn`); `doctor`'s
  expiry warning hides the file-storage warning (combine them); the default SIGINT path and
  `abortableSleep` are untested; a sign-in link with userinfo is accepted (host and protocol are
  pinned; reject a non-empty username or password); `--json` output carries raw server strings
  (JSON-escaped; U+202E passes).
