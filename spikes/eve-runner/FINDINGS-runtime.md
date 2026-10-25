# eve 0.83.2 runtime: production start, route auth, worlds, self-host image (spec 25, layer 1)

Throwaway spike, run 2026-10-25 against `eve@0.83.2` (host Node 26.12.0, image `node:26-slim` =
Node 26.12.1, pnpm 12.14.0, Docker 28.3.3 on macOS arm64, `postgres:18`). Installed in
`runtime/proj/` with pnpm: `eve 0.83.2`, `ai 7.0.152`, `@ai-sdk/openai-compatible 3.0.77`,
`@workflow/world-postgres 5.0.5`, `zod 4.6.7`. Source citations are symbols in the minified
`node_modules/eve/dist/src/…` files.

Layout: `runtime/compile.mjs` runs the real `@getdonn/adapter-eve` compile (built `dist/`) into
`runtime/proj/` and patches `agent/agent.ts` with `patchAgentTs`, as `donn agent create` will;
`node compile.mjs <gatewayBaseURL> <local|self-host>`. `proj/stubs/openai-stub.mjs` is an
OpenAI-compatible stub (copied from `eve-slots`) that logs model, tools, tool results,
`Authorization` and `x-team`, and with `STUB_TOOL=bash STUB_ARGS=…` makes one tool call so a turn
opens the sandbox. `proj/agent/channels/eve.ts` is a hand-written donn-style route-auth policy
(R1). `proj/deploy/donn/Dockerfile` builds inside Docker; `Dockerfile.prebuilt` copies a
host-built `.output/`. `runtime/recordings/` holds real `eve add --non-interactive` output for a
fake-eve fixture. The compiled persona: gateway `openai-compatible`, key `secret://spike/key` (→
`DONN_SECRET_1`), header `x-team: payments`, model `stub-model`, context window 128000.

Every "turn reached the gateway" claim below was re-run on a stub port of its own (4020) after a
parallel spike briefly shared port 4010; the log lines quoted are from those re-runs.

