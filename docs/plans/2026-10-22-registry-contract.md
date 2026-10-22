# Registry Contract and Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A zod-first registry contract with a mock server and conformance kit, a `store-remote`
client whose read-only cache the store mounts, and `zzpersona login|logout|whoami|pull|publish`.

**Architecture:** A `gh stack` on `feature/registry-0-spec` (`gh stack add
feature/registry-<n>-<name>`). New packages `src/packages/registry-api` (schemas, routes, OpenAPI,
mock, conformance) and `src/packages/store-remote` (client, cache, mount, bundling). Small changes
to `resolver` (`PersonaSource.dir`) and `secrets` (keychain write). The CLI wires them in.

**Tech Stack:** TypeScript, Node 26 (`fetch`, `node:http`, `node:crypto`), zod 4
(`z.toJSONSchema`), yaml, vitest. No new third-party dependencies.

**Spec:** `docs/planning/18-registry-contract.md`

## Global Constraints

- New packages copy `src/packages/store-local`'s `package.json` shape (`"private": true`,
  `"license": "Apache-2.0"`, `"type": "module"`, `dist` exports, the same scripts and dev deps),
  `tsconfig.json` and `tsconfig.build.json`.
- Routes: `GET /v1/whoami`, `GET /v1/layers`, `GET /v1/layers/{ref}/versions/{n|latest}`,
  `POST /v1/layers/{ref}/versions`. `{ref}` is URL-encoded (`team%2Fweb`). Bearer auth on every
  route. Errors `application/problem+json` `{ type, title, status, detail, problems? }`.
- Problem codes: `unauthorized`, `not-found`, `stale-base`, `invalid`, `not-publishable`,
  `missing-file`, `path-escapes-layer`, `bundle-too-large`, `unpublished-ancestor`,
  `lock-violation`, `breaks-descendants`. Bundle cap 10 MB (10 × 1024 × 1024 bytes of decoded
  content plus YAML).
- Publishable refs: `org/*`, `area/*`, `team/*`.
- Cache: `<home>/cache/registry/<ref>/<version>/layer.yaml` plus files; `<home>/cache/registry/
  index.json` `{ url, pulledAt, layers: { [ref]: { version, digest } } }`.
- Published layers' virtual folder: `.registry/<ref>`.
- Warning copy: `<ref>: using published @<n>; local copy differs`;
  `registry unreachable; using cached layers from <age> ago`.
- Token: keychain service `zzpersona-registry`, account the normalised registry URL; fallback file
  `<home>/registry-token` mode 0600; env override `ZZPERSONA_REGISTRY_TOKEN`. Never in stdout,
  stderr, errors or `--json`.
- Transport: `https:` only, except loopback hosts `127.0.0.1`, `::1`, `localhost`. 10 s request
  timeout; the freshness pull has a 1 s budget for the whole pull.
- `registry.maxAge` in `config.yaml` is whole minutes, default 15.
- `builtFrom` goes in `resolve --json` and `switch --json` only, not `state.json`: `state.json`
  holds choices per project, not builds (a narrowing of spec §4; Task 5 records it as an
  amendment).
- Every layer passes `pnpm turbo run build check-types lint test` and `pnpm format:check`; commits
  end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Tests never touch the real
  `~/.zzpersona`, `~/.claude`, the real keychain or the network beyond loopback.

## Review Focus

1. A pull killed midway (or a version fetch that fails after others succeeded) → the old
   `index.json` and its folders still resolve; leftover temp folders are swept by the next pull →
   Task 3 test "an interrupted pull leaves the old cache".
2. A layer whose referenced file or skill folder holds a symlink pointing outside the layer's
   folder (e.g. to `~/.ssh`) → `path-escapes-layer` from the client before anything is sent →
   Task 3 test "bundling refuses a symlink out of the layer".
3. A token piped with a trailing newline (`echo $T | zzpersona login … --token-stdin`) works, and a
   server error that echoes the request never puts the token in output → Task 4 tests "login trims
   a piped token" and "the token never reaches output".
4. A registry URL with a trailing slash or a path prefix (`https://reg.corp/zz/`) → routes join
   under the prefix, and `…/zz` vs `…/zz/` does not clear the cache → Task 3 test "URLs are
   normalised".
5. `zzpersona claude` with a registry configured but no token, or no registry at all → no pull
   attempt beyond one line (`not logged in to <url>; using cached layers`), never an error, and
   with no registry nothing at all → Task 4 test "freshness without a token".

