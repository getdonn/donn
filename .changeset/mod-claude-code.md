---
"@zzpersona/cli": minor
"@zzpersona/mod-claude-code": minor
"@zzpersona/adapter-claude-code": patch
---

The Claude Code mod. `@zzpersona/mod-claude-code` shows the active persona above the prompt, nudges
when the current folder selects a different one (or when a plain `claude` session runs in a folder
that has one), and adds `/persona [list | switch <persona> [--default] | clear [--default]]`. It
calls the CLI for every answer and says "zzpersona unavailable" with the reason when it cannot.
`zzpersona mod install|uninstall` registers it with Claude Code through a local folder
marketplace, and `doctor` checks it is installed and current. `zzpersona list` lists every persona,
`zzpersona claude` tells the session which persona it runs (`ZZPERSONA_PERSONA`,
`ZZPERSONA_SOURCE`, `ZZPERSONA_PROJECT`), and persona plugin names map `/` to `--` so nested and
hyphenated refs never collide.
