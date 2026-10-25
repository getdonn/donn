# eve 0.83.2 slots, names, AI SDK pairing (spec 24, Task 2)

Throwaway spike, run 2026-10-25 against `eve@0.83.2` (Node 26.12, pnpm 12.14, Docker 28.3.3).
Everything below was driven through `eve info --json`, `eve build`, `eve dev`/`eve start` and
`tsc`; source citations are to the minified `node_modules/eve/dist/src/…` files (one line each,
so a symbol, not a line number).

Layout: `proj/` is the eve project (installed with `pnpm add --ignore-workspace`, not in the repo
workspace; `pnpm-workspace.yaml` globs only `src/*`). `proj/stubs/` holds a legacy-SSE-only MCP
server and an OpenAI-compatible chat stub. `name-rule.sh` loops connection names through
`eve info`. Installed: `eve 0.83.2`, `ai 7.0.152`, `@ai-sdk/openai-compatible 3.0.77`,
`@ai-sdk/anthropic 4.0.87`, `@ai-sdk/provider 4.0.33`, `@workflow/world-postgres 5.0.5`.

**Verdict: no answer contradicts spec 24.** Three details to carry into Tasks 3-5 are marked
NOTE under Q4, Q5, Q6 and "Other facts".

## Q1. Instruction order. CONFIRMED

`agent/instructions.md` first, then `agent/instructions/*` by filename; `donn.md` sorts among the
template's own fragments.

Fixture: `instructions.md` (ROOT-ROLE-MARKER), `instructions/a-template.md`, `instructions/donn.md`,
`instructions/z-template.md`.

```
$ eve info --json | jq .instructions
"instructions.md (system), instructions/a-template.md (system), instructions/donn.md (system), instructions/z-template.md (system)"
```

`.eve/agent-summary.json` `instructions[]` carries the same four entries in that order, each
`role: "system"`, `sourceKind: "markdown"`, `logicalPath: "instructions/donn.md"`. So `donn.md`
follows the root role file, and a template fragment named `a-…` precedes it and `z-…` follows it.
Impact: none; Task 3 may rely on "after the root, among the fragments by name".

## Q2. Collisions between template and donn names. CONFIRMED (error, never shadow or merge)

All three collisions fail discovery (`eve info` status `failed`, `eve build` exit 1):

```
skills/donn-x.md + skills/donn-x/SKILL.md
- Error: Found conflicting authored skill sources for "donn-x": "skills/donn-x/SKILL.md" and "skills/donn-x.md".

connections/donn-x.ts + connections/donn-x.mts
- Error: Found multiple authored module sources for "connections/donn-x": "donn-x.mts", "donn-x.ts".

connections/donn-x.ts + connections/donn-x/index.ts
- Error: Connection "donn-x" is defined twice. Found both file-form "connections/donn-x.ts" and folder-form "connections/donn-x/". Use one form, not both.
```

Also an authored tool `tools/donn-sse__foo.ts` next to connection `donn-sse`:
`Tool "donn-sse__foo" starts with "donn-sse__", which belongs to connection "donn-sse". Rename the tool file.`

Impact: `slot-collision` (a refusal naming both files) matches eve's own rule, and refusing before
writing is strictly better than letting `eve build` fail later. Task 3's collision check must
treat both forms of one name as one (`skills/donn-x.md` vs `skills/donn-x/`;
`connections/donn-x.{ts,mts,js,…}` vs `connections/donn-x/`), and the `donn-<name>__` tool/subagent
prefix check in spec 24 §3 is an eve rule too.

## Q3. Static connection-file name rule. CONFIRMED (same rule as dynamic)

`discover/grammar.js`: `CONNECTION_SLUG_PATTERN=/^[a-z][a-z0-9-]{0,63}$/` (skills use
`SKILL_NAME_PATTERN=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/`). Error text:
`Connection filename "Donn-X" is not a legal connection name. Expected lowercase ASCII letters,
digits, and dashes only, starting with a letter, up to 64 characters.`

`name-rule.sh` (each name as `agent/connections/<name>.ts`):

| name | result |
|---|---|
| `donn-x`, `donn-9`, `donn-`, `donn--x` | ready |
| `Donn-X`, `donn_x`, `9donn`, `-donn`, `donn.x` | failed (illegal) |
| 63 and 64 x `a` | ready |
| 65 x `a` | failed |

