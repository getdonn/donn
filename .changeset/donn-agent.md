---
"@getdonn/cli": minor
---

`donn agent create|list|sync`: create an agent from an eve or path template on a persona (declaring it in the project persona when needed), list the project's agents with their state, whether the persona changed since the last sync, and `recreate needed` when its template, target, path or world did, and `sync` to recompile the persona into donn's files without touching `agent.ts`.

`donn agent env <name> [--resolve] [--format dotenv|json]` lists the environment an agent needs: persona and gateway secrets (names and refs, values only with `--resolve`), plain values, and what is set at run time (the route token, the Workflow database). `donn agent exec <name> -- <command>` runs a command in the agent's folder with that environment resolved, and a secret that does not resolve stops it naming the variable and the ref. `eveEnv` now applies its extra variables before forcing production, so a persona env cannot bring back `NODE_ENV=test`, `VITEST`, `EVE_DEV` or `EVE_MOCK_AUTHORED_MODELS`.
