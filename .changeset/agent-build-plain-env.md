---
"@getdonn/cli": patch
---

`donn agent run` (in the foreground and through the daemon) and `donn agent build` run `eve build` with the agent's plain env values from `agents.define.<name>.env`, so a template that reads one at module load builds. Secrets and `DONN_ROUTE_TOKEN` still never reach the build.
