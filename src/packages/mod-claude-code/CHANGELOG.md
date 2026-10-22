# @zzpersona/mod-claude-code

## 0.2.2

### Patch Changes

- ea9583b: Real-use hardening. `zzpersona --version` (and `-V`, `--json`) prints the CLI version.
  `zzpersona` run from a deleted folder says so instead of crashing. doctor's `personas` check
  accepts a personas folder inside a larger git repository. The daemon re-checks after backing off
  for a switch you made mid-refresh, and lets go of a dead session whose folder cannot be removed
  instead of recompiling every second. The CLI retries once when the daemon refuses its token (a
  restart in between) and reports a refused token as `daemon-unauthorized`, not "not running";
  `daemon stop` then stops it by pid and doctor warns. The mod skips its per-turn check on a Claude
  Code without the file system API instead of failing the hook.

## 0.2.1

### Patch Changes

- bf600f2: A refreshed persona's instructions now carry their own heading (`## zzpersona persona: <id>
  (updated <time>)`) and the superseding note names the launch section to disregard by its exact
  heading, wherever it appears, and says earlier answers may be outdated. Before, a refresh of the
  launched persona repeated the launch section's heading, so models could keep answering from the
  launch instructions. The band now says `relaunch for <permissions | MCP | settings>` when a
  refresh of the launched persona changed what only a relaunch applies.

## 0.2.0

### Minor Changes

- 02319f1: The mod applies the daemon's refreshes on the next turn: a `prompt.submit` hook reads the session's
  `live.json` and, when it changed, supersedes the instructions. The superseding section now also
  carries the launched persona's own instructions after they change or after switching back.

## 0.1.1

### Patch Changes

- dfe271d: Setup and polish from first real use. A root README with install steps (putting `zzpersona` on
  PATH with pnpm 12). `zzpersona doctor` gains a `cli` check (is `zzpersona` on PATH, as the mod needs)
  and names the `claude` binary it checked; `zzpersona mod install` warns when `zzpersona` is not on
  PATH. The nudge suggests `/persona use` in sessions that can switch live; `/persona switch X
  --default` says how to relaunch with X; doctor's `--fix` says what it removed; `init --personas`
  keeps the comments in `config.yaml`.

## 0.1.0

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
