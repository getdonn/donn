# @zzpersona/adapter-sdk

## 0.3.0

### Minor Changes

- d221b8b: Optional `managed?: ManagedCompiler` on the adapter contract, with `ManagedInput`, `ManagedResult`,
  `ManagedManifest` and the report types. `FIXED_CAPABILITY_FIELDS` gained `policy`, so a third-party
  adapter's conformance-kit `complete-matrix` check fails until it declares a `policy` row.

### Patch Changes

- Updated dependencies [d221b8b]
  - @zzpersona/spec@0.2.0

## 0.2.0

### Minor Changes

- 07ec8c0: The `agents-md` adapter. `zzpersona write [--check | --remove]` renders the repo's project persona
  (without the user overlay, switches or default) into a marked block of `<repo>/AGENTS.md`, leaving
  everything outside the block byte for byte; `--check` fails in CI when the block is stale. The
  block carries instructions, knowledge pointers and tool rules as guidance, and the report lists
  what an `AGENTS.md` cannot carry. The SDK's overlay steps gain an optional `block`, the executor
  `applyOverlay`, and the conformance kit a `noBinary` option for file-format adapters.
- 9114c9e: The capability matrix. `zzpersona capabilities [--harness <id>] [--detect] [--markdown] [--json]`
  shows what each harness carries (native, approximated, advisory, none) and why, and
  `docs/capabilities.md` publishes it, kept current by a test (`pnpm docs:capabilities`).
  
  **Breaking for third-party adapters:** the conformance kit's new `complete-matrix` check requires
  a matrix to declare every field (`capabilityFields(id)`) and a `note` on every field that is not
  native. `requiredEntries` now returns each entry's `reason`, taken from the note; capability
  entries gain an optional `caveat`. agents-md now reports dropped secrets as secrets.

## 0.1.0

### Minor Changes

- 3ff16cd: `@zzpersona/adapter-sdk`: the harness adapter contract (pure `compile` and `activate`, which
  returns a plan of `launch`/`overlay` steps; `detect` through a probe), `defineAdapter`, compile
  reports with "no silent loss" derived from each adapter's capability matrix and lock annotation,
  `renderBuild`/`renderCapabilities`, and a framework-neutral conformance kit with a shared corpus
  (`./conformance`, plus a vitest wrapper at `./conformance/vitest`). `@zzpersona/adapter-claude-code`:
  the first adapter, compiling a resolved persona to a plugin, settings fragment, MCP config and
  system prompt for the relaunch path, with `partial` and `relaunch-no-mcp` modes under managed
  settings.

### Patch Changes

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
