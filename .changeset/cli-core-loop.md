---
"@zzpersona/store-local": minor
"@zzpersona/secrets": minor
"@zzpersona/executor": minor
"@zzpersona/cli": minor
---

The Phase 1 core loop. `@zzpersona/store-local` mounts a personas folder, the project's
`.zzpersona/` and `~/.zzpersona/` onto the resolver's single root by layer. `@zzpersona/secrets`
resolves `secret://` refs (env backend) all-or-nothing. `@zzpersona/executor` provides the real
probe, atomic builds with per-mount real-path containment, and `runPlan`. `@zzpersona/cli` adds
`zzpersona resolve`, `compile` and `claude`, each with `--json`.
