# @zzpersona/mod-claude-code

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
