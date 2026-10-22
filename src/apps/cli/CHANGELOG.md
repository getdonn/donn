# @zzpersona/cli

## 0.5.0

### Minor Changes

- e6b91b9: The Claude Code mod's `/persona` goes through the daemon when it runs. The daemon serves the mod's
  commands (`POST /run`), so `/persona` is faster and works where policy stops the mod from running
  programs; without the daemon the mod runs `zzpersona` as before. The mod's replies no longer
  repeat the `zzpersona:` prefix Claude Code already shows.

### Patch Changes

- Updated dependencies [e6b91b9]
  - @zzpersona/mod-claude-code@0.3.0

## 0.4.3

### Patch Changes

- Updated dependencies
  - @zzpersona/mod-claude-code@0.2.3

## 0.4.2

### Patch Changes

- ea9583b: Real-use hardening. `zzpersona --version` (and `-V`, `--json`) prints the CLI version.
  `zzpersona` run from a deleted folder says so instead of crashing. doctor's `personas` check
  accepts a personas folder inside a larger git repository. The daemon re-checks after backing off
  for a switch you made mid-refresh, and lets go of a dead session whose folder cannot be removed
  instead of recompiling every second. The CLI retries once when the daemon refuses its token (a
  restart in between) and reports a refused token as `daemon-unauthorized`, not "not running";
  `daemon stop` then stops it by pid and doctor warns. The mod skips its per-turn check on a Claude
  Code without the file system API instead of failing the hook.
- Updated dependencies [ea9583b]
  - @zzpersona/mod-claude-code@0.2.2

## 0.4.1

### Patch Changes

- Updated dependencies [bf600f2]
  - @zzpersona/mod-claude-code@0.2.1

## 0.4.0

### Minor Changes

- 2ff9978: The daemon, first slice. `zzpersona daemon start|stop|status|refresh` runs a background process per
  home with a socket API and a session registry; it watches persona sources and refreshes live Claude
  Code sessions on their next turn when a persona is edited (Codex sessions show as stale).
  `zzpersona status` lists the sessions the daemon knows of, and `doctor` gains a `daemon` check that
  tells an unresponsive daemon from a stale one.

### Patch Changes

- Updated dependencies [02319f1]
  - @zzpersona/mod-claude-code@0.2.0

## 0.3.0

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
- 1cb2c84: The Codex adapter. `zzpersona codex [persona] [-- <codex args>]` launches Codex CLI with the
  persona's instructions (`developer_instructions`), MCP servers (secrets resolved into the launch
  environment and forwarded by name), MCP tool approvals and `-s workspace-write -a on-request`
  defaults, all as `-c` overrides; nothing is written to `~/.codex`. `targets.codex` sets the
  sandbox, approval and model. Skills and hooks are reported dropped. `compile --harness codex`
  dry-runs the build, and `doctor` gains an optional `codex` check.

### Patch Changes

- Updated dependencies [07ec8c0]
- Updated dependencies [9114c9e]
- Updated dependencies [1cb2c84]
  - @zzpersona/adapter-sdk@0.2.0
  - @zzpersona/executor@0.2.0
  - @zzpersona/adapter-agents-md@0.1.0
  - @zzpersona/adapter-claude-code@0.1.2
  - @zzpersona/adapter-codex@0.1.0

## 0.2.1

### Patch Changes

- dfe271d: Setup and polish from first real use. A root README with install steps (putting `zzpersona` on
  PATH with pnpm 12). `zzpersona doctor` gains a `cli` check (is `zzpersona` on PATH, as the mod needs)
  and names the `claude` binary it checked; `zzpersona mod install` warns when `zzpersona` is not on
  PATH. The nudge suggests `/persona use` in sessions that can switch live; `/persona switch X
  --default` says how to relaunch with X; doctor's `--fix` says what it removed; `init --personas`
  keeps the comments in `config.yaml`.
- Updated dependencies [dfe271d]
  - @zzpersona/mod-claude-code@0.1.1

## 0.2.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [621e1d8]
- Updated dependencies [05b004e]
  - @zzpersona/mod-claude-code@0.1.0
  - @zzpersona/adapter-claude-code@0.1.1
  - @zzpersona/executor@0.1.1

## 0.1.0

### Minor Changes

- 9c617cc: The Phase 1 core loop. `@zzpersona/store-local` mounts a personas folder, the project's
  `.zzpersona/` and `~/.zzpersona/` onto the resolver's single root by layer. `@zzpersona/secrets`
  resolves `secret://` refs (env backend) all-or-nothing. `@zzpersona/executor` provides the real
  probe, atomic builds with per-mount real-path containment, and `runPlan`. `@zzpersona/cli` adds
  `zzpersona resolve`, `compile` and `claude`, each with `--json`.
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

### Patch Changes

- Updated dependencies [3ff16cd]
- Updated dependencies [9c617cc]
- Updated dependencies [40b2ace]
- Updated dependencies [9d21335]
  - @zzpersona/adapter-sdk@0.1.0
  - @zzpersona/adapter-claude-code@0.1.0
  - @zzpersona/store-local@0.1.0
  - @zzpersona/secrets@0.1.0
  - @zzpersona/executor@0.1.0
  - @zzpersona/resolver@0.2.0
