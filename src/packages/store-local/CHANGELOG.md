# @getdonn/store-local

## 0.2.3

### Patch Changes

- Updated dependencies [c4fd06d]
  - @getdonn/spec@0.5.0
  - @getdonn/resolver@0.7.0

## 0.2.2

### Patch Changes

- Updated dependencies [4e51f5d]
  - @getdonn/spec@0.4.0
  - @getdonn/resolver@0.6.0

## 0.2.1

### Patch Changes

- 14c7f82: First npm release.
- Updated dependencies [14c7f82]
  - @getdonn/spec@0.3.1
  - @getdonn/resolver@0.5.1

## 0.2.0

### Minor Changes

- 035af67: Renamed from zzpersona to donn. Run `donn migrate` once on a machine that ran zzpersona.

### Patch Changes

- Updated dependencies [035af67]
  - @getdonn/resolver@0.5.0
  - @getdonn/spec@0.3.0

## 0.1.2

### Patch Changes

- Updated dependencies [d221b8b]
- Updated dependencies [d221b8b]
  - @zzpersona/resolver@0.4.0
  - @zzpersona/spec@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [9ca114a]
  - @zzpersona/resolver@0.3.0

## 0.1.0

### Minor Changes

- 9c617cc: The Phase 1 core loop. `@zzpersona/store-local` mounts a personas folder, the project's
  `.zzpersona/` and `~/.zzpersona/` onto the resolver's single root by layer. `@zzpersona/secrets`
  resolves `secret://` refs (env backend) all-or-nothing. `@zzpersona/executor` provides the real
  probe, atomic builds with per-mount real-path containment, and `runPlan`. `@zzpersona/cli` adds
  `zzpersona resolve`, `compile` and `claude`, each with `--json`.

### Patch Changes

- 40b2ace: Daily use. `zzpersona switch` chooses a persona per project or a default (`~/.zzpersona/state.json`),
  with one selection rule for every command (argument → switch → project → default). `zzpersona init`
  sets up a machine (`--personas`) or a project (`--extends`), flags only. `zzpersona doctor` checks
  the whole setup and `--fix` removes orphaned switches and build leftovers. Hardening: signal exit
  codes, `--json` usage errors, passthrough only for `claude`, an empty `ZZPERSONA_HOME` means unset,
  `.yaml` and "did you mean" in persona arguments; the store lists only real (and symlinked) personas
  and refuses instruction files that resolve outside their location.
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
- Updated dependencies [9d21335]
  - @zzpersona/resolver@0.2.0
