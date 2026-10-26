---
"@getdonn/cli": patch
---

`donn agent run` for an agent the daemon already runs says it is already running (`already: true`) from any shell: it no longer resolves the agent's env-provider secrets first, so a terminal without those exports no longer fails with `secret-unresolved`
