---
"@getdonn/cli": patch
---

the daemon no longer misses an edit made just after it starts watching: once its file watchers have settled it checks every persona source once more, so a change that landed while they armed is still synced to sessions and created agents
