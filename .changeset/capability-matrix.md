---
"@zzpersona/adapter-sdk": minor
"@zzpersona/cli": minor
"@zzpersona/adapter-claude-code": patch
"@zzpersona/adapter-agents-md": patch
"@zzpersona/adapter-codex": patch
---

The capability matrix. `zzpersona capabilities [--harness <id>] [--detect] [--markdown] [--json]`
shows what each harness carries (native, approximated, advisory, none) and why, and
`docs/capabilities.md` publishes it, kept current by a test (`pnpm docs:capabilities`).

**Breaking for third-party adapters:** the conformance kit's new `complete-matrix` check requires
a matrix to declare every field (`capabilityFields(id)`) and a `note` on every field that is not
native. `requiredEntries` now returns each entry's `reason`, taken from the note; capability
entries gain an optional `caveat`. agents-md now reports dropped secrets as secrets.
