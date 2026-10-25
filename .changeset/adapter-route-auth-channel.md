---
"@getdonn/adapter-sdk": minor
"@getdonn/adapter-eve": minor
---

The eve adapter writes a donn-owned `agent/channels/eve.ts` (a bearer `DONN_ROUTE_TOKEN` plus `localDev()`) for the local and self-host targets when the template has no route auth of its own, and the route-auth portability entry follows (advisory, or blocking with the lines to add by hand). The Postgres world is opt-in (`world: postgres`). Templates carry a `sha256-` digest, path templates report `portability-unknown`, and `AgentCompileInput.project` gains `hasRouteAuth`. The SDK exports `satisfiesRange`.