---

### Task 1: The contract (`feature/registry-1-api`)

**Files:** Create `src/packages/registry-api/` with `src/schemas.ts`, `src/routes.ts`,
`src/bundle.ts`, `src/openapi.ts`, `src/mock.ts`, `src/conformance.ts`, `src/index.ts`, tests
`src/bundle.test.ts`, `src/openapi.test.ts`, `src/mock.test.ts`; `openapi.json` (golden, in
`files`). `package.json` `exports`: `"."`, `"./mock"`, `"./conformance"`; deps `@zzpersona/spec`,
`@zzpersona/resolver`, `yaml`, `zod`; `vitest` as a peer dependency (for `conformance`) and dev
dependency. Add `openapi.json` to `.prettierignore`.

**Interfaces (produces):**
```ts
// schemas.ts — zod schemas and their inferred types
export const LayerRef: z.ZodType<string>;            // ^(org|area|team)/[a-z0-9][a-z0-9-]*(/[a-z0-9][a-z0-9-]*)*$
export const BundleFile;      // { path: string; content: string /* base64 */ }
export const Whoami;          // { subject: string; org: string }
export const LayerSummary;    // { ref; version: int ≥ 1; digest: "sha256:<hex>" }
export const LayerVersion;    // LayerSummary & { source; files: BundleFile[]; publishedAt: ISO; publishedBy }
export const PublishRequest;  // { source; files; baseVersion: int ≥ 0; dryRun?: boolean; force?: boolean }
export const PublishResult;   // union: { version, digest, broken: string[] }
                              //      | { unchanged: true, version, digest }
                              //      | { dryRun: true, diff: Change[], broken: string[] }
export const Problem;         // { type, title, status, detail, problems?: { code, ref?, path?, message }[] }
export type ProblemCode = "unauthorized" | "not-found" | "stale-base" | "invalid" | "not-publishable"
  | "missing-file" | "path-escapes-layer" | "bundle-too-large" | "unpublished-ancestor"
  | "lock-violation" | "breaks-descendants";
// routes.ts
export const ROUTES: { whoami; listLayers; getVersion; publish }; // each { method, path, response, request? }
export function routePath(template: string, params: Record<string, string>): string; // encodes params
// bundle.ts
export const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
export function bundleDigest(source: string, files: BundleFile[]): string; // "sha256:<hex>"
export function referencedPaths(doc: Persona): { files: string[]; dirs: string[] }; // relative to the layer
// openapi.ts
export function buildOpenApi(): Record<string, unknown>;
// mock.ts
export function startMockRegistry(options?: { token?: string; subject?: string; org?: string })
  : Promise<{ url: string; token: string; stop(): Promise<void>; layers(): LayerSummary[] }>;
// conformance.ts
export function registryConformance(start: () => Promise<{ url: string; token: string; stop(): Promise<void> }>): void;
```

- [ ] **Step 1: Failing tests.**
  - `bundle.test.ts`:
    - `it("digest ignores file order")`: the same files in two orders give the same digest.
    - `it("digest changes with any byte")`.
    - `it("referencedPaths lists instruction files, local skill folders and hook scripts")`: a doc
      with `file: ./instructions/a.md`, skills `./skills/x` and `registry://…`, and hook
      `run: ./hooks/h.sh` gives `{ files: ["instructions/a.md", "hooks/h.sh"], dirs: ["skills/x"] }`.
      URLs are skipped.
  - `openapi.test.ts`: `it("openapi.json is current")`:
    `expect(JSON.stringify(buildOpenApi(), null, 2) + "\n").toMatchFileSnapshot("../openapi.json")`.
    Also `it("every route is in the document with bearer security")`.
  - `mock.test.ts`: `registryConformance(() => startMockRegistry())`.
