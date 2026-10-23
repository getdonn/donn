# @zzpersona/spec

## 0.2.0

### Minor Changes

- d221b8b: `policy` block (`mcp`, `permissions`, `hooks`, `bypassPermissions`) and `targets.claude-code.managed`
  passthrough for enforcing locks machine-wide through Claude Code's managed settings
  (docs/planning/21-managed-settings.md).

## 0.1.0

### Minor Changes

- Phase 0. `@zzpersona/spec`: zod schemas for `Persona`, `PersonaOverlay` and the resolved IR
  (`ResolvedPersona`, provenance, warnings, history, error codes), the path grammar shared by locks
  and provenance, and JSON Schema export. `@zzpersona/resolver`: `resolve()` (extends linearization,
  per-field merge, locks, user overlay) passing the 35-case fixture suite, and `explain()` for a
  reviewer-readable rendering.
