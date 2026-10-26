---
"@getdonn/cli": patch
---

`donn agent create` no longer leaves `agents.define.<name>` in the project persona when it refuses the agent (a blocking portability entry, a non-empty folder, a failed eve pin or template fetch): the declaration is written only once nothing can refuse the agent, and a persona edited while the create runs is not overwritten
