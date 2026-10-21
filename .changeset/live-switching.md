---
"@zzpersona/cli": minor
"@zzpersona/mod-claude-code": minor
"@zzpersona/adapter-claude-code": patch
"@zzpersona/executor": patch
---

Live in-session switching for Claude Code. `zzpersona claude` launches with a per-session folder of
plugins (removed on exit; `doctor --fix` cleans up orphans) and `zzpersona live <persona> --session
<dir>` swaps the persona plugin inside it, so skills, hooks and agents change mid-session; it
reports which MCP servers and permissions stay as launched and whether the new persona denies
more. The mod adds `/persona use <persona>` (this session only), `/persona switch` now also applies
live, and the new persona's instructions supersede the launch instructions through the system
prompt, surviving compaction. `system-prompt.md` now starts with `## zzpersona persona: <ref>`.