**Verdict: the production path works, with three changes to spec 25** (route auth for `local`,
how the self-host image is built, and the Postgres world's schema step) and a handful of
details (NODE_ENV, `.eve/`, pnpm settings, NDJSON shape, the Vercel CLI). See "Impact on spec 25".

## R1. Production path: `eve build` + `eve start`, one HTTP-channel turn. CONFIRMED, with route auth NEW

`eve build` writes a Nitro `node-server` build to `.output/` (`nitro.json`: `serverEntry:
server/index.mjs`, `preset: node-server`). `eve start` (`cli/run.js` → `startProductionServer` in
`internal/nitro/host/start-production-server.js`) does three things: loads the `.env*` files
(`loadDevelopmentEnvironmentFiles`), spawns `node .output/server/index.mjs` with `HOST`,
`NITRO_HOST`, `NITRO_PORT`, `PORT` set and `TEST` deleted, and waits for `Listening on`.
Defaults: host `0.0.0.0`, port `$PORT` then 3000; `--port 0` picks a free port.

**Why session routes answer 401 under `eve start`.** Route auth fails closed. With no
`agent/channels/eve.ts`, eve uses the default channel with `[vercelOidc(), localDev(),
placeholderAuth()]` (docs `guides/auth-and-route-protection.md`). `localDev()` accepts only
when `isLocalDevelopmentServer()`: `VERCEL` with `VERCEL_ENV=development`, or
`isEveDevEnvironment()`, which is `process.env.EVE_DEV === "1"` (set by `eve dev`;
`internal/application/dev-environment.js`). So under `eve start`, nothing authenticates:

```
$ curl -i -X POST localhost:3311/eve/v1/session -d '{"message":"Say hello."}'
HTTP/1.1 401   www-authenticate: Bearer
{"code":"unauthorized","error":"Authorization is required for this route.","ok":false}
```

`EVE_DEV=1 eve start` does pass a turn, but `isEveDevEnvironment()` is also read by 12 other
modules (sandbox provider default, model auth transport and API key, schedules, memory lifecycle,
optional package install, the sandbox shutdown plugin, …). It is not a production switch:
rejected.

**What works:** an `agent/channels/eve.ts` whose `AuthFn` reads a bearer token from the env
per request (so `eve build`, which evaluates the module without the run-time env, needs no
value), ahead of `localDev()`:

```ts
const donnToken: AuthFn<Request> = withAuthChallenges((request) => {
  const expected = process.env.DONN_ROUTE_TOKEN;
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!expected || !token || token !== expected) return null;
  return { attributes: {}, authenticator: "donn", principalId: "donn-local", principalType: "service" };
}, [{ scheme: "Bearer" }]);
export default eveChannel({ auth: [donnToken, localDev()] });
```

The command line that works (local target, host Docker):

```
$ NODE_ENV=production pnpm exec eve build
$ NODE_ENV=production DONN_ROUTE_TOKEN=tok-spike DONN_SECRET_1=sk-spike-123 \
    pnpm exec eve start --host 127.0.0.1 --port 0
➜ Listening on: http://127.0.0.1:61131/
[START] server listening at http://127.0.0.1:61131/
$ curl -X POST 127.0.0.1:61131/eve/v1/session -H 'authorization: Bearer tok-spike' -d '{"message":"run it"}'
{"ok":true,"sessionId":"wrun_01M5T0BTH4W1H9D4P9CF2XHM62","status":"accepted"}
[openai-stub] POST /v1/chat/completions model=stub-model tools=bash,read_file,… auth=Bearer sk-spike-123 x-team=payments
[openai-stub] POST /v1/chat/completions … toolResults="{\"stdout\":\"Linux aarch64\\nPRETTY_NAME=\\\"Ubuntu 26.04.1 LTS\\\"\\n\",…,\"exitCode\":0}" …
```

Without the token: `POST /eve/v1/session` → 401, and `GET /eve/v1/session/:id/stream` → 401.
`GET /eve/v1/health` is public. The session's NDJSON stream carries `session.started`,
`turn.started`, `message.received`, `step.started` (`modelId: "donn-gateway/stub-model"`),
`message.appended`, `message.completed`, `step.completed`, `turn.completed`, `session.waiting`.

**NODE_ENV.** Unset and `production` both reach the gateway. With **`NODE_ENV=test`**, the turn
"completes" without any gateway call: `shouldMockAuthoredRuntimeModels()` returns
`NODE_ENV === "test" || EVE_MOCK_AUTHORED_MODELS === "1"`
(`runtime/agent/mock-model-adapter.js`), and the reply is `"Bootstrap reply [Instructions
(instructions/donn)]: Say hello."`. That explains spec 24's e2e finding under vitest.

**`.env` files.** `eve start` loads `.env.development.local`, `.env.local`, `.env.development` and
`.env` from the agent directory (`DEVELOPMENT_ENV_FILE_NAMES` in
`shared/development-env-files.js`). Keys already in the process env are protected
(`protectedKeys`), so values donn passes win over a user's `.env`.

Impact on spec 25:
- For `local`, donn must make route auth work; it is not only the user's (see Impact 1).
- `run` sets `NODE_ENV=production`, removes `EVE_MOCK_AUTHORED_MODELS`, `EVE_DEV` and `VITEST`
  from the child env, and passes `--host 127.0.0.1` (eve's default host is `0.0.0.0`).
- `run` can pass `--port 0` and read the port from the `[START] server listening at <url>` line
  on stdout, instead of probing for a free port itself.

## R2. The local Workflow world under `eve start`. CONFIRMED

No configuration is needed: state goes to `.eve/.workflow-data/` (`events`, `hooks`, `runs`,
`steps`, `streams`, `waits`, `version.txt`; 1.2 MB after a few turns) under the agent directory
(the process cwd). It survives a restart: after a session's first turn, killing `eve start`,
starting it again and posting to `POST /eve/v1/session/<id>` continued the same session, and
the stream showed `first` / `stubbed` / `second` / `stubbed`. eve's self-hosting guide adds
that each process accepts deliveries only from its own queue (no replicas on the local world),
and that recovery re-enqueues pending runs on start. The local world also works **inside a
container**: the `local` compile (no world override) in `Dockerfile.prebuilt`, with a volume on
`/agent/.eve`, served a sandboxed turn through the gateway, and the volume held
`.eve/.workflow-data/`.

`.eve/` also holds `builds/`, `locks/`, `sandbox-cache/` and `agent-summary.json`.

Impact on spec 25: §2 step 7's `.gitignore` list needs **`.eve/`**. `donn agent logs` and
`status` may read run state from `.eve/.workflow-data` (local) but should go through eve's
routes instead.

## R3. Self-host image, Docker sandbox, Postgres world. CHANGED

eve's own guide (`docs/guides/deployment/self-hosting.md`): `eve build`, then `PORT=3000 eve start
--host 0.0.0.0`. Forward `/eve/` **and** `/.well-known/workflow/` through any proxy. The image
can run `node .output/server/index.mjs` with `HOST`/`PORT` instead, which is what `eve start`
spawns; it needs no `node_modules` (the output carries its own `server/node_modules`:
`cbor-extract` and four helpers).

**The Docker sandbox needs the `docker` CLI**, not only a socket: `DockerSandbox` shells out to
`docker` (`execution/sandbox/bindings/docker-cli.js`, `resolveDockerExecutable()`;
`EVE_DOCKER_PATH` overrides it). The image copies it in:
`COPY --from=docker:28.3-cli /usr/local/bin/docker …`.

**`RUN eve build` in a Dockerfile:**
- Without a flag it fails, because the pinned `DockerSandbox` (adapter `sandbox.ts`) prepares
  its template at build: `eve: failed to initialize sandbox template "root" on provider "docker":
  The Docker sandbox provider requires Docker, but the docker CLI was not found.`
- With `--skip-sandbox-prewarm` the build passes and the server runs, but **every session that
  opens the sandbox fails**:
  `SandboxTemplateNotProvisionedError: No prepared "docker" sandbox environment is recorded for
  agent node "__root__". eve prepares sandbox environments during eve build and never prepares
  them in production. Run eve build without --skip-sandbox-prewarm and deploy that output with
  this runtime.`

**What works:** `eve build` where the run-time Docker daemon is reachable. That builds and
commits a template image on the daemon (`eve: sandbox template "root" (docker): committing
template image "eve-sandbox-template:e38d6315…-15b0ac35…"`) and records it in
`.output/.eve/compile/sandbox-prepared-artifacts.json` (`{"entries":[{"artifact":
{"imageReference":"eve-sandbox-template:…"},"nodeId":"__root__","providerName":"docker"}],
"kind":"eve-sandbox-prepared-artifacts","version":2}`). The image then **copies `.output/`**.
Run with `-v /var/run/docker.sock:/var/run/docker.sock` against the same daemon: a sandboxed
turn through the gateway (`auth=Bearer sk-spike-123 x-team=payments`; `uname` in the sandbox →
`Linux aarch64`, Ubuntu 26.04.1).

**The template image must exist on the run-time daemon.** After `docker rmi` of that image, the
next turn: `Sandbox template "eve-sandbox-template:…" for provider "docker" is not available to
this runtime. The Docker daemon has no image with that name: it was removed, for example by
docker image prune -a, or the build used another Docker daemon. The runtime only uses templates
that eve build prepared and never recre[ates them]`. So a self-host deliverable is **two
images**: the agent image (with `.output/`) and the sandbox template image, which must reach the
run-time daemon under the same tag (`docker save | docker load`, or a registry push and pull).
Untested: moving the template image to another daemon.

A host-built `.output` (macOS) ran in a Linux container: the bundled `cbor-extract` native addon
has no Linux build, and nothing failed (cbor-x falls back to JavaScript). The cross-platform copy
worked here, but it is a risk for native addons in general.

**Postgres world.** The adapter's `self-host` compile adds `experimental: { workflow: { world:
"@workflow/world-postgres" } }`.
- Not installed at build: the server fails at start (`ERR_MODULE_NOT_FOUND: Cannot find package
  '@workflow/world-postgres'`). Installed, it is bundled into `.output/server/_libs/`.
- Selected, it is **required**: with no database the server crashes at start (`ECONNREFUSED
  127.0.0.1:5432`; `env.ts` warns `donn: missing environment variables: DATABASE_URL or
  WORKFLOW_POSTGRES_URL`).
- With an empty database it also crashes: `relation "workflow.workflow_runs" does not exist`.
  The schema must be created first, with the package's `bootstrap` bin (`bin/setup.js` →
  `setupDatabase()`; `workflow-postgres-setup` is the deprecated name):
  `WORKFLOW_POSTGRES_URL=… pnpm exec bootstrap` → `✅ Database schema created successfully!`
- After the bootstrap: health `ready`, a sandboxed turn through the gateway, and the warning
  `[Graphile Worker] WARNING: having maxPoolSize (10) smaller than concurrency (50)` (tunable
  with `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` / `_MAX_POOL_SIZE`).

What `--skip-sandbox-prewarm` changes: it skips template preparation, so the build passes without
Docker, but the output cannot open a Docker sandbox in production (see above). It is fine only
for an agent that never opens its sandbox, or for a build that only checks compilation.

Impact on spec 25: see Impact 2 and 3. A `self-host` agent with Postgres is optional, not
required: the local world works in a single-replica container with a volume.

## R4. The GitHub channel's checkout on Docker. CONFIRMED (skipped by failing, swallowed)

`createDefaultEvents()["turn.started"]` → `checkoutRepositoryForTurn` →
`checkoutGitHubRepository` (`public/channels/github/defaults.js`, `checkout.js`). Checkout
first resolves the PR descriptor and **mints an installation token**
(`resolveGitHubInstallationToken`), then calls `sandbox.setNetworkPolicy(
gitHubGitBrokerNetworkPolicy(token))`, a policy with a header `transform` (credential brokering).
On Docker, `assertDockerNetworkPolicy` throws
(`execution/sandbox/bindings/docker-network.js`): `The local Docker sandbox provider supports only
the "allow-all" and "deny-all" network policies. Domain-level allow-lists and credential
brokering require the Vercel provider (VercelSandbox).` `checkoutRepositoryForTurn` catches it
(`logError(log, "GitHub checkout failed — swallowed", e)`), and the turn goes on with the PR's
diff context but no repository files. Docs agree (`docs/channels/github.mdx`, "Sandbox
checkout": "requires a firewall-capable backend (Vercel); the local backend skips checkout").

Impact on spec 25: none to the design (spec 24 §5's limitation holds). A self-hosted PR reviewer
logs one swallowed error per turn and spends a token mint and API calls on it; `doctor` or the
portability report could say so.

## R5. Exit codes and NDJSON. CHANGED (shape and streams)

Only the setup flows emit NDJSON and exit 2: `eve add`, `eve registry …` and the integration
setup (`cli/commands/integration-setup.js`, `registry*.js`). `build`, `start`, `init`, `link` and
`deploy` print human text and exit 0 or 1 (no `serializeHeadlessSetupEvent`, no `exitCode=2` in
`commands/{build,deploy,link,init}.js`, `cli/run.js`).

Recorded with `eve add channel/github --non-interactive` (files in `runtime/recordings/`):
- **pnpm build policy (exit 1)**, on stdout, with the install rolled back:
  `{"version":1,"type":"failed","item":"channel/github","completedItems":[],"message":"Dependency
  installation stopped because pnpm requires build-script decisions. Run pnpm approve-builds,
  then retry the eve add command.","failureCode":"pnpm_build_policy","rolledBack":true}`.
  Fixed by `allowBuilds: { cbor-extract: false }` in the agent's `pnpm-workspace.yaml`. That
  also ends the `ERR_PNPM_IGNORED_BUILDS` non-zero exit from `pnpm install`.
- **Needs an answer (exit 2):** a `progress` event on **stdout**, interleaved with human lines
  (`Set up GitHub: …`, `Checking Vercel setup...`), then the `blocked` event on **stderr**:
  `{"version":1,"type":"blocked","item":"channel/github","installed":true,"completedItems":[],
  "status":"input_required","question":{"key":"github-events","message":"What should this
  GitHub App respond to?","required":true,"kind":"multi-select","options":[{"id":
  "issue_comment","label":…,"hint":…},…],"recommended":["issue_comment",
  "pull_request_review_comment"]},"next":{"command":"eve","args":["add","channel/github",
  "--non-interactive","--skip-install","--answer","github-events=<JSON value>"]}}`
- **Prerequisite (exit 2)**, after `--answer 'github-events=["pull_request"]'`, on stderr:
  `{"version":1,"type":"blocked",…,"status":"prerequisite_required","prerequisite":{"kind":
  "command","code":"vercel-project-link","message":"GitHub setup requires a linked Vercel
  project. Run eve link, then retry.","command":"eve link"},"next":{…}}`
- The question kinds (`setupQuestionToWire`, `setup/setup-question-wire.js`): `select`,
  `multi-select`, `editable-select` (with `editable: {key, optionId, label, recommended}`),
  `confirm`, `text` (`sensitive: false`, optional `placeholder`), and for a secret
  **`environment`** (`variable: <ENV NAME>`, `sensitive: true`). An invalid answer comes back as
  `input_required` with `issue: {code: "invalid_answer", message}`.
- `eve link --non-interactive --project x` with no Vercel login exits 1 (`vercel link --project
  x --yes exited with code 1.`). In a project without the `vercel` package it exits 1 with
  `Vercel CLI not found. Install with: npm i -g vercel@latest`. `eve add channel/github`
  installs `vercel@65.2.0` and `@vercel/connect` into the agent. `eve deploy --non-interactive
  --yes` on an unlinked directory exits 1 (`This directory is not linked to a Vercel project. Run
  eve link first, or name the project on the deploy itself: eve deploy --project <name-or-id>
  --non-interactive --yes`). Both evaluate the agent modules (the `donn: missing environment
  variables` warning prints). Run with an empty `HOME`; no Vercel credentials were touched.

Impact on spec 25: §6's question JSON maps to eve's wire format: `prompt` → `message`, `choices` →
`options[].id` (with `label`, `hint`), `secret` → `kind: "environment"` + `variable`. Also add
`kind`, `required`, `recommended`, and `prerequisite_required` as a second blocked status, whose
`prerequisite.command` (`eve link`) donn runs only for `vercel`. The parser reads **both**
streams line by line and keeps lines that parse as `{"version":1,…}`. The continuation is
eve's `next.args`, with `--skip-install` included.

## R6. Other findings against spec 25 §4–§6

- **pnpm and the agent's own workspace file.** In this run, `pnpm add --ignore-workspace` ignored
  the agent's own `pnpm-workspace.yaml`. It failed with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`
  (`eve@0.83.2 was published at 2026-10-24T19:46:20Z, within the minimumReleaseAge cutoff`)
  although that file excludes `eve@0.83.2`; the same add without `--ignore-workspace`
  succeeded. (An earlier `pnpm add --ignore-workspace eve@0.83.2` in the same directory passed;
  not reproduced, so treat the exclusion as unreliable under `--ignore-workspace`.) pnpm 12's
  default minimum release age is one day, so "the newest eve in the range" (§2 step 3) can be
  uninstallable for its first day.
- **Leftover sandbox containers.** Stopping `eve start` by signalling the `pnpm exec` parent left
  four `eve-sbx-*` containers running. `donn agent stop` must signal the server process itself,
  and check for `eve-sbx-*` containers after it exits.
- **The portability report for `local`** marks `route-auth` blocking even for `eve:blank`, so
  `create --target local` stops at §2 step 2 unless `--accept-portability`. That fits once donn
  supplies local route auth (Impact 1), which also lets the entry become non-blocking for `local`.

## Impact on spec 25 (summary)

1. **Route auth for `local` is donn's.** eve fails closed under `eve start`, and `localDev()` only
   opens under `eve dev`. Proposal: when the template has no `agent/channels/eve.ts`, `create`
   writes a donn-owned one: a bearer `AuthFn` reading `DONN_ROUTE_TOKEN` per request, then
   `localDev()`. The daemon generates the token per run and keeps it in memory; the GUI and
   `logs` use it. When the template has its own channel file, report the two lines to add by
   hand. For `self-host` and `vercel`, the same token works as a starting point; real
   Basic/JWT/OIDC stays the user's.
2. **Self-host build:** drop `RUN eve build` from the generated Dockerfile. `donn agent build`
   runs `eve build` on the host against the run-time Docker daemon (never with
   `--skip-sandbox-prewarm` when the agent opens a sandbox), then builds an image that copies
   `.output/` plus the `docker` CLI, `CMD ["node", ".output/server/index.mjs"]`. The report names
   the sandbox template image (from `sandbox-prepared-artifacts.json`) that must reach the
   run-time daemon. `env.json` adds the socket mount and the `/eve/` + `/.well-known/workflow/`
   proxy rule.
3. **Postgres world:** `create` adds `@workflow/world-postgres` for `self-host`; `build` (or a
   `donn agent db setup`) runs `bootstrap` against `WORKFLOW_POSTGRES_URL` before the first
   start. Or reconsider making Postgres opt-in for `self-host`, since the local world runs in a
   single container with a volume.
4. **Child env for `run`:** `NODE_ENV=production`; strip `EVE_MOCK_AUTHORED_MODELS`, `EVE_DEV`
   and `VITEST`; `--host 127.0.0.1 --port 0`; read the URL from the `[START]` line.
5. **`.gitignore`:** add `.eve/`.
6. **pnpm:** the agent directory gets its own `pnpm-workspace.yaml` with `allowBuilds: {
   cbor-extract: false }` and a `minimumReleaseAgeExclude` entry for the pinned eve when it is
   younger than a day (or pin the newest eve older than the policy). Install without
   `--ignore-workspace` once that file exists.
7. **NDJSON (§6):** eve's wire names, both streams, `prerequisite_required`, and `next.args` as
   the continuation (R5).
8. **`vercel`:** `deploy` needs the Vercel CLI. `create --target vercel` adds `vercel` as a
   dev dependency, or `doctor` checks for it on the PATH.

Left behind on the host: two `eve-sandbox-template:*` images (one committed per prewarm build).
`docker image ls | grep eve-sandbox-template` shows them.
