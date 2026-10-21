# @zzpersona/executor

## 0.1.0

### Minor Changes

- 9c617cc: The Phase 1 core loop. `@zzpersona/store-local` mounts a personas folder, the project's
  `.zzpersona/` and `~/.zzpersona/` onto the resolver's single root by layer. `@zzpersona/secrets`
  resolves `secret://` refs (env backend) all-or-nothing. `@zzpersona/executor` provides the real
  probe, atomic builds with per-mount real-path containment, and `runPlan`. `@zzpersona/cli` adds
  `zzpersona resolve`, `compile` and `claude`, each with `--json`.

### Patch Changes

- 40b2ace: Daily use. `zzpersona switch` chooses a persona per project or a default (`~/.zzpersona/state.json`),
  with one selection rule for every command (argument → switch → project → default). `zzpersona init`
  sets up a machine (`--personas`) or a project (`--extends`), flags only. `zzpersona doctor` checks
  the whole setup and `--fix` removes orphaned switches and build leftovers. Hardening: signal exit
  codes, `--json` usage errors, passthrough only for `claude`, an empty `ZZPERSONA_HOME` means unset,
  `.yaml` and "did you mean" in persona arguments; the store lists only real (and symlinked) personas
  and refuses instruction files that resolve outside their location.
- Updated dependencies [3ff16cd]
- Updated dependencies [9c617cc]
- Updated dependencies [40b2ace]
- Updated dependencies [9d21335]
  - @zzpersona/adapter-sdk@0.1.0
  - @zzpersona/store-local@0.1.0
