# @zzpersona/adapter-agents-md

## 0.1.0

### Minor Changes

- 07ec8c0: The `agents-md` adapter. `zzpersona write [--check | --remove]` renders the repo's project persona
  (without the user overlay, switches or default) into a marked block of `<repo>/AGENTS.md`, leaving
  everything outside the block byte for byte; `--check` fails in CI when the block is stale. The
  block carries instructions, knowledge pointers and tool rules as guidance, and the report lists
  what an `AGENTS.md` cannot carry. The SDK's overlay steps gain an optional `block`, the executor
  `applyOverlay`, and the conformance kit a `noBinary` option for file-format adapters.

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
