# @getdonn/resolver

## 0.5.0

### Minor Changes

- 035af67: Renamed from zzpersona to donn. Run `donn migrate` once on a machine that ran zzpersona.

### Patch Changes

- Updated dependencies [035af67]
  - @getdonn/spec@0.3.0

## 0.4.0

### Minor Changes

- d221b8b: Resolves the `policy` block (only org, area and team layers may set it; an equal re-set is a no-op)
  and records the layer that set each `policy` and `targets.<harness>.managed` key in `provenance`.

### Patch Changes

- Updated dependencies [d221b8b]
  - @zzpersona/spec@0.2.0

## 0.3.0

### Minor Changes

- 9ca114a: A registry for shared layers. `zzpersona login|logout|whoami|pull|publish` publish `org/*`,
  `area/*` and `team/*` layers as bundles and pull them into a read-only cache that resolves offline;
  a published layer wins over a same-name local file with a warning, and `--local` leaves the cache
  out. New `@zzpersona/registry-api` (the contract, a mock server and a conformance kit) and
  `@zzpersona/store-remote` (the client). The resolver's `PersonaSource` gains `dir`; the keychain
  provider can write and delete, and macOS exit 44 now means a missing secret.

## 0.2.0

### Minor Changes

- 9d21335: Reach. Third-party adapters and secret providers load from `adapters:` and `secretProviders:` in
  `config.yaml` (packages from `~/.zzpersona/adapters`, or paths), only when a command needs one;
  `compile --harness <id>` works with any loaded adapter and `doctor` checks every listed plugin.
  `@zzpersona/secrets` gains `SecretContext`, `defineSecretProvider` and a built-in `keychain`
  provider (macOS `security`, Linux `secret-tool`), with `doctor` printing the command that stores a
  missing item. `zzpersona diff [a] <b>` shows what changes between two personas, with provenance.
  Hardening: class-based adapters keep their methods, an SDK-owned `Platform` type, conformance
  reports a missing `chdir`, `strictMcp` must be a boolean, later managed-settings drop-ins win, no
  empty objects in settings.json, concurrent switches no longer lose entries, `switch` and `init`
  edge cases, error envelopes always carry a message, and project files may link elsewhere in their
  repo.

## 0.1.0

### Minor Changes

- Phase 0. `@zzpersona/spec`: zod schemas for `Persona`, `PersonaOverlay` and the resolved IR
  (`ResolvedPersona`, provenance, warnings, history, error codes), the path grammar shared by locks
  and provenance, and JSON Schema export. `@zzpersona/resolver`: `resolve()` (extends linearization,
  per-field merge, locks, user overlay) passing the 35-case fixture suite, and `explain()` for a
  reviewer-readable rendering.

### Patch Changes

- Updated dependencies
  - @zzpersona/spec@0.1.0