Impact: spec 24 §3 is exact (lowercase letters, digits, dashes, start with a letter, at most 64
including the `donn-` prefix). A trailing dash or `--` is legal, so the adapter's own mapping need
not forbid them.

## Q4. AI SDK pairing. CONFIRMED (`@ai-sdk/openai-compatible@^3`, `@ai-sdk/anthropic@^4`, `ai@^7`)

eve 0.83.2 peers `ai ^7.0.137`. Installed with `ai@^7.0.137`, `@ai-sdk/openai-compatible@^3`,
`@ai-sdk/anthropic@^4` (resolved to one shared `@ai-sdk/provider@4.0.33`). npm dist-tags:
openai-compatible `latest` 3.0.78 (`ai-v6` = 2.0.87); anthropic `latest` 4.0.88 (`ai-v6` = 3.0.135).

`agent/lib/donn/config.ts` (exact form from the spec) and `agent/lib/spike/anthropic-config.ts`:

```ts
const gateway = createOpenAICompatible({ name: "donn-gateway", baseURL, apiKey,
  headers: { "x-donn": "1" }, includeUsage: true });
export const model = gateway("some-model");
export const modelContextWindowTokens = 128000;
export const experimental = process.env.SPIKE_PG ? ({ workflow: { world: "@workflow/world-postgres" } } as const) : undefined;
// anthropic: createAnthropic({ baseURL, apiKey, headers })("claude-sonnet-5")
```

```
$ tsc --noEmit -p .        # config + agent.ts + anthropic-agent.ts  -> exit 0
$ eve build                # both forms (agent.ts swapped)           -> built output at .output
$ eve info --json | jq .model   -> "donn-gateway/some-model"   and   "anthropic/claude-sonnet-5"
```

Runtime proof for the openai-compatible form (`eve dev` + stub): the stub received
`POST /v1/chat/completions model=some-model headers.x-donn=1 auth=Bearer k`, so `headers`,
`apiKey` and the model id reach the gateway, and the provider name `donn-gateway` is not a known
provider (tools sent: `bash, read_file, write_file, web_fetch, agent, eve__*`, no `web_search`).

NOTE (tsc): with `skipLibCheck: false`, type-checking fails on `@ai-sdk/provider`'s
`import … from 'json-schema'` (TS7016) until `@types/json-schema` is installed, and, if a
`sandbox.ts` is present, on eve's `just-bash-sandbox.d.ts` (`Cannot find module 'just-bash'`).
Both vanish with `skipLibCheck: true`, which eve templates normally set. Not a donn problem, but
the agent's `package.json` must not be expected to type-check under `skipLibCheck: false`.

NOTE (excess keys): spreading a module namespace into `defineAgent` is strict. A config module
with any export other than `model`, `modelContextWindowTokens`, `experimental` is rejected twice:
`tsc` (`ExactDefinition<…>`, "Type 'AnthropicProvider' is not assignable to type 'never'") and
`eve build`/`start` at runtime (`Expected the agent config export "default" from "agent.ts" to
match the public eve shape. Unknown key "anthropicGw".`). So `lib/donn/config.ts` must export
exactly those names, nothing else (keep the provider in a non-exported const). An `experimental`
of `undefined` is accepted.

NOTE (anthropic gateway form): the anthropic provider is not renamed, so eve sees provider
`anthropic` (`eve info`: `anthropic/claude-sonnet-5`) and may treat it as a known provider
(spec 24 §2 already warns for OpenAI-compatible); only the `donn-gateway` form was exercised end
to end. Whether eve adds Anthropic provider tools that a gateway rejects was not tested.

## Q5. SSE-only MCP server by URL. CONFIRMED

`agent/connections/donn-sse.ts`: `defineMcpClientConnection({ url: "http://127.0.0.1:4020/sse",
description: "…" })` (import from `eve/connections`; no transport option). The stub
(`stubs/mcp-sse.mjs`) speaks only legacy HTTP+SSE (`GET /sse`, `POST /messages`). With `eve dev
--no-ui` and a session whose model (stub) calls `eve__search`:

