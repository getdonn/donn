---
"@zzpersona/cli": minor
"@zzpersona/store-local": patch
"@zzpersona/executor": patch
---

Daily use. `zzpersona switch` chooses a persona per project or a default (`~/.zzpersona/state.json`),
with one selection rule for every command (argument → switch → project → default). `zzpersona init`
sets up a machine (`--personas`) or a project (`--extends`), flags only. `zzpersona doctor` checks
the whole setup and `--fix` removes orphaned switches and build leftovers. Hardening: signal exit
codes, `--json` usage errors, passthrough only for `claude`, an empty `ZZPERSONA_HOME` means unset,
`.yaml` and "did you mean" in persona arguments; the store lists only real (and symlinked) personas
and refuses instruction files that resolve outside their location.
