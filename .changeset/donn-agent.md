---
"@getdonn/cli": minor
---

`donn agent create|list|sync`: create an agent from an eve or path template on a persona (declaring it in the project persona when needed), list the project's agents with their state, whether the persona changed since the last sync, and `recreate needed` when its template, target, path or world did, and `sync` to recompile the persona into donn's files without touching `agent.ts`.
