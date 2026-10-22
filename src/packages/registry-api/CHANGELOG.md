# @zzpersona/registry-api

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
