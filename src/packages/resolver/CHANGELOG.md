# @zzpersona/resolver

## 0.1.0

### Minor Changes

- Phase 0. `@zzpersona/spec`: zod schemas for `Persona`, `PersonaOverlay` and the resolved IR
  (`ResolvedPersona`, provenance, warnings, history, error codes), the path grammar shared by locks
  and provenance, and JSON Schema export. `@zzpersona/resolver`: `resolve()` (extends linearization,
  per-field merge, locks, user overlay) passing the 35-case fixture suite, and `explain()` for a
  reviewer-readable rendering.

### Patch Changes

- Updated dependencies
  - @zzpersona/spec@0.1.0
