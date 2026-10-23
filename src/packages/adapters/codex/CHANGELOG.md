# @zzpersona/adapter-codex

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
