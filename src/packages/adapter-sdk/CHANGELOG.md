# @zzpersona/adapter-sdk

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