- [ ] **Step 2: Write `conformance.ts`** (it is the test list). Each case starts a fresh server and
  uses raw `fetch`:
  - **Auth and reads:**
    - `401` `unauthorized` without a token and with a wrong one, on every route.
    - `whoami`.
    - `listLayers` empty, then after a publish.
    - `getVersion` by number and by `latest`.
    - `404` `not-found` for an unknown ref or version.
  - **Publish results:**
    - First publish of `org/base` (`baseVersion: 0`) is `201` `{ version: 1 }`.
    - Publishing the same bundle again is `200` `unchanged`.
    - A changed bundle with `baseVersion: 1` is version 2.
    - `baseVersion: 1` after version 2 is `409` `stale-base`.
  - **Bundle problems (`422`):**
    - `invalid`: bad YAML, and a schema failure.
    - `not-publishable`: `project/x` and `user/x`.
    - `missing-file`: a referenced file absent from `files`.
    - `path-escapes-layer`: a file path with `..`, and an absolute path.
    - `bundle-too-large`: over `MAX_BUNDLE_BYTES`.
  - **Resolution problems (`422`):**
    - `unpublished-ancestor`: `team/web` extends unpublished `org/base`.
    - `lock-violation`: `org/base` locks `permissions.deny`, and `team/web` changes it. The
      message names both layers.
  - **Descendants and dry runs:**
    - `breaks-descendants`: `team/web@1` changes `mcp.gateway`, then `org/base@2` adds the lock
      `mcp.gateway`. That is `422` naming `team/web`. With `force` it is `201`, `broken:
      ["team/web"]`.
    - `dryRun` stores nothing (`listLayers` unchanged) and returns `diff` and `broken`.
  - **Digest:** the stored `digest` equals `bundleDigest(source, files)`.
  - **Contract shape:** every response parses with its `ROUTES` schema, and every error with
    `Problem`.
- [ ] **Step 3: Run** `pnpm --filter @zzpersona/registry-api exec vitest run`. Expected: FAIL
  (modules missing).
- [ ] **Step 4: Implement.**
  - `schemas.ts`, `routes.ts`, `bundle.ts`:
    - The digest is sha256 over the canonical manifest:
      `JSON.stringify({ source, files: sorted by path })`.
    - `referencedPaths` normalises with `posix.normalize`, after stripping a leading `./`.
  - `openapi.ts`: OpenAPI `3.1.0`.
    - `components.schemas` comes from `z.toJSONSchema` of each schema.
    - `securitySchemes.bearer` is `{ type: "http", scheme: "bearer" }`.
    - The `{ref}` path parameter is described as URL-encoded.
  - `mock.ts`: `node:http` on `127.0.0.1:0`, with layers in memory. Publish runs spec §2 in order:
    1. Parse with `yaml` and validate with `PersonaDocument` from `@zzpersona/spec`.
    2. Resolve with `resolve()` from `@zzpersona/resolver` over an in-memory `PersonaSource` of
       the latest published layers, with the candidate in place.
    3. Find descendants: every published ref whose resolve listed this ref in `layers`. Each one
       that resolved before the change and throws after it is broken.
    4. The dry-run `diff` uses the resolver's `diff()` against the latest version's resolve.
       `diff` is `[]` for a new ref.
  - Generate `openapi.json` with `vitest run -u` once, then read it.
- [ ] **Step 5: Run** `pnpm turbo run build check-types lint test --filter=@zzpersona/registry-api`.
  Expected: PASS.
- [ ] **Step 6: Commit** `feat(registry-api): contract, mock registry and conformance kit`.

### Task 2: Foundations (`feature/registry-2-foundations`)

**Files:** Modify `src/packages/resolver/src/graph.ts` (`PersonaSource.dir?`),
`resolve.ts`, `merge.ts` (`apply(layer, doc, dir?)`; `local()` joins against it); test in
`resolve.test.ts`. Modify `src/packages/secrets/src/keychain.ts` (extract the read, add write and
delete), export from `index.ts`; tests in `keychain.test.ts`.

**Interfaces (produces):**
```ts
// resolver
export interface PersonaSource {
  load(ref: Ref): Promise<unknown>;
  /** The virtual folder this layer's relative paths resolve against; default posix.dirname(ref). */
  dir?(ref: Ref): string;
}
// secrets
export interface KeychainContext {
  platform: string;
  /** Runs a command, writing `input` to its stdin. Never throws for a missing command: 127. */
  run(command: string, args: string[], input?: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}
export function getKeychainItem(ctx: KeychainContext, service: string, account: string): Promise<string | undefined>;
export function setKeychainItem(ctx: KeychainContext, service: string, account: string, value: string): Promise<void>;
export function deleteKeychainItem(ctx: KeychainContext, service: string, account: string): Promise<boolean>; // false: was not there
export function keychainSupported(platform: string): boolean; // darwin, linux
```

