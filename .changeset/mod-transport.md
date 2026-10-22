---
"@zzpersona/cli": minor
"@zzpersona/mod-claude-code": minor
---

The Claude Code mod's `/persona` goes through the daemon when it runs. The daemon serves the mod's
commands (`POST /run`), so `/persona` is faster and works where policy stops the mod from running
programs; without the daemon the mod runs `zzpersona` as before. The mod's replies no longer
repeat the `zzpersona:` prefix Claude Code already shows.
