# @zzpersona/store-remote

## 0.4.0

### Minor Changes

- d221b8b: `RegistryClient.managedBundle({ layer, os })` downloads a managed policy bundle: the manifest and the
  files as bytes, and `rawManifest`, the manifest as sent (before tolerant parsing drops fields this
  client does not know). File paths are the registry's word; callers check them before writing.

### Patch Changes

- Updated dependencies [d221b8b]
- Updated dependencies [d221b8b]
- Updated dependencies [d221b8b]
  - @zzpersona/registry-api@0.5.0
  - @zzpersona/resolver@0.4.0
  - @zzpersona/spec@0.2.0
  - @zzpersona/store-local@0.1.2

## 0.3.0

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

### Patch Changes

- Updated dependencies [202b37e]
  - @zzpersona/registry-api@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [eed515f]
  - @zzpersona/registry-api@0.3.0

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
  - @zzpersona/registry-api@0.2.0
  - @zzpersona/store-local@0.1.1