- [ ] **Step 1: Failing tests.**
  - `resolve.test.ts`, `it("a source's dir() places a layer's relative paths")`: source `dir("org/a")
    = ".registry/org/a"`. The IR instruction `file` becomes `.registry/org/a/instructions/x.md`, and
    a hook run becomes `.registry/org/a/hooks/h.sh`. Without `dir`, the result is unchanged
    (`org/instructions/x.md`).
  - `keychain.test.ts`, with a fake `run` that records calls:
    - `it("macOS writes the secret through security -i stdin, never argv")`:
      - args are exactly `["-i"]`;
      - `input` is `add-generic-password -U -s "zzpersona-registry" -a "https://r.example" -w "tok"\n`;
      - the token is not in `args`.
    - `it("Linux writes through secret-tool store stdin")`: args are `["store", "--label=zzpersona
      registry", "service", s, "account", a]`, and `input` is the value.
    - `it("refuses a value with a quote, backslash or newline")`.
    - `it("delete reports a missing item as false")`: macOS exit 44, Linux a quiet exit 1.
    - `it("the existing secret:// resolve still works")`: it now goes through `getKeychainItem`.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/resolver --filter @zzpersona/secrets exec vitest
  run`. Expected: FAIL.
- [ ] **Step 3: Implement.** `resolve()` passes `source.dir?.(ref)` to `merge.apply`; the overlay
  keeps the default.
  - macOS: delete is `security delete-generic-password -s <service> -a <account>`.
  - Linux: delete is `secret-tool clear service <service> account <account>`.
  - Errors reuse the read path's 124 and 127 messages.
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(resolver,secrets): layer folders and keychain writes`.

### Task 3: `store-remote` (`feature/registry-3-store-remote`)

**Files:** Create `src/packages/store-remote/` with `src/url.ts`, `src/client.ts`, `src/cache.ts`,
`src/mount.ts`, `src/bundle.ts`, `src/index.ts`, and tests for each (`*.test.ts`, against
`startMockRegistry`). Deps: `@zzpersona/registry-api`, `@zzpersona/store-local`,
`@zzpersona/resolver`, `@zzpersona/spec`, `yaml`.

**Interfaces (produces):**
```ts
// url.ts
export function normaliseUrl(url: string): string;       // trailing slash added, lower-case host; throws RegistryError("insecure-url") for http to a non-loopback host
// client.ts
export class RegistryError extends Error { code: ProblemCode | "insecure-url" | "unreachable" | "timeout" | "registry-protocol"; problems?: Problem["problems"]; }
export interface RegistryClient {
  whoami(): Promise<Whoami>;
  listLayers(): Promise<LayerSummary[]>;
  getVersion(ref: string, version: number | "latest"): Promise<LayerVersion>;
  publish(ref: string, body: PublishRequest): Promise<PublishResult>;
}
export function createClient(options: { url: string; token: string; signal?: AbortSignal; timeoutMs?: number /* 10_000 */ }): RegistryClient;
// cache.ts
export interface CacheIndex { url: string; pulledAt: string; layers: Record<string, { version: number; digest: string }>; }
export interface PullChange { ref: string; from?: number; to?: number } // to undefined: removed
export function readIndex(home: string): Promise<CacheIndex | undefined>;
export function pull(home: string, client: RegistryClient, url: string, now?: () => Date): Promise<PullChange[]>;
export function cacheFolder(home: string, ref: string, version: number): string;
export function recordPublished(home: string, url: string, version: LayerVersion): Promise<void>; // after a publish
// mount.ts
export interface RegistryStore extends LocalStore {
  /** The published version a ref resolves to, when it comes from the cache. */
  published(ref: string): number | undefined;
}
export function withRegistry(local: LocalStore, home: string, index: CacheIndex,
  onShadow: (ref: string, version: number) => void): RegistryStore;
// bundle.ts
export function bundleLayer(local: LocalStore, ref: string): Promise<{ source: string; files: BundleFile[] }>;
```

