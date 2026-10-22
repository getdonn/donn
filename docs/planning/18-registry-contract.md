# 18 — Registry contract and client

> Status: design, 2026-10-22. Phase 3's first sub-project (A of the decomposition below). Builds on
> `02-persona-spec.md` (layers, locks), `03-architecture.md` → "Control plane", `06-cli-core-loop.md`
> (`store-local`, secrets), `08-cli-reach.md` (the keychain provider) and `16-daemon-service.md`.
> Built as a `gh stack`: layer 0 is this spec and its plan.

## Phase 3 decomposition

Phase 3 is built ahead of any design partner: the target is one known organisation once most of
it is complete, and that organisation's needs are where the Bifrost gateway, Docker, Helm and
air-gapped items come from (amends `04`'s "build only the slice a design partner asks for").
Each sub-project gets its own spec.

| # | Sub-project | Repo | Depends on |
|---|---|---|---|
| A | Registry contract and client: the OpenAPI contract, `store-remote`, `login`, `publish`, `pull`, a mock server and a conformance kit | OSS | — |
| B | Control plane core: Postgres, versions, publish API with server-side lock enforcement, service tokens, append-only audit | private | A |
| C | Identity: OIDC, RBAC (view / publish / lock) per layer path | private | B |
| D | Drift: the daemon reports local vs published | OSS | A |
| E | Claude Code enforcement: org locks → `managed-settings.d` + `managed-mcp.json` bundle for MDM | OSS compile, private packaging | — |
| F | Gateway adapter v1: Bifrost and LiteLLM | OSS interface, private admin sync | B |
| G | Deploy: Docker, Helm, air-gapped, licensing | private | B, C |
| H | Minimal console | private | B, C |

Before B: the private repo needs the OSS packages published. GitHub Packages scopes npm packages
to the repository owner, so `@zzpersona/*` needs a `zzpersona` GitHub org (or the chosen name's).
Decided when B starts.

> Amended 2026-10-22: F is now "Gateway adapter v1: Bifrost and LiteLLM": an OSS `list`/`resolve`
> interface (`gateway://name` becomes an HTTP MCP entry, the credential a `secret://` ref), with the
> admin-scope allowed-set sync private and no device-side enforcement (Bifrost Edge does that).
> Gateways are optional everywhere: direct MCP servers (`command`/`args`, URL) stay first-class, and
> "only `gateway://`" is an org's own lock (`03` → Security, enterprise mode), never a default. E is
> unchanged: orgs running Edge already have MDM, which is E's delivery channel. D may later compare
> what was intended against Edge's observed device inventory instead of building our own.

## Intent

A lead publishes a layer (org, area or team) to a registry; everyone else pulls it and resolves
against exactly what was published, offline once pulled. This spec fixes the contract between the
OSS client and the private control plane, builds the client, and ships a mock server plus a
conformance kit that the real server (B) must pass.

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| Pulled layers live in a read-only cache that the store mounts | Pull writes into the personas folder; fetch from the registry on every resolve | Offline by default, published bytes kept exact (the base drift needs), and 03's "never a runtime dependency" |
| A published layer wins over a same-name local one, with a warning; `--local` and `publish --dry-run` for authoring | Local wins; separate `registry://` refs | What a team runs is what was published; a local edit is drift, not a silent override; the same persona works online and offline |
| Ancestors float to the latest published version; publishing a parent is checked against its published descendants | Pin ancestors at publish; floating with optional `@n` pins | An org baseline change reaches every team on the next pull without each team republishing; pins can come later if asked for |
| Bearer tokens now (keychain, env override for CI); C adds the OIDC device flow | Device flow now against a fake IdP; no auth until C | Nothing in A changes shape when C lands; OIDC decisions (issuer, scopes, refresh) belong with C |
| Zod-first contract in `@zzpersona/registry-api`, OpenAPI generated | OpenAPI YAML first with generated types; Hono RPC | One source of truth already in the repo's idiom; a typed RPC client would make the OSS client import the private server |
| A published version is a bundle: the YAML plus every file it references | YAML only | Layers point at instruction files, skill folders and hook scripts relative to themselves |
| One registry per home | A list of registries | YAGNI; a mirror can come later |

## 1. The contract (`@zzpersona/registry-api`)

- Zod schemas for every request and response, and `ROUTES` (method, path, request and response
  schemas) so the client and the server agree on paths. `openapi.json` (OpenAPI 3.1) is generated
  at build from `z.toJSONSchema`, as `@zzpersona/spec` already does for its schemas; no new
  dependency. The generated file is committed as a golden file and published with the package.
- Every route takes `Authorization: Bearer <token>`. Errors are `application/problem+json`:
  `{ type, title, status, detail, problems?: [{ code, ref?, path?, message }] }`.

| Route | Answer |
|---|---|
| `GET /v1/whoami` | `{ subject, org }` |
| `GET /v1/layers` | `[{ ref, version, digest }]`, the layers the caller can see |
| `GET /v1/layers/{ref}/versions/{n\|latest}` | `{ ref, version, digest, source, files, publishedAt, publishedBy }` |
| `POST /v1/layers/{ref}/versions` | body `{ source, files, baseVersion, dryRun?, force? }` |

- `source` is the layer's YAML text as published; `files` is `[{ path, content }]`, `path` relative
  to the layer's folder (posix, no `..`), `content` base64. `digest` is the sha256 of a canonical
  manifest of the YAML and the files (sorted by path).
- `ref` is `org/<name>`, `area/<name>` or `team/<name>`. `project/*` and `user/*` are refused
  (`not-publishable`): the project layer lives in its repo, the user layer is the user's.
- Publish answers:
  - `201 { version, digest, broken: [] }` — published;
  - `200 { unchanged: true, version, digest }` — the bundle's digest equals the latest version's;
  - `200 { dryRun: true, diff, broken }` with `dryRun` — nothing stored; `diff` is the resolver's
    diff of the layer's resolved persona against the latest published version;
  - `409` `stale-base` — `baseVersion` is not the latest;
  - `422` with `problems[]`, codes: `invalid` (schema), `not-publishable`, `missing-file` (a
    referenced file not in the bundle), `path-escapes-layer`, `bundle-too-large` (over 10 MB),
    `unpublished-ancestor`, `lock-violation` (names both layers), `breaks-descendants` (names each
    broken layer; with `force` the version is published and `broken` lists them).
- `401` `unauthorized` for a missing or refused token.

## 2. Publish rules

The contract defines them, the mock implements them, and B's server must match them:

1. Validate the bundle: schema, publishable ref, every referenced file present and inside the
   layer's folder, at most 10 MB.
2. Every `extends` target is published.
3. Resolve the new layer against the latest published ancestors (the resolver, as the client
   does); a lock it breaks fails.
4. Re-resolve every published layer below it with the candidate in place; any that now fail are
   `breaks-descendants` unless `force`.
5. `baseVersion` must be the latest (0 for a new ref). A digest equal to the latest is
   `unchanged`, no new version.

## 3. The client (`@zzpersona/store-remote`)

- **Cache:** `~/.zzpersona/cache/registry/<ref>/<version>/` holds a version's YAML (`layer.yaml`)
  and its files. `index.json` holds the registry URL and each ref's current version and digest. A
  pull writes each new version to a temp folder, renames it into place, and writes `index.json`
  last; a pull that fails leaves the old cache in use. A changed registry URL clears the cache.
  Older versions are removed after the index moves past them.
- **Mount:** the local store consults the cache first for every ref in `index.json`. A local file
  for the same ref whose content differs prints, once per command, `<ref>: using published @<n>;
  local copy differs`. `--local` on `resolve`, `compile` and `diff` leaves the cache out.
- **Resolver change:** `PersonaSource` gains an optional `dir(ref): string`, the virtual folder a
  layer's relative paths resolve against (today `dirname(ref)`). Published layers answer
  `.registry/<ref>`, and the store maps `.registry/<ref>/<path>` to that version's folder, so two
  published layers in one folder can each bundle their own `instructions/conduct.md`.
- **Freshness:** `zzpersona claude`, `codex` and `switch` pull first when the cache is older than
  `registry.maxAge` (config, default 15 minutes), within a 1 s budget. On failure or timeout they
  use the cache and print once `registry unreachable; using cached layers from <age> ago`.
  `--dry-run` and `--json` runs never pull. Background sync in the daemon is a later slice.
- **Tokens:** the keychain backend from spec 08 gains `set` and `delete` (macOS `security
  add-generic-password` / `delete-generic-password`, Linux `secret-tool store` / `clear`), service
  `zzpersona-registry`, account the registry URL. Without a keychain (Windows, or none found) the
  token goes to `~/.zzpersona/registry-token` at mode 0600 and `doctor` warns.
  `ZZPERSONA_REGISTRY_TOKEN` overrides both. The token never appears in logs, errors or `--json`.
- **Transport:** `https://` only, except loopback (`127.0.0.1`, `::1`, `localhost`) so the mock and
  local development work. Each request has a 10 s timeout (the freshness pull keeps its 1 s).
  Responses are validated with the contract's schemas; a response that does not match is
  `registry-protocol` naming the route.

## 4. Commands

All support `--json`.

- `zzpersona login <url> [--token-stdin]`: reads the token (prompt without echo, or stdin), checks
  it with `whoami`, saves `registry: { url }` to `config.yaml` and the token as above, prints
  `logged in to <url> as <subject>`. A refused token saves nothing.
- `zzpersona logout`: removes the token; the URL and the cache stay.
- `zzpersona whoami`: `<subject> at <url>`, or `not logged in`.
- `zzpersona pull`: lists, fetches the versions whose digest changed, removes refs the registry no
  longer lists; prints one line per change (`org/base 7 → 8`, `team/web new @1`, `team/old
  removed`) or `up to date`.
- `zzpersona publish <ref> [--dry-run] [--force]`: bundles the local layer (from the personas
  folder, never the cache), `baseVersion` from the cache, posts it; prints `published <ref> @<n>`,
  `unchanged`, the dry-run diff, or each problem with its code. `stale-base` hints `zzpersona pull,
  then publish again`; `breaks-descendants` hints `--force`. A successful publish updates the cache.
- **State:** `state.json` and `switch --json` gain `builtFrom: { "<ref>": <version> }` for the
  published layers a resolve used.
- **Doctor:** with a registry configured: reachable, token accepted, cache age.

## 5. Mock server and conformance kit

- `@zzpersona/registry-api/mock`: `startMockRegistry(options?) → { url, token, stop }`, an
  in-memory `node:http` server on a random loopback port with a fixed token. It implements §1–§2
  using `@zzpersona/resolver`.
- `@zzpersona/registry-api/conformance`: `registryConformance(start)`, a vitest suite covering every
  route, every problem code and every publish rule. The mock runs it here; B runs it against the
  real server.

## 6. Stack and testing

| Layer | Contents |
|---|---|
| 0 `spec` | this spec and its plan |
| 1 `api` | `registry-api`: schemas, `ROUTES`, the OpenAPI generator and golden file, the mock, the conformance kit |
| 2 `foundations` | the resolver's `PersonaSource.dir`; keychain `set` / `delete` |
| 3 `store-remote` | client, cache, mount |
| 4 `cli` | `login`, `logout`, `whoami`, `pull`, `publish`, freshness, `builtFrom`, doctor checks |
| 5 `docs` | README, CLAUDE.md, `03` notes, the dated `04` amendment, changeset, check run |

- No real network: the in-process mock on a loopback port. No real keychain: the existing command
  runner seam. Temp homes everywhere.
- The conformance suite against the mock; the `openapi.json` golden file.
- Cache: a pull that fails midway leaves the old cache; a changed URL clears it.
- Mount: the published layer wins, the warning prints once, `--local` skips it; two published
  layers bundling the same relative path resolve to their own files.
- Freshness: a server that never answers costs at most 1 s and prints the warning; `--json` never
  pulls.
- Publish: `stale-base`, `unchanged`, `breaks-descendants` with and without `--force`,
  `path-escapes-layer`, `not-publishable`.
- Token: never in stdout, stderr or `--json`; `http://` to a non-loopback host refused.
- **Check run, before the final review:** the built CLI against the mock started from a script:
  login, publish the examples' `org/acme` and `team/web`, pull in a second temp home, `zzpersona
  claude --dry-run` in `examples/demo-app`.

## Non-goals

OIDC and RBAC (C); the real server, Postgres and audit (B); yanking or deleting versions;
`registry://` skills; version pinning; several registries; background sync in the daemon; drift
(D).

## Amendments from implementation (2026-10-22)

- **Publish check order (§2):** validate (1) first, then `stale-base` and `unchanged` (5), then
  ancestors, locks and descendants (2-4). A stale client is told to pull before it is shown
  problems computed against state it has not seen. `dryRun` still skips `stale-base`: it is a
  preview.
- **Hooks and skills in a bundle:** every hook `run` is a path (as the resolver treats it); a skill
  reference containing `://` is not a file and is skipped, exactly as the resolver does.
- **Digest, canonical form v1 (§1):** `sha256:` plus the hex sha256 of this UTF-8 text:

  ```
  zzpersona-bundle/1\n
  layer.yaml <sha256hex(UTF-8 bytes of source)>\n
  <path> <sha256hex(decoded file bytes)>\n        (one line per file)
  ```

  Paths are normalised first (a leading `./` stripped, then `posix.normalize`) and the file lines
  are sorted by the UTF-8 bytes of the normalised path, so file order and a leading `./` never
  change the digest. A control character in a path is `invalid`; the client refuses it too.
- **Problem codes:** `not-found` is added (an unknown ref or version, `404`).
- **Cache folder (§3):** a version lives in `<ref>/@<version>-<first 12 hex of digest>/`, replacing
  `<ref>/<version>/`. `@` cannot start a ref segment, so a ref and a version never collide, and a
  changed digest installs a new folder instead of replacing one the index names.
- **Pull lock:** a pull (and recording a publish) holds `cache/registry/.lock`, created exclusive
  with the pid. It is stale when the pid is dead or the file is more than 60 s old. A waiter polls
  until the caller's signal aborts, so a freshness pull gives up at its 1 s budget and uses the
  cache. Temp-folder sweeps run only under the lock; pruning keeps only folders the new index names.
- **Secrets are scrubbed:** the client removes the token from `detail` and from every problem's
  message, ref and path before an error leaves it.
- **Freshness lines (§3):** without a token, `not logged in to <url>; using cached layers`; when
  the registry refuses the token, `registry refused the token for <url>; using cached layers —
  zzpersona login <url>`; unreachable keeps `registry unreachable; using cached layers from <age>
  ago`.
- **`builtFrom` (§4)** is in `resolve --json` and `switch --json` only. `state.json` holds
  choices, not builds, so it does not carry it.
- **macOS keychain:** `security` exit 44 means not found, for read and delete. This also fixes a
  `secret://` read of a missing macOS keychain item, which used to report "security exited 44".
- **Token input:** `login` takes the token from stdin (`--token-stdin`) or a hidden prompt on a
  terminal; the keychain write passes the value through stdin, never argv.
- **Check run** (built CLI against the mock, temp homes, `ZZPERSONA_REGISTRY_TOKEN`; `login` was
  not run against the real keychain):
  - home a, a copy of `examples/personas`: `whoami` printed `mock-user at <url>`; `publish org/acme`
    and `publish team/web` printed `published org/acme @1` and `published team/web @1`;
  - home b, empty personas: `pull` printed `org/acme new @1` and `team/web new @1`, then `up to
    date`; `resolve team/web --json` had `builtFrom { org/acme: 1, team/web: 1 }`, resolved from
    the cache alone; `zzpersona claude --dry-run` in `examples/demo-app` built, the skill copied
    from `.registry/team/web/skills/web-review`;
  - home a added an allow rule to `team/web`: `publish team/web --dry-run` printed `team/web: dry
    run, nothing published` and `+ permissions.allow[Bash(pnpm typecheck:*)]`; `publish` printed
    `published team/web @2`; home b `pull` printed `team/web 1 → 2`; an unchanged re-publish
    printed `team/web unchanged @2`;
  - with a local file differing from @2, `resolve team/web` printed `team/web: using published @2;
    local copy differs` once, and `--local` printed nothing;
  - a home whose index said `team/web` @1: `publish team/web` printed `error: stale-base: team/web
    is at version 2, not 1` and `hint: zzpersona pull, then publish again`, exit 1.
- **Known minor:** after a publish, `index.json` `pulledAt` is epoch 0, so the next launch pulls.

## Open questions

None.
