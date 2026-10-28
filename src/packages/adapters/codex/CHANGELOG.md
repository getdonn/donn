# @getdonn/adapter-codex

## 0.4.2

### Patch Changes

- Updated dependencies [28bcda1]
  - @getdonn/adapter-sdk@0.7.0

## 0.4.1

### Patch Changes

- Updated dependencies [c4fd06d]
- Updated dependencies [c4fd06d]
  - @getdonn/adapter-sdk@0.6.0
  - @getdonn/spec@0.5.0

## 0.4.0

### Minor Changes

- 4e51f5d: Personas can declare `models` (gateway routing, lockable) and `agents`; every harness adapter reports `models` (not yet supported). See docs/planning/23-models-and-agents.md.
  
  A layer that uses a path agent template now publishes that template folder with it (missing or escaping folders are refused). Header names in `models.gateway.headers` and in MCP url-server `headers` must be valid HTTP header names.

### Patch Changes

- Updated dependencies [0a8ed7a]
- Updated dependencies [4e51f5d]
  - @getdonn/adapter-sdk@0.5.0
  - @getdonn/spec@0.4.0

## 0.3.1

### Patch Changes

- 14c7f82: First npm release.
- Updated dependencies [14c7f82]
  - @getdonn/spec@0.3.1
  - @getdonn/adapter-sdk@0.4.1

## 0.3.0

### Minor Changes

- 035af67: Renamed from zzpersona to donn. Run `donn migrate` once on a machine that ran zzpersona.

### Patch Changes

- Updated dependencies [035af67]
  - @getdonn/adapter-sdk@0.4.0
  - @getdonn/spec@0.3.0

## 0.2.0

### Minor Changes

- d221b8b: Declares the `policy` capability row as `none`: not rendered; enforced only by managed bundles for
  Claude Code.

### Patch Changes

- Updated dependencies [d221b8b]
- Updated dependencies [d221b8b]
  - @zzpersona/adapter-sdk@0.3.0
  - @zzpersona/spec@0.2.0

## 0.1.0

### Minor Changes

- 1cb2c84: The Codex adapter. `zzpersona codex [persona] [-- <codex args>]` launches Codex CLI with the
  persona's instructions (`developer_instructions`), MCP servers (secrets resolved into the launch
  environment and forwarded by name), MCP tool approvals and `-s workspace-write -a on-request`
  defaults, all as `-c` overrides; nothing is written to `~/.codex`. `targets.codex` sets the
  sandbox, approval and model. Skills and hooks are reported dropped. `compile --harness codex`
  dry-runs the build, and `doctor` gains an optional `codex` check.

### Patch Changes

- 9114c9e: The capability matrix. `zzpersona capabilities [--harness <id>] [--detect] [--markdown] [--json]`
  shows what each harness carries (native, approximated, advisory, none) and why, and
  `docs/capabilities.md` publishes it, kept current by a test (`pnpm docs:capabilities`).
  
  **Breaking for third-party adapters:** the conformance kit's new `complete-matrix` check requires
  a matrix to declare every field (`capabilityFields(id)`) and a `note` on every field that is not
  native. `requiredEntries` now returns each entry's `reason`, taken from the note; capability
  entries gain an optional `caveat`. agents-md now reports dropped secrets as secrets.
- Updated dependencies [07ec8c0]
- Updated dependencies [9114c9e]
  - @zzpersona/adapter-sdk@0.2.0
