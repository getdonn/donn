---
"@zzpersona/cli": minor
"@zzpersona/adapter-codex": minor
---

The Codex adapter. `zzpersona codex [persona] [-- <codex args>]` launches Codex CLI with the
persona's instructions (`developer_instructions`), MCP servers (secrets resolved into the launch
environment and forwarded by name), MCP tool approvals and `-s workspace-write -a on-request`
defaults, all as `-c` overrides; nothing is written to `~/.codex`. `targets.codex` sets the
sandbox, approval and model. Skills and hooks are reported dropped. `compile --harness codex`
dry-runs the build, and `doctor` gains an optional `codex` check.
