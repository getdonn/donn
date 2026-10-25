# `donn agent` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `donn agent list|create|sync|env|exec|run|stop|logs|build|deploy`, each with `--json`,
taking a project from "this repo should have an agent" to a running eve 0.83.2 agent on `local`,
`self-host` or `vercel`, through the CLI and the daemon.

**Architecture:** A `gh stack` on `develop`. Layer 0 is `feature/spec-25-spike` (the layer 1
spike `spikes/eve-runner/`, the dated amendments to specs 23–26, this plan). Layer 1
`feature/agent-1-adapter` (Tasks 1–2: the `world` field; adapter changes the spike found).
Layer 2 `feature/agent-2-create` (Tasks 3–6: the eve driver, template sources, `create`, `list`,
`sync`). Layer 3 `feature/agent-3-run` (Tasks 7–9: env, `exec`, `run`/`stop`/`logs` in the
daemon, sync on edit, `status`). Layer 4 `feature/agent-4-ship` (Tasks 10–12: `build`,
`deploy`, `doctor`, e2e, docs). The CLI code lives in `src/apps/cli/src/agent/` (one module per
concern) with the commander glue in `src/apps/cli/src/commands/agent.ts`.

**Tech Stack:** TypeScript, commander 15, zod 4, `yaml` (Document API), vitest, `node:zlib`
(no tar dependency), eve 0.83.2 driven as the agent's own dependency (never a dependency of a
donn package).

**Spec:** `docs/planning/25-agent-runner.md` (amended 2026-10-25 from the spike), with `23` §2
(`world`), `24` §2, §4, §5 (amended), `26` (the question protocol moved there) and
`spikes/eve-runner/FINDINGS*.md` (exact eve behaviour, digests, recordings).

## Global Constraints

- eve `frameworkRange` stays `>=0.83.2 <0.84.0`; the e2e and examples pin 0.83.2. Templates are
  fetched from `https://codeload.github.com/vercel/eve/tar.gz/refs/tags/eve@<version>`.
- Error codes are kebab strings thrown as `CliError(code, message, details)` (`errors.ts`), with
  a `fix` in details where one exists. New codes: `agent-not-declared`, `agent-exists`,
  `agent-incomplete`, `agent-not-created`, `agent-locked`, `template-not-at-version`,
  `template-not-in-repo`, `template-digest-mismatch`, `template-unsafe-entry`,
  `portability-blocking`, `eve-failed`, `ancestor-workspace`, `owned-file-edited`,
  `slot-collision` (from the adapter), `recreate-needed`, `docker-unreachable`,
  `secret-unresolved` (wrapping `SecretResolutionError`), `vercel-cli-missing`.
- Secret values reach only a child process's env, or stdout under `env --resolve`; never a file,
  a log line, the manifest, `env.json`, a daemon event or `--json` output of any other command.
- eve's child env: `NODE_ENV=production`; `EVE_DEV`, `EVE_MOCK_AUTHORED_MODELS`, `VITEST` and
  any `NODE_ENV=test` are removed. `eve start --host 127.0.0.1 --port 0`.
- Tests never touch the real home, keychain, Docker, the network or a real registry: `seed()`
  temp dirs, an injected spawner and an injected `fetch`. Real eve, Docker and the network only
  under `DONN_E2E=1`.
- Every CLI command supports `--json`; a command that would prompt fails with a JSON error when
  stdin is not a TTY or `--json` is set, instead of hanging. Every `agent` subcommand takes
  `--project <dir>` (default: the project found from the current directory, as `donn write`).
