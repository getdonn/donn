# @getdonn/adapter-claude-code

## 0.4.1

### Patch Changes

- Updated dependencies [c4fd06d]
- Updated dependencies [c4fd06d]
  - @getdonn/adapter-sdk@0.6.0
  - @getdonn/spec@0.5.0

## 0.4.0

### Minor Changes

- 4e51f5d: Personas can declare `models` (gateway routing, lockable) and `agents`; every harness adapter reports `models` (not yet supported). See docs/planning/23-models-and-agents.md.
  
  A layer that uses a path agent template now publishes that template folder with it (missing or escaping folders are refused). Header names in `models.gateway.headers` and in MCP url-server `headers` must be valid HTTP header names.

### Patch Changes

- Updated dependencies [0a8ed7a]
- Updated dependencies [4e51f5d]
  - @getdonn/adapter-sdk@0.5.0
  - @getdonn/spec@0.4.0

## 0.3.1

### Patch Changes

- 14c7f82: First npm release.
- Updated dependencies [14c7f82]
  - @getdonn/spec@0.3.1
  - @getdonn/adapter-sdk@0.4.1

## 0.3.0

### Minor Changes

- 035af67: Renamed from zzpersona to donn. Run `donn migrate` once on a machine that ran zzpersona.

### Patch Changes

- Updated dependencies [035af67]
  - @getdonn/adapter-sdk@0.4.0
  - @getdonn/spec@0.3.0

## 0.2.0

### Minor Changes

- d221b8b: `managed`: compiles the locks of an org, area or team chain to a Claude Code managed policy bundle
  (`managed-settings.d/50-zzpersona.json`, `managed-mcp.json`, locked hook scripts, a manifest with
  `minClaudeCode`), with a report that refuses secrets, unsafe servers, unknown keys and passthrough
  keys that would replace compiled values or widen a higher layer's locks
  (`managed-passthrough-conflict`). Declares the `policy` capability row: native for Claude Code
  through the managed bundle.
  
  **Breaking for third-party adapters:** `FIXED_CAPABILITY_FIELDS` gained `policy`.

### Patch Changes

- Updated dependencies [d221b8b]
- Updated dependencies [d221b8b]
  - @zzpersona/adapter-sdk@0.3.0
  - @zzpersona/spec@0.2.0

## 0.1.2

### Patch Changes

- 9114c9e: The capability matrix. `zzpersona capabilities [--harness <id>] [--detect] [--markdown] [--json]`
  shows what each harness carries (native, approximated, advisory, none) and why, and
  `docs/capabilities.md` publishes it, kept current by a test (`pnpm docs:capabilities`).
  
  **Breaking for third-party adapters:** the conformance kit's new `complete-matrix` check requires
  a matrix to declare every field (`capabilityFields(id)`) and a `note` on every field that is not
  native. `requiredEntries` now returns each entry's `reason`, taken from the note; capability
  entries gain an optional `caveat`. agents-md now reports dropped secrets as secrets.
- Updated dependencies [07ec8c0]
- Updated dependencies [9114c9e]
  - @zzpersona/adapter-sdk@0.2.0

## 0.1.1

### Patch Changes

- 621e1d8: Live in-session switching for Claude Code. `zzpersona claude` launches with a per-session folder of
  plugins (removed on exit; `doctor --fix` cleans up orphans) and `zzpersona live <persona> --session
  <dir>` swaps the persona plugin inside it, so skills, hooks and agents change mid-session; it
  reports which MCP servers and permissions stay as launched and whether the new persona denies
  more. The mod adds `/persona use <persona>` (this session only), `/persona switch` now also applies
  live, and the new persona's instructions supersede the launch instructions through the system
  prompt, surviving compaction. `system-prompt.md` now starts with `## zzpersona persona: <ref>`.
- 05b004e: The Claude Code mod. `@zzpersona/mod-claude-code` shows the active persona above the prompt, nudges
  when the current folder selects a different one (or when a plain `claude` session runs in a folder
  that has one), and adds `/persona [list | switch <persona> [--default] | clear [--default]]`. It
  calls the CLI for every answer and says "zzpersona unavailable" with the reason when it cannot.
  `zzpersona mod install|uninstall` registers it with Claude Code through a local folder
  marketplace, and `doctor` checks it is installed and current. `zzpersona list` lists every persona,
  `zzpersona claude` tells the session which persona it runs (`ZZPERSONA_PERSONA`,
  `ZZPERSONA_SOURCE`, `ZZPERSONA_PROJECT`), and persona plugin names map `/` to `--` so nested and
  hyphenated refs never collide.

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
- Updated dependencies [3ff16cd]
- Updated dependencies [9d21335]
  - @zzpersona/adapter-sdk@0.1.0
