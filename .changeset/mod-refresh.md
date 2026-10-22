---
"@zzpersona/mod-claude-code": minor
---

The mod applies the daemon's refreshes on the next turn: a `prompt.submit` hook reads the session's
`live.json` and, when it changed, supersedes the instructions. The superseding section now also
carries the launched persona's own instructions after they change or after switching back.
