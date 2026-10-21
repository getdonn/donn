---
"@zzpersona/cli": patch
"@zzpersona/mod-claude-code": patch
---

Setup and polish from first real use. A root README with install steps (putting `zzpersona` on
PATH with pnpm 12). `zzpersona doctor` gains a `cli` check (is `zzpersona` on PATH, as the mod needs)
and names the `claude` binary it checked; `zzpersona mod install` warns when `zzpersona` is not on
PATH. The nudge suggests `/persona use` in sessions that can switch live; `/persona switch X
--default` says how to relaunch with X; doctor's `--fix` says what it removed; `init --personas`
keeps the comments in `config.yaml`.
