---
"@getdonn/cli": minor
"@getdonn/cli-schemas": minor
---

A `local` agent now keeps one port per machine, stored on its entry in `~/.donn/agents/index.json`, so a tunnel or a webhook can point at it and still work after a restart or a sync. `donn agent run <name> --port <n>` picks the port (1024 to 65535; checked free before it is stored), and the daemon, the foreground run and `--dev` all reuse it. `donn agent list --json` and `donn status --json` now show the stored `port` of each agent, running or not.
