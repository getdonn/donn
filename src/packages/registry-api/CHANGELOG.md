# @getdonn/registry-api

## 0.7.2

### Patch Changes

- Updated dependencies [28bcda1]
  - @getdonn/adapter-sdk@0.7.0

## 0.7.1

### Patch Changes

- Updated dependencies [c4fd06d]
- Updated dependencies [c4fd06d]
  - @getdonn/adapter-sdk@0.6.0
  - @getdonn/spec@0.5.0
  - @getdonn/resolver@0.7.0

## 0.7.0

### Minor Changes

- 4e51f5d: Personas can declare `models` (gateway routing, lockable) and `agents`; every harness adapter reports `models` (not yet supported). See docs/planning/23-models-and-agents.md.
  
  A layer that uses a path agent template now publishes that template folder with it (missing or escaping folders are refused). Header names in `models.gateway.headers` and in MCP url-server `headers` must be valid HTTP header names.

### Patch Changes

- Updated dependencies [0a8ed7a]
- Updated dependencies [4e51f5d]
  - @getdonn/adapter-sdk@0.5.0
  - @getdonn/spec@0.4.0
  - @getdonn/resolver@0.6.0

## 0.6.1

### Patch Changes

- 14c7f82: First npm release.
- Updated dependencies [14c7f82]
  - @getdonn/spec@0.3.1
  - @getdonn/resolver@0.5.1
  - @getdonn/adapter-sdk@0.4.1

## 0.6.0

### Minor Changes

- 035af67: Renamed from zzpersona to donn. Run `donn migrate` once on a machine that ran zzpersona.

### Patch Changes

- Updated dependencies [035af67]
  - @getdonn/adapter-sdk@0.4.0
  - @getdonn/resolver@0.5.0
  - @getdonn/spec@0.3.0

## 0.5.0

### Minor Changes

- d221b8b: `GET /v1/managed/bundle` (`ROUTES.managedBundle`, `ManagedBundleResponse`): the managed policy
  bundle for a layer and OS. New problem codes `invalid-request`, `managed-refused`,
  `managed-needs-files` and `format-unsupported`. The mock takes `managed?: ManagedCompiler` and
  answers `format=bundle` (501 `format-unsupported` for other formats or without a compiler); the
  conformance kit checks that the bundle matches a local compile when given the same compiler.
  `compileFromSource` and `publishedSource` are exported for servers.

### Patch Changes

- Updated dependencies [d221b8b]
- Updated dependencies [d221b8b]
- Updated dependencies [d221b8b]
  - @zzpersona/adapter-sdk@0.3.0
  - @zzpersona/resolver@0.4.0
  - @zzpersona/spec@0.2.0

## 0.4.0

### Minor Changes

- 202b37e: Registry identity (spec 20). `zzpersona login <url>` signs in through the browser (`--no-browser`
  prints the link only; `--token` is the old hidden prompt, `--token-stdin` is unchanged). The
  registry contract gains the sign-in routes, roles in `whoami`, and the `forbidden` problem with a
  grant hint on `publish`; clients read answers tolerantly. The conformance kit gains optional hooks
  (`start(options?)`, `supportsLoginTiming`, `limitedToken`, `completeLogin`, `refuseLogin`,
  `signIn`) and skips the cases a registry cannot run; `signIn` gates only the `404 not-found` case:
  `signIn: false` declares a registry without sign-in and runs it; unset or `true` skips it. The kit's problem
  items are strict. `doctor` shows the session end date.
  
  A registry with sign-in needs `@zzpersona/cli` 0.9.0 or later (product release 0.11.0): older
  CLIs reject the new fields.

## 0.3.0

### Minor Changes

- eed515f: The publish rules are a storage-independent engine, `publishLayer` over a `LayerStore`, shared by
  the mock and the control plane. The conformance kit is stricter: canonical base64, malformed refs,
  routes, bodies and `%` sequences, two concurrent publishes from one base, and `lock-violation`
  checked by its fields.

## 0.2.0

### Minor Changes

- 9ca114a: A registry for shared layers. `zzpersona login|logout|whoami|pull|publish` publish `org/*`,
  `area/*` and `team/*` layers as bundles and pull them into a read-only cache that resolves offline;
  a published layer wins over a same-name local file with a warning, and `--local` leaves the cache
  out. New `@zzpersona/registry-api` (the contract, a mock server and a conformance kit) and
  `@zzpersona/store-remote` (the client). The resolver's `PersonaSource` gains `dir`; the keychain
  provider can write and delete, and macOS exit 44 now means a missing secret.

### Patch Changes

- Updated dependencies [9ca114a]
  - @zzpersona/resolver@0.3.0