```
[mcp-sse] POST /sse        <- eve tries Streamable HTTP first (stub 404s)
[mcp-sse] POST /sse
[mcp-sse] GET /sse         <- falls back to SSE
[mcp-sse] POST /messages x3   (initialize, initialized, tools/list)
```

and the session stream contains `donn-sse__ping_stub(input: { who?: string })`, the stub's tool.
Impact: a persona `transport: sse` server compiles like any URL server, as spec 24 §3 says.
Note eve first sends a POST to the same URL, so an SSE server is probed with one failing POST.

## Q6. `defineAgent({ ...donn })` and the Docker sandbox. CONFIRMED

`agent/agent.ts` is exactly `export default defineAgent({ ...donn })` with
`import * as donn from "./lib/donn/config"`; it type-checks and `eve build` succeeds (openai-
compatible and anthropic forms, and with `SPIKE_PG=1` which bundles `@workflow/world-postgres`).
Constraint: the config module's exports must be exactly the allowed keys (Q4, excess keys).

`sandbox.ts` pinned to Docker, exact spec form (`DockerSandbox.environment()` +
`defineSandbox(() => environment.open({ networkPolicy: "allow-all" }))`):

| host | command | result |
|---|---|---|
| Docker reachable | `eve build` | ok; "initialized 1 sandbox template"; creates an `eve-sandbox-template:<hash>` image (the spike removed its images) |
| Docker unreachable (`DOCKER_HOST=unix:///nonexistent.sock`) | `eve build` | **fails, exit 1**: `failed to initialize sandbox template "root" on provider "docker": The Docker sandbox provider requires a running Docker daemon, but it is not reachable.` |
| Docker unreachable | `eve build --skip-sandbox-prewarm` | ok (output "may not be deployable") |
| no `sandbox.ts`, Docker unreachable | `eve build` | ok, exit 0, with `DefaultSandbox has no sandbox provider for this build … Start Docker and rebuild, deploy to Vercel, or select a provider explicitly` (provider `null` in the build) |

Impact: pinning Docker in `sandbox.ts` makes `eve build` need a reachable daemon (it builds the
template image at build time); spec 24 §2 left this open ("checked in layer 1"). Task 5 / spec 25
`donn agent build|deploy` for self-host: build where Docker runs, or pass `--skip-sandbox-prewarm`
on a Docker-less build host (and then the first session prepares it, to be confirmed in spec 25).
Spec 24's wording needs no change except recording this.

## `@workflow/world-postgres` connection variable (Ruling 1)

`node_modules/@workflow/world-postgres/dist/index.js` `getDefaultConnectionString()`:

```js
process.env.WORKFLOW_POSTGRES_URL || process.env.DATABASE_URL || 'postgres://world:world@localhost:5432/world'
```

README: "Required: PostgreSQL connection string `WORKFLOW_POSTGRES_URL`". **Env var name:
`WORKFLOW_POSTGRES_URL`** (falls back to `DATABASE_URL`). Observed: `eve start` of a build with
`experimental.workflow.world: "@workflow/world-postgres"` and no database dies at start with
`ECONNREFUSED ::1:5432 / 127.0.0.1:5432` (the localhost default), so eve selects the world from
`agent.ts` (no `WORKFLOW_TARGET_WORLD` needed) and the variable must be set at run time. Optional
siblings: `WORKFLOW_POSTGRES_JOB_PREFIX`, `_WORKER_CONCURRENCY`, `_MAX_POOL_SIZE`. Installed 5.0.5.

## Other facts for Tasks 3-5

- `eve start` rejects `/eve/v1/session` with 401 outside `eve dev` (the default channel is
  `[vercelOidc(), localDev(), placeholderAuth()]`); drive runs with `eve dev --no-ui`.
- `defineTool` is `eve/tools`, `defineMcpClientConnection` is `eve/connections`, `defineAgent` is
  `eve`, `defineSandbox` is `eve/sandbox`, `DockerSandbox` is `eve/sandbox/docker`.
- `pnpm add` exits non-zero with `ERR_PNPM_IGNORED_BUILDS` (`cbor-extract`) in this repo's pnpm 12
  though the install completes; `spikes/eve-slots/proj/pnpm-workspace.yaml` was written by pnpm to
  exclude eve from the release-age gate. Task 5 (`donn agent create`) will hit the same exit code
  when it installs eve.
