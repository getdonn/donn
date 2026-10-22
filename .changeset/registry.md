---
"@zzpersona/cli": minor
"@zzpersona/resolver": minor
"@zzpersona/secrets": minor
"@zzpersona/registry-api": minor
"@zzpersona/store-remote": minor
---

A registry for shared layers. `zzpersona login|logout|whoami|pull|publish` publish `org/*`,
`area/*` and `team/*` layers as bundles and pull them into a read-only cache that resolves offline;
a published layer wins over a same-name local file with a warning, and `--local` leaves the cache
out. New `@zzpersona/registry-api` (the contract, a mock server and a conformance kit) and
`@zzpersona/store-remote` (the client). The resolver's `PersonaSource` gains `dir`; the keychain
provider can write and delete, and macOS exit 44 now means a missing secret.