- Ruling (spec 25 §5's first self-host path): the generated image runs the server directly; the
  "resolve in the container with `donn agent exec`" path is documented in the command docs
  (Task 12), not generated, because it needs donn and a reachable secret provider in the image.
- Every layer passes `pnpm turbo run build check-types lint test` and `pnpm format:check`.
  Commits: `git commit -s`, ending with `Co-Authored-By: Claude Opus 5.5
  <noreply@anthropic.com>` and `Claude-Session:
  https://claude.ai/code/session_01GmLJYkbT5dYe37adTR8fab`. Changesets per layer.

## Review Focus

1. The agent's `path` lies under a pnpm workspace whose root globs include it (`agents/*` in the
   repo's `pnpm-workspace.yaml`) → `create` never edits the repo root's `package.json`,
   `pnpm-workspace.yaml` or lockfile (eve init runs in staging; install runs in place against
   the agent's own workspace file) → Task 5 test "repo workspace untouched".
2. A fake secret value (`sk-test-SECRET`) behind `secret://env/KEY` → after `create`, `sync`,
   `run`, `build` and `env` without `--resolve`, the value appears in no file under the agent
   directory, `~/.donn/agents/` or any JSON output → Tasks 5, 7, 8, 10 tests "no value on disk".
3. `create` fails after materialising (install exits 1) → the manifest says `incomplete`; a
   second `create` refuses `agent-incomplete` with `fix: donn agent create <name> --force`;
   `--force` removes only a directory whose manifest says `incomplete` → Task 5.
4. A project persona with comments, blank lines and an `agents.define` locked by the org → the
   declare edit keeps every comment and byte outside the new entry; the locked case refuses
   `agent-locked` naming the layer, writing nothing → Task 5.
5. A template tarball entry with `..`, an absolute path, a symlink or a hard link inside the
   template directory → `template-unsafe-entry`, nothing written to `path` → Task 4.

---

### Task 1: The `world` field (`feature/agent-1-adapter`)

**Files:** Modify `src/packages/spec/src/persona.ts` (`Agent`), `src/packages/spec/src/ir.ts`
(`ResolvedAgent`), `src/packages/resolver/src/merge.ts` (`mergeAgents`); JSON schemas if the
spec package generates them (regenerate with its script); create resolver fixtures
`112-agent-world-postgres/` and `113-agent-world-not-self-host/`; tests in the spec package.

**Interfaces (produces):** `AgentWorld = z.enum(["local", "postgres"])` in `common.ts`;
`Agent.world: AgentWorld.optional()` with an object-level refine: `world` set and `target !==
"self-host"` → issue message `world applies only to target self-host` at path `world` (surfaces
as `invalid-persona`); `ResolvedAgent.world: AgentWorld.optional()` (carried only when set;
IR_VERSION unchanged, per `ir.ts`'s stable-IR rule).

- [ ] **Step 1: Failing tests.** Spec: `world: postgres` with `target: self-host` parses;
  with `target: vercel` fails with the message above. Fixture 112 resolves
  `{ target: self-host, world: postgres, … }` into the IR; fixture 113 expects `{ error: { code:
  invalid-persona } }` naming the layer. An agent without `world` resolves exactly as before
  (existing fixtures unchanged).
- [ ] **Step 2: Run** `pnpm --filter @getdonn/spec --filter @getdonn/resolver exec vitest run` — FAIL.
- [ ] **Step 3: Implement**; regenerate `explain.txt` with `vitest run -u` for the new fixtures only.
- [ ] **Step 4: Run** — PASS; full pipeline.
- [ ] **Step 5: Commit** `feat(spec): agents.define.<name>.world for self-host agents`.

### Task 2: Adapter changes from the spike (same branch)

**Files:** Modify `src/packages/adapter-sdk/src/agent.ts` (`AgentCompileInput.project`,
`TemplateInfo`), move `src/packages/adapters/eve/src/semver.ts` into
`src/packages/adapter-sdk/src/semver.ts` exported as `satisfiesRange` (the eve adapter imports
it); modify `adapters/eve/src/{config.ts,compile.ts,collisions.ts,portability.ts,templates.ts}`;
create `adapters/eve/src/channel.ts`; update goldens and the conformance cases; changesets
(minor: spec, resolver, adapter-sdk, adapter-eve).

**Interfaces (produces):**
- `AgentCompileInput.project.hasRouteAuth: boolean` — the template defines its own route auth
  (eve: `agent/channels/eve.<ts|mts|js|mjs|cjs>` or `agent/channels/eve/`).
- `TemplateInfo.digest?: string` — `sha256-<hex>` of the template directory at the pinned tag.
- `satisfiesRange(version: string, range: string): boolean` from `@getdonn/adapter-sdk`.
- `CHANNEL_FILE = "agent/channels/eve.ts"`; written as a donn-owned file when `target` is `local`
  or `self-host` and `!project.hasRouteAuth`, with the spike's content
  (`spikes/eve-runner/FINDINGS-runtime.md` R1: `withAuthChallenges`, `extractBearerToken`,
  `eveChannel({ auth: [donnToken, localDev()] })`, token from `process.env.DONN_ROUTE_TOKEN` read
  per request). `DONN_ROUTE_TOKEN` is added to the output's `env` names the agent needs (value
  `""`, filled by the runner), not to `secretEnv`.
- The `channels/eve` slot joins `assertNoSlotCollisions`.
- Postgres world (`config.ts`): only when `world === "postgres"`.
- Portability (`24` §5 amended): route auth for `local` is not blocking when donn writes the
  channel; for `self-host` an advisory with the text in `24` §5; blocking (with the two lines to
  add) when `hasRouteAuth`; `vercel` unchanged. A path template (`template` not starting `eve:`)
  reports `portability-unknown` like an unknown slug.
- `templates.ts` rows gain `digest` with the eight values from `FINDINGS-templates.md` T2
  (keyed by `repoPath`).

- [ ] **Step 1: Failing tests:** compile `local` without route auth writes `CHANNEL_FILE` and its
  manifest entry; with `hasRouteAuth` it writes none and the report has the blocking entry;
  `vercel` never writes it; a template file at `agent/channels/eve.mts` with `hasRouteAuth:
  false` (stale input) → `slot-collision`; `self-host` without `world` has no
  `experimental.workflow` and no `WORKFLOW_POSTGRES_URL`; with `world: postgres` it has both; a
  path template → `portability-unknown`; `templates()` returns a digest for all eight rows;
  `satisfiesRange("0.83.5", ">=0.83.2 <0.84.0")` true, `"0.84.0"` false.
- [ ] **Step 2: Run** `pnpm --filter @getdonn/adapter-sdk --filter @getdonn/adapter-eve exec vitest run` — FAIL.
- [ ] **Step 3: Implement**; update goldens deliberately (`-u`) and review the diff.
- [ ] **Step 4: Run** — PASS; full pipeline; `DONN_E2E=1` adapter e2e still passes.
- [ ] **Step 5: Commit** `feat(adapter-eve): route-auth channel, opt-in Postgres world, template digests`.

### Task 3: The eve driver and the fake eve (`feature/agent-2-create`)

**Files:** Modify `src/apps/cli/src/cli.ts` (`CliIo.spawn?`, the `agent` command group skeleton
with `list` only stubbed); create `src/apps/cli/src/agent/{spawn.ts,eve.ts}`,
`src/apps/cli/src/test/fake-eve.ts`; tests `agent/eve.test.ts`.

**Interfaces (produces):**
- `CliIo.spawn?: Spawn`, defaulting to `nodeSpawn`:
  `type Spawn = (command: string, args: string[], options: { cwd: string; env:
  NodeJS.ProcessEnv; onLine?: (line: string, stream: "stdout" | "stderr") => void; detached?:
  boolean; stdin?: string }) => SpawnHandle`;
  `interface SpawnHandle { pid: number | undefined; exited: Promise<number>; kill(signal?:
  NodeJS.Signals): void }` (`kill` signals the process group when `detached`).
- `packageManager(dir: string): Promise<"pnpm" | "npm">` — from `package.json`'s
  `packageManager`, default pnpm.
- `eveEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv` — applies
  the Global Constraints' child-env rule.
- `runEve(io: CliIo, dir: string, args: string[], options: { env: Record<string, string>;
  onProgress?: (line: string) => void }): Promise<{ exitCode: number; tail: string[] }>` — runs
  `<pm> exec eve …` in `dir`; `tail` is the last 20 lines; exit 1 → callers throw
  `CliError("eve-failed", …, { command, tail })`.
- `fakeEve(script: FakeEveScript): Spawn` (test helper): records each call (`command`, `args`,
  `cwd`, `env`), replies per a matcher list with lines, an exit code and optional side effects
  (a callback that writes files into `cwd`, e.g. a `.output/` or `eve init`'s files).

- [ ] **Step 1: Failing tests:** `eveEnv` drops `EVE_DEV`, `EVE_MOCK_AUTHORED_MODELS`, `VITEST`,
  sets `NODE_ENV=production` even over `NODE_ENV=test`; `runEve` builds `pnpm exec eve build` /
  `npm exec eve build` from `packageManager`; progress lines arrive in order from both streams;
  the tail is kept; `donn agent list --json` is registered.
- [ ] **Step 2: Run** `pnpm --filter @getdonn/cli exec vitest run src/agent` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(cli): drive the agent's own eve`.

### Task 4: Template sources and the eve pin (same branch)

**Files:** Create `src/apps/cli/src/agent/{tar.ts,digest.ts,template.ts,pin.ts}`; test helper
`src/apps/cli/src/test/tarball.ts` (a minimal ustar + gzip writer for fixtures); tests.

**Interfaces (produces):**
- `CliIo.fetch?: typeof fetch` (default `globalThis.fetch`).
- `extractDir(gz: Uint8Array, prefix: string): Map<string, { data: Uint8Array; mode: 0o644 |
  0o755 }>` — keys relative to `prefix` (`<top>/apps/templates/<repoPath>/`; `<top>` is the
  archive's first directory); throws `CliError("template-unsafe-entry", …, { entry })` for `..`,
  absolute names, or any typeflag other than file (`0`/NUL) or directory (`5`) inside the prefix;
  reads pax `path`/`comment` headers; returns the pax `comment` commit through a second export
  `archiveCommit(gz): string | undefined`.
- `templateDigest(files: Map<string, { data: Uint8Array; mode: 0o644 | 0o755 }>): string` — the
  definition in `FINDINGS-templates.md` T2 (lines `<path>\0<644|755>\0<sha256 hex>\n` sorted by
  code unit; `sha256-<hex>`).
- `fetchTemplate(io: CliIo, slug: string, version: string): Promise<Map<…>>` — looks up the
  slug in the eve adapter's `templates()`; a slug without `repoPath` → `template-not-in-repo`
  (details: the template's own repository when known, and `fix`: create from a local clone as a
  path template); fetch failure 404 → `template-not-at-version` with the nearest tagged versions
  (`git ls-remote --tags https://github.com/vercel/eve 'refs/tags/eve@<major>.<minor>.*'` via
  `io.probe.run`); digest ≠ table → `template-digest-mismatch` (`expected`, `actual`).
- `pinEve(io: CliIo, range: string, override?: string): Promise<string>` — `npm view eve
  versions --json` via `io.probe.run`, the newest satisfying `satisfiesRange`; an override outside
  the range → `CliError("framework-version")`.

- [ ] **Step 1: Failing tests:** extract from a fixture tarball (with a pax global header)
  returns only the template's files with modes; each unsafe entry kind throws; the digest of the
  fixture equals a value computed by hand in the test; a real-shaped digest check: build a
  tarball whose template dir reproduces a tiny tree and assert `template-digest-mismatch` when
  the table value differs (inject the table row through the adapter's `templates()` by testing
  `fetchTemplate` with a stub `templates` parameter, default the adapter's); 404 →
  `template-not-at-version` listing tags from a stub `git ls-remote` output;
  `kody-eve-template` → `template-not-in-repo`; `pinEve` picks `0.83.2` from
  `["0.82.0","0.83.0","0.83.2","0.84.0"]`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(cli): fetch eve templates at a tag, verified by digest`.

### Task 5: `donn agent create` (same branch)

**Files:** Create `src/apps/cli/src/agent/{declare.ts,inputs.ts,files.ts,materialise.ts,
install.ts,create.ts,registry.ts}`, `src/apps/cli/src/commands/agent.ts`; modify `cli.ts`;
tests `agent/create.test.ts` (plus unit tests per module).

**Interfaces (produces):**
- `declareAgent(file: string, name: string, agent: { template: string; target: AgentTarget;
  path?: string }, options: { dryRun: boolean }): Promise<{ before: string; after: string }>`
  — `parseDocument` + `setIn(["agents", "define", name], …)`, written with `writeFileAtomic`;
  before writing, a resolve that reports `lock-violation` on `agents.define…` becomes
  `CliError("agent-locked", …, { layer })`.
- `compileInputs(ctx: Context, ir: ResolvedPersona, agent: string, dir: string,
  frameworkVersion: string): Promise<AgentCompileInput>` — `texts` holds every IR-referenced file
  and every file of each local skill directory (keys `<source>/<file>`); `project.existing` is
  every agent-dir path not in the manifest (excluding `node_modules/`, `.output/`, `.eve/`,
  `.donn/`); `hasSandbox` and `hasRouteAuth` from those paths.
- `Manifest` (spec 24 §4 plus `"state": "incomplete" | "complete"` and `"edits": string[]` for
  template-owned files donn edited: `package.json`, `pnpm-workspace.yaml`, `.gitignore`,
  `agent/agent.ts`); `readManifest(dir)`, `writeManifest(dir, m)` at `<dir>/.donn/agent.json`.
- `writeAgentFiles(dir: string, output: AgentCompileOutput, previous: Manifest | undefined,
  options: { force: boolean; sources: string }): Promise<Record<string, string>>` — the spec 24
  §4 rules (hash mismatch → `owned-file-edited` naming the file unless `force`; removes files the
  new compile no longer produces; copies each `copyFrom` directory and replaces `COPY_PENDING`
  with one `sha256:` per copied file); returns the manifest `files` map. Shared with `sync`.
- `materialise(io, template, dir, version)` — `eve:<slug>` via Task 4; `eve:blank` via a fresh
  `mkdtemp` staging dir (refuse `ancestor-workspace` if a `pnpm-workspace.yaml` or `package.json`
  exists above it), a minimal `package.json`, `eve init <staging> --non-interactive`, then move
  the result into `dir`; a path template copied; `.git` removed from the result.
- `prepareInstall(dir, version, deps: Record<string, string>)` — exact `eve` pin; `ai@^7.0.152`;
  the gateway package from the compile (`@ai-sdk/openai-compatible@^3` or `@ai-sdk/anthropic@^4`);
  `@workflow/world-postgres@^5.0.5` when `world: postgres`; `vercel` (exact current version from
  `npm view vercel version`) as a dev dependency for `target: vercel`; the agent's
  `pnpm-workspace.yaml` (create with `packages: ["."]` if missing) gains `allowBuilds:
  { cbor-extract: false }` and the pinned eve in `minimumReleaseAgeExclude` (Document API).
  Then `<pm> install` in `dir` (never `--ignore-workspace`, never frozen).
- `create(io, name, options: { template?; target?; path?; eve?; dryRun?; force?;
  acceptPortability?; json? })` — spec 25 §2 steps 1–7 in order; writes the manifest with
  `state: "incomplete"` right after materialising and `complete` at the end; prints the compile
  and portability reports (`printReport`; portability entries as `blocking:`/`advisory:` lines);
  a blocking entry → `portability-blocking` unless `--accept-portability`; warns (does not edit)
  when `tsconfig.json` lacks `skipLibCheck: true`. Appends the missing entries of `.env*`,
  `.output/`, `.vercel/`, `node_modules/`, `.eve/` to the agent's `.gitignore`. Records
  `{ project: <repo root>, name }` in `~/.donn/agents/index.json` (`registry.ts`:
  `listCreated(home)`, `recordCreated(home, entry)`, `forgetCreated`). `--json` prints `{ agent,
  dir, frameworkVersion, files, report, portability }`.

- [ ] **Step 1: Failing tests** (temp project from `seed()`, `fakeEve`, stub fetch): declare
  edit keeps comments (Review Focus 4) and `--dry-run` writes nothing; locked → `agent-locked`;
  `eve:<slug>` create end to end writes the template, donn's files, the patched `agent.ts`, the
  manifest (`complete`), the `.gitignore` lines and the install call's argv/cwd; `eve:blank` runs
  `eve init` in a staging dir outside the repo and the repo workspace stays byte-identical
  (Review Focus 1); a nested `.git` is removed; install failure → `incomplete`, then
  `agent-incomplete`, then `--force` recovers (Review Focus 3); a non-empty `path` without a
  manifest → `agent-exists`; blocking portability stops before writing; no secret value on disk
  (Review Focus 2).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(cli): donn agent create`.

### Task 6: `donn agent list` and `sync` (same branch)

**Files:** Create `src/apps/cli/src/agent/{list.ts,sync.ts}`; modify `commands/agent.ts`;
tests; changeset (cli minor).

**Interfaces (produces):**
- `agentStates(ctx, io): Promise<AgentRow[]>`; `AgentRow { name; template; target; path;
  state: "available" | "created" | "running" | "built" | "deployed"; current: boolean;
  recreate?: "template" | "target" | "path" | "world" }` — `created` when a `complete` manifest
  exists; `built` when `.output/` exists and `deploy/donn/Dockerfile` is in the manifest;
  `deployed` when `.vercel/project.json` exists; `running` from the daemon's `GET /agents` (Task
  8; `created` until then); `current` compares a fresh compile's `manifestFiles` with the
  manifest; `recreate` when the persona's template/target/path/world differ from the manifest.
- `sync(io, name, options: { force?; dryRun?; json? })` — recompile and `writeAgentFiles`;
  `recreate` set → `recreate-needed`; never touches `agent.ts`; `--json` prints `{ written,
  removed, report }`.

- [ ] **Step 1: Failing tests:** list shows an inherited, not-created agent as `available`; after
  create `created` and `current: true`; after a persona edit adding a skill `current: false`,
  `sync` writes the skill and removes a dropped one; an edited owned file → `owned-file-edited`
  naming it, `--force` overwrites; a target change → `recreate-needed`.
- [ ] **Step 2–4:** FAIL → implement → PASS; full pipeline.
- [ ] **Step 5: Commit** `feat(cli): donn agent list and sync`.

### Task 7: `donn agent env` and `exec` (`feature/agent-3-run`)

**Files:** Create `src/apps/cli/src/agent/env.ts`; modify `commands/agent.ts`, `cli.ts` (allow
passthrough after `--` for `agent exec`); tests.

**Interfaces (produces):**
- `agentEnv(ctx, io, name, options: { resolve: boolean }): Promise<EnvEntry[]>`; `EnvEntry {
  name: string; source: "secret" | "plain" | "runtime"; ref?: string; value?: string; why:
  "persona-secret" | "gateway-key" | "template-variable" | "world-database" | "route-auth" }` —
  from the compile's `secretEnv` and `env`, the agent's `env`, and `WORKFLOW_POSTGRES_URL` for
  `world: postgres`; `value` only with `resolve` (via `resolveSecrets` with `backendLoader`);
  failures → `CliError("secret-unresolved", …, { failures })` naming variable and ref.
- `donn agent env <name> [--resolve] [--format dotenv|json]`; `donn agent exec <name> -- <cmd>…`
  spawns `<cmd>` in the agent dir with `eveEnv(io.env, resolved)` and returns its exit code.

- [ ] **Step 1: Failing tests:** without `--resolve` no value appears (dotenv prints `NAME=` with
  a `# secret://…` comment); with `--resolve` values print; an unresolvable ref fails naming the
  variable; `exec` passes the env to the spawned command and returns its exit code.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(cli): donn agent env and exec`.

### Task 8: `run`, `stop`, `logs` and the daemon's agents (same branch)

**Files:** Create `src/apps/cli/src/daemon/agents.ts`, `src/apps/cli/src/agent/run.ts`; modify
`daemon/server.ts` (routes), `daemon/client.ts` (`DaemonEventType`, `DaemonStatus.agents`),
`daemon/run.ts` (allow-list), `commands/agent.ts`, `commands/status.ts`; tests
`daemon-agents.test.ts`, `agent/run.test.ts`.

**Interfaces (produces):**
- `startAgent(io, dir, env): Promise<RunningAgent>` — `runEve(… ["build"])`, then spawn
  `<pm> exec eve start --host 127.0.0.1 --port 0` with `detached: true` and `eveEnv(io.env, {
  ...resolved, DONN_ROUTE_TOKEN })` (token: 32 random bytes, hex, generated per run); resolves
  once a line matches `/^\[START\] server listening at (\S+)/` (timeout 60 s → `eve-failed`);
  `RunningAgent { name; project; url; pid; token; startedAt; stop(): Promise<{ leftovers:
  number }> }` — `stop` kills the process group with SIGTERM, then SIGKILL after 10 s, then
  counts `docker ps -q --filter name=eve-sbx-` via `io.probe.run` and reports them.
- Daemon: `AgentRunner` in `daemon/agents.ts` holding `RunningAgent`s; routes `GET /agents` →
  `{ agents: [{ name, project, url, pid, startedAt, token }] }`, `POST /agents/run {project,
  name}`, `POST /agents/stop {project, name}`; events `agent.started`, `agent.stopped`,
  `agent.failed` (no token, no env in events), and `agent.created` when `POST /run` completes an
  `agent create`; log lines via `createLog` at
  `<home>/agents/<sha256(project) first 16 hex>/<name>.log`; all agents stopped on daemon close.
- CLI: `run <name> [--dev]` → with a daemon, `POST /agents/run`; without one, foreground (stops
  on SIGINT/exit); `--dev` → `eve dev` in the foreground, never through the daemon. `stop`, `logs
  [--follow]` (`--follow` tails the log file).
- `allowedRun` gains `agent` with subcommands `list`, `sync`, `run`, `stop`, `create`, `build`,
  `env` (not `--resolve`) and their flags; `exec`, `logs` and `deploy` are not allowed.
- `status` adds one line per created agent: `agent  <name>  <target>  <state>  current|stale`.

- [ ] **Step 1: Failing tests** (fake spawner printing the `[START]` line): run through the daemon
  returns the url; `GET /agents` lists it; the child env has `NODE_ENV=production`, the token
  and resolved secrets, and none of the stripped vars; `stop` signals the group (fake records
  the negative pid / group kill) and reports leftovers from a stub `docker ps`; events carry no
  token; foreground run without a daemon; a log file holds no secret value (Review Focus 2).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(cli): run created agents through the daemon`.

### Task 9: Sync on persona edits (same branch)

**Files:** Modify `daemon/server.ts` (`rewatch` includes `.donn/` of every project in
`listCreated(home)`), `daemon/agents.ts`; tests in `daemon-agents.test.ts`; changeset.

**Interfaces (produces):** on a change, for each created agent of that project: `sync` (no
force); success → `agent.synced`, and a running agent is restarted; `owned-file-edited` or any
error → `agent.sync-failed { name, project, code }` and a `status` line `sync-failed: <code>`;
`recreate` → no sync, `status` shows `recreate needed`.

- [ ] **Step 1: Failing tests:** an edit to the project persona syncs and restarts a running
  agent (fake spawner sees a second start); an edited owned file yields `agent.sync-failed`
  and no write; projects without created agents are not watched for agents.
- [ ] **Step 2–4:** FAIL → implement → PASS; full pipeline.
- [ ] **Step 5: Commit** `feat(cli): the daemon keeps created agents current`.

### Task 10: `donn agent build` (`feature/agent-4-ship`)

**Files:** Create `src/apps/cli/src/agent/build.ts`; modify `commands/agent.ts`; tests.

**Interfaces (produces):** `build(io, name, { json? })` for `self-host`: refuse other targets;
check Docker (`docker info` via `io.probe.run`, else `docker-unreachable` with the fix); run
`eve build` on the host (never `--skip-sandbox-prewarm`); read the template image from
`.output/.eve/compile/sandbox-prepared-artifacts.json`; write donn-owned
`deploy/donn/Dockerfile` (`FROM node:26-slim`, `COPY --from=docker:28.3-cli
/usr/local/bin/docker /usr/local/bin/docker`, `COPY .output /agent/.output`, `WORKDIR /agent`,
`ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production`, `VOLUME /agent/.eve`, `CMD ["node",
".output/server/index.mjs"]`; with `world: postgres` an entrypoint running the package's
`bootstrap` before the server) and `deploy/donn/env.json` (`{ env: EnvEntry[] without values,
sandboxImage, mounts: ["/var/run/docker.sock:/var/run/docker.sock"], volumes: ["/agent/.eve"],
proxy: ["/eve/", "/.well-known/workflow/"] }`), both added to the manifest; print the two
images to ship.

- [ ] **Step 1: Failing tests:** fake eve writes a `.output/` with a prepared-artifacts file;
  build writes both files exactly (snapshot) and the manifest entries; `world: postgres` adds
  the bootstrap entrypoint and `WORKFLOW_POSTGRES_URL` in `env.json`; Docker unreachable →
  `docker-unreachable`; `env.json` holds no value (Review Focus 2).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(cli): donn agent build for self-host`.

### Task 11: `donn agent deploy` (same branch)

**Files:** Create `src/apps/cli/src/agent/deploy.ts`; modify `commands/agent.ts`; tests.

**Interfaces (produces):** `deploy(io, name, { yes?; json? })` for `vercel`: `vercel` CLI in the
agent (`<pm> exec vercel --version`), else `vercel-cli-missing`; `eve link --non-interactive
--project <name>` when `.vercel/project.json` is missing; the env names not yet pushed (tracked
as names, never values, in the manifest's `pushedEnv`) listed and confirmed (TTY prompt; `--yes`
for scripts; `--json` without `--yes` fails with the list); each value through `io.runInput(
"<pm>", ["exec", "vercel", "env", "add", name, "production"], value)`; then `eve deploy
--non-interactive --yes`.

- [ ] **Step 1: Failing tests:** unlinked → link then deploy (argv order); confirmation lists
  names only; `--json` without `--yes` fails with `{ names }`; values go through stdin, never
  argv; a second deploy pushes only new names.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(cli): donn agent deploy for vercel`.

### Task 12: `doctor`, e2e, docs (same branch)

**Files:** Modify `src/apps/cli/src/doctor/checks.ts` (an `agents` check group after
`secrets`), `src/apps/cli/src/e2e.test.ts` or a new `agent.e2e.test.ts`, the CLI README/docs
page for commands, `docs/capabilities.md` if regenerated, `CLAUDE.md` status line; changesets.

**Interfaces (produces):** per created agent, checks `agent:<name>:eve` (pinned eve inside the
adapter's range), `agent:<name>:docker` (`local`/`self-host`), `agent:<name>:gateway` (the
gateway `baseURL` answers an HTTP request; warn on failure), `agent:<name>:agent-ts` (still
spreads `donn`), `agent:<name>:files` (manifest files present), `agent:<name>:vercel` (`vercel`
targets). Nothing added without created agents.

- [ ] **Step 1: Failing tests** for each doctor check (ok and failing case).
- [ ] **Step 2: e2e (`DONN_E2E=1`, real eve 0.83.2, Docker, network):** create from `eve:blank`
  and from `eve:eve-slack-agent` (digest verified); `run` with the spike's stub gateway and one
  `POST /eve/v1/session` turn with the bearer token reaching the stub with the key and header;
  `build`, then `docker run` the image with the socket mounted and one turn through the stub.
- [ ] **Step 3: Implement**; docs for every subcommand; status lines in `CLAUDE.md`.
- [ ] **Step 4: Run** the full pipeline and the e2e once locally.
- [ ] **Step 5: Commit** `feat(cli): agent checks in doctor; agent e2e and docs`.

**Smoke before the final review** (memory: smoke before final review): `kody-eve-template`
cloned locally, created as a path template in a scratch repository with `target: self-host`,
built and run in Docker behind a tunnel, reviewing one real pull request through a LiteLLM
gateway; and `donn agent run` of an `eve:blank` agent through the daemon with one turn. Kody
pins a `VercelSandbox` and uses Vercel Connect (`FINDINGS-templates.md` T6): for the self-host
smoke, replace its `agent/sandbox.ts` with the Docker one and give it a GitHub App's id, key and
webhook secret through `agents.define.<name>.env`; it then reviews the diff only (no checkout).
