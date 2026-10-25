# @getdonn/spec

## 0.5.0

### Minor Changes

- c4fd06d: Add `agents.define.<name>.world` (`local` or `postgres`) for self-host agents. Any other target is an `invalid-persona` error; the resolved agent carries `world` only when set.

## 0.4.0

### Minor Changes

- 4e51f5d: Personas can declare `models` (gateway routing, lockable) and `agents`; every harness adapter reports `models` (not yet supported). See docs/planning/23-models-and-agents.md.
  
  A layer that uses a path agent template now publishes that template folder with it (missing or escaping folders are refused). Header names in `models.gateway.headers` and in MCP url-server `headers` must be valid HTTP header names.

## 0.3.1

### Patch Changes

- 14c7f82: First npm release.

## 0.3.0

### Minor Changes

- 035af67: Renamed from zzpersona to donn. Run `donn migrate` once on a machine that ran zzpersona.

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
