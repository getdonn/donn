---
"@zzpersona/store-remote": minor
---

`RegistryClient.managedBundle({ layer, os })` downloads a managed policy bundle: the manifest and the
files as bytes, and `rawManifest`, the manifest as sent (before tolerant parsing drops fields this
client does not know). File paths are the registry's word; callers check them before writing.
