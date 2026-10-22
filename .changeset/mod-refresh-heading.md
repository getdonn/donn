---
"@zzpersona/mod-claude-code": patch
---

A refreshed persona's instructions now carry their own heading (`## zzpersona persona: <id>
(updated <time>)`) and the superseding note names the launch section to disregard by its exact
heading, wherever it appears, and says earlier answers may be outdated. Before, a refresh of the
launched persona repeated the launch section's heading, so models could keep answering from the
launch instructions. The band now says `relaunch for <permissions | MCP | settings>` when a
refresh of the launched persona changed what only a relaunch applies.
