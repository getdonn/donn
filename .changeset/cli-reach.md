---
"@zzpersona/cli": minor
"@zzpersona/secrets": minor
"@zzpersona/resolver": minor
"@zzpersona/adapter-sdk": patch
"@zzpersona/adapter-claude-code": patch
"@zzpersona/store-local": patch
---

Reach. Third-party adapters and secret providers load from `adapters:` and `secretProviders:` in
`config.yaml` (packages from `~/.zzpersona/adapters`, or paths), only when a command needs one;
`compile --harness <id>` works with any loaded adapter and `doctor` checks every listed plugin.
`@zzpersona/secrets` gains `SecretContext`, `defineSecretProvider` and a built-in `keychain`
provider (macOS `security`, Linux `secret-tool`), with `doctor` printing the command that stores a
missing item. `zzpersona diff [a] <b>` shows what changes between two personas, with provenance.
Hardening: class-based adapters keep their methods, an SDK-owned `Platform` type, conformance
reports a missing `chdir`, `strictMcp` must be a boolean, later managed-settings drop-ins win, no
empty objects in settings.json, concurrent switches no longer lose entries, `switch` and `init`
edge cases, error envelopes always carry a message, and project files may link elsewhere in their
repo.
