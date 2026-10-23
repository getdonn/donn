---
"@zzpersona/adapter-sdk": minor
---

Optional `managed?: ManagedCompiler` on the adapter contract, with `ManagedInput`, `ManagedResult`,
`ManagedManifest` and the report types. `FIXED_CAPABILITY_FIELDS` gained `policy`, so a third-party
adapter's conformance-kit `complete-matrix` check fails until it declares a `policy` row.
