---
"@getdonn/secrets": patch
---

On macOS, a `secret://keychain/...` value with a newline or a non-ASCII character (a PEM key, say) now resolves to the value itself. It used to resolve to the hex that `security find-generic-password -w` prints for such values; the read now uses `-g` and decodes it.
