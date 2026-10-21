---
"@zzpersona/cli": minor
"@zzpersona/adapter-sdk": minor
"@zzpersona/executor": minor
"@zzpersona/adapter-agents-md": minor
---

The `agents-md` adapter. `zzpersona write [--check | --remove]` renders the repo's project persona
(without the user overlay, switches or default) into a marked block of `<repo>/AGENTS.md`, leaving
everything outside the block byte for byte; `--check` fails in CI when the block is stale. The
block carries instructions, knowledge pointers and tool rules as guidance, and the report lists
what an `AGENTS.md` cannot carry. The SDK's overlay steps gain an optional `block`, the executor
`applyOverlay`, and the conformance kit a `noBinary` option for file-format adapters.