- [ ] **Step 1: Failing tests.**
  - `url.test.ts`:
    - `it("URLs are normalised")`: `https://Reg.corp/zz` and `https://reg.corp/zz/` give the same
      value, and `routePath` joins under `/zz/`.
    - `it("http is refused except loopback")`.
  - `client.test.ts`, against the mock:
    - each method parses;
    - a `422` becomes `RegistryError` with `code` and `problems`;
    - a server that never answers gives `timeout` after `timeoutMs`;
    - a response with the wrong shape gives `registry-protocol` naming the route;
    - `it("the token never appears in an error message")`: the server returns 500 with the request
      headers in its body.
  - `cache.test.ts`:
    - `it("pull fetches only changed digests")`: count the mock's requests;
    - `it("pull removes refs the registry no longer lists")`;
    - `it("a changed URL clears the cache")`;
    - `it("an interrupted pull leaves the old cache")`: the second `getVersion` throws; the old
      index and folders are intact, and the next pull removes the `.tmp-*` folders;
    - `it("old versions are removed once the index moves past them")`.
  - `mount.test.ts`:
    - `it("a published layer wins over a local one and warns once")`: `onShadow` is called once
      per ref, and only when contents differ;
    - `it("two published layers bundling the same relative path keep their own files")`:
      `readText(".registry/org/a/instructions/c.md")` and `…/org/b/…` differ, and resolving
      through the store gives the IR `file` paths under `.registry/`;
    - `it("list includes published refs once")`;
    - `it("published() names the version")`.
  - `bundle.test.ts`:
    - `it("bundles the YAML and every referenced file, skill folders recursively")`;
    - `it("bundling refuses a symlink out of the layer")` → `RegistryError("path-escapes-layer")`;
    - `it("a missing referenced file is missing-file")`;
    - `it("over MAX_BUNDLE_BYTES is bundle-too-large")`;
    - `it("project/ and user/ refs are not-publishable")`.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/store-remote exec vitest run`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `client.ts`:
    - uses global `fetch` with `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])`;
    - validates with the `ROUTES` schemas;
    - parses errors with `Problem`;
    - builds messages only from `detail` and the problems, never from request data.
  - `pull`:
    1. Write each new version to `<cache>/.tmp-<random>/`.
    2. Rename it to `<ref>/<version>`.
    3. Write `index.json` with `writeFileAtomic`. Copy that helper's approach from the CLI's
       `fs.ts` (temp file plus rename); don't import it.
    4. Delete the folders the new index no longer names.
  - `withRegistry`:
    - `load(ref)` reads the cache when the ref is in the index, else the local store.
    - `locate(".registry/<ref>/<p>")` maps to the version folder, with that folder as the root.
    - `dir(ref)` is `.registry/<ref>` for published refs.
    - `strayLayerDirs` delegates to the local store.

  `bundleLayer` reads bytes with `node:fs`, checks each `realpath` against the layer folder's
  `realpath`, and walks skill folders recursively.
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(store-remote): registry client, cache and mount`.

### Task 4: CLI (`feature/registry-4-cli`)

**Files:**
- Create `src/apps/cli/src/registry.ts`, `src/apps/cli/src/commands/registry.ts` and
  `src/apps/cli/src/registry.test.ts`.
- Modify:
  - `config.ts`: add `registry: { url, maxAge? }`;
  - `context.ts`: wrap the store with `withRegistry` unless `local`, and print `onShadow`
    warnings to stderr;
  - `cli.ts`: register the commands, add `--local` to `resolve`, `compile` and `diff`, and add
    `CliIo.runInput?`;
  - `commands/claude.ts`, `codex.ts`, `switch.ts`: call `ensureFresh` before creating the context;
  - `commands/resolve.ts` and `switch.ts`: add `builtFrom` to `--json`;
  - `doctor/checks.ts`: add the registry checks.

**Interfaces:**
- Consumes: Task 2's keychain functions and Task 3's whole surface.
- Produces:
```ts
// registry.ts
export function readToken(io: CliIo, home: string, url: string): Promise<string | undefined>; // env, keychain, file
export function saveToken(io: CliIo, home: string, url: string, token: string): Promise<"keychain" | "file">;
export function deleteToken(io: CliIo, home: string, url: string): Promise<boolean>;
export function ensureFresh(io: CliIo, ctx: { home: string; config: Config }, options: { budgetMs: number }): Promise<void>;
export function builtFrom(store: LocalStore, layers: Ref[]): Record<string, number>;
// CliIo
runInput?: (command: string, args: string[], input?: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
```

