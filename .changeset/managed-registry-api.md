---
"@zzpersona/registry-api": minor
---

`GET /v1/managed/bundle` (`ROUTES.managedBundle`, `ManagedBundleResponse`): the managed policy
bundle for a layer and OS. New problem codes `invalid-request`, `managed-refused`,
`managed-needs-files` and `format-unsupported`. The mock takes `managed?: ManagedCompiler` and
answers `format=bundle` (501 `format-unsupported` for other formats or without a compiler); the
conformance kit checks that the bundle matches a local compile when given the same compiler.
`compileFromSource` and `publishedSource` are exported for servers.
