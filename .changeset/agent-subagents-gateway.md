---
"@getdonn/cli": patch
---

With a gateway, `donn agent create` edits each subagent's `agent/subagents/<name>/agent.ts` once to spread its `donnSubagent` entry (recorded in the manifest's `edits`, as `agent/agent.ts` is), and `donn agent sync` (and the daemon's sync) edits a subagent it has not edited yet, one added later or a gateway added later; such an edit counts as written. A subagent already edited is never edited again: when it no longer routes, the report and a `donn doctor` warning say so. `eve build` no longer inherits `DONN_SECRET_<n>` or `DONN_ROUTE_TOKEN` from the caller's environment. `donn agent list`, `build` and `run` treat an agent with a subagent waiting for that edit as stale. The compile now reads each subagent's `agent.ts`.
