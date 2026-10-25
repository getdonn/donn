---
"@getdonn/spec": minor
"@getdonn/resolver": minor
"@getdonn/adapter-sdk": minor
"@getdonn/adapter-claude-code": minor
"@getdonn/adapter-codex": minor
"@getdonn/adapter-agents-md": minor
"@getdonn/registry-api": minor
"@getdonn/cli": patch
---

Personas can declare `models` (gateway routing, lockable) and `agents`; every harness adapter reports `models` (not yet supported). See docs/planning/23-models-and-agents.md.

A layer that uses a path agent template now publishes that template folder with it (missing or escaping folders are refused). Header names in `models.gateway.headers` and in MCP url-server `headers` must be valid HTTP header names.