- [ ] **Step 1: Failing tests** in `registry.test.ts`. These use a seeded temp home as in
  `switch.test.ts`, `startMockRegistry`, `ZZPERSONA_REGISTRY_TOKEN` or a fake `runInput`, and the
  `examples/personas` layers.
  - **Login and tokens:**
    - `it("login checks the token and saves the URL")`: `config.yaml` has `registry.url`, and the
      output is `logged in to <url> as <subject>`.
    - `it("a refused token saves nothing")`: exit 1, problem `unauthorized`.
    - `it("login trims a piped token")`.
    - `it("login stores the token in the keychain on darwin and linux, else a 0600 file")`.
    - `it("logout removes the token and keeps the cache")`.
    - `whoami`: prints `not logged in` when there's no token.
  - **Pull:**
    - `it("pull prints changes")`: `org/acme new @1`, then `up to date`, then `org/acme 1 → 2`, and
      `team/web removed` after the mock drops it.
    - The `--json` shape is `{ changes: PullChange[] }`.
  - **Publish:**
    - `it("publish then resolve uses the published layer")`: `resolve --json` has `builtFrom:
      { "org/acme": 1 }`, and with the local file changed it prints `org/acme: using published @1;
      local copy differs` once.
    - `--local` resolves the local file, with no warning.
    - `it("publish problems print with codes and hints")`: `stale-base` hints `zzpersona pull, then
      publish again`, and `breaks-descendants` hints `--force`.
    - `publish --dry-run` prints the diff and the cache is unchanged.
    - `publish project/persona` is `not-publishable`.
  - **Freshness:**
    - `it("freshness pulls a stale cache before claude")`: a non-dry `claude` run through the
      `runPlan` seam (dry runs never pull), with `io.now` advanced past `maxAge`.
    - `it("freshness costs at most 1 s against a hanging registry")`: elapsed under 1.5 s, with the
      `registry unreachable; using cached layers from …` line.
    - `it("freshness without a token")`.
    - `it("--json never pulls")`.
  - **The token never reaches output:** `it("the token never reaches output")` scans all stdout and
    stderr from the cases above for the token string.
  - **Doctor:** `it("doctor reports registry, token and cache age")`, with ids `registry`,
    `registry-token` and `registry-cache`.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/cli exec vitest run src/registry.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`login`:** reads the token from stdin (`--token-stdin`) or a prompt without echo on a TTY;
    without either it fails with `--token-stdin` as the hint. It normalises the URL, calls `whoami`,
    then saves the token and then the config.
  - **`ensureFresh`:**
    - It skips quietly when there's no `registry`.
    - It skips when the index is younger than `maxAge`.
    - With no token, it prints the one line from Review Focus 5.
    - Otherwise it runs `pull` with `AbortSignal.timeout(budgetMs)`. On any error it prints the
      unreachable line with the cache's age (`<n>m`, `<n>h`, `<n>d`).
    - `claude`, `codex` and `switch` call it with `budgetMs: 1000`, and not for `--dry-run` or
      `--json`.
  - **`builtFrom`:** the `layers` of the resolve that came from `store.published`.
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): login, pull and publish against a registry`.

### Task 5: Docs (`feature/registry-5-docs`)

**Files:**
- Modify:
  - `README.md`: a "## Registry" section on login, pull, publish, `--local` and the warnings;
  - `CLAUDE.md`: reading-list item 18, and the status paragraph saying Phase 3 has started;
  - `docs/planning/03-architecture.md`: dated notes under "Control plane" and the store row,
    pointing at spec 18;
  - `docs/planning/04-roadmap.md`: a dated amendment on Phase 3, built ahead of a design partner
    for one known org, with the A–H split in spec 18;
  - `docs/planning/02-persona-spec.md`: the dated answer to the "Version pinning" open question,
    which is that ancestors float to the latest published version;
  - `docs/planning/18-registry-contract.md`: amendments from Tasks 1–4 and the check run.
- Create `.changeset/registry.md`: minor for `@zzpersona/cli`, `@zzpersona/resolver` and
  `@zzpersona/secrets`, and new packages at their initial version.

- [ ] **Step 1: Check run (controller).** Start the mock from a scratch script (`node -e` importing
  `@zzpersona/registry-api/mock`, printing the URL and token) and use the built CLI with temp homes:
  1. `login`, then `publish org/acme` and `team/web` from `examples/personas`.
  2. In a second home: `login`, `pull`, then `zzpersona claude --dry-run` in `examples/demo-app`.
  3. Edit the first home's `team/web`: `publish --dry-run`, then `publish`.
  4. In the second home: `pull`.

  Record the output in spec 18's amendments.
- [ ] **Step 2: Docs.** Wrap prose at 100.
- [ ] **Step 3: Run** the full pipeline and `pnpm format:check`. Expected: PASS.
- [ ] **Step 4: Commit** `docs: registry contract and client`.
