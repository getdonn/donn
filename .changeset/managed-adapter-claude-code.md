---
"@zzpersona/adapter-claude-code": minor
---

`managed`: compiles the locks of an org, area or team chain to a Claude Code managed policy bundle
(`managed-settings.d/50-zzpersona.json`, `managed-mcp.json`, locked hook scripts, a manifest with
`minClaudeCode`), with a report that refuses secrets, unsafe servers, unknown keys and passthrough
keys that would replace compiled values (`managed-passthrough-conflict`). Declares the `policy`
capability row: native for Claude Code through the managed bundle, advisory for the other adapters.
