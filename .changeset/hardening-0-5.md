---
"@zzpersona/cli": patch
"@zzpersona/mod-claude-code": patch
---

Real-use hardening. `zzpersona --version` (and `-V`, `--json`) prints the CLI version.
`zzpersona` run from a deleted folder says so instead of crashing. doctor's `personas` check
accepts a personas folder inside a larger git repository. The daemon re-checks after backing off
for a switch you made mid-refresh, and lets go of a dead session whose folder cannot be removed
instead of recompiling every second. The CLI retries once when the daemon refuses its token (a
restart in between) and reports a refused token as `daemon-unauthorized`, not "not running";
`daemon stop` then stops it by pid and doctor warns. The mod skips its per-turn check on a Claude
Code without the file system API instead of failing the hook.
