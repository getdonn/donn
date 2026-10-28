# 24 — `adapter-eve`: a persona compiled into an eve agent

> Status: design, 2026-10-24. Track "agents and the GUI", second spec (order: 23, 24, 25, with 26
> in parallel). Builds on `23` (the `models` and `agents` fields; its "Facts" section is the eve
> research this spec relies on), `05` (adapter SDK, compile report, conformance kit), `11`
> (knowledge pointers as text) and `13` (every field declared). Built as a `gh stack` after `23`'s
> layers.
> *Amended 2026-10-25:* re-checked against eve 0.83.2. The persona is no longer an extension: donn
> writes `donn`-named files straight into the agent's own slots (see "Re-check 2026-10-25").
> *Amended 2026-10-25 (`25`'s spike):* `world: postgres` opt-in for `self-host`, a donn-owned
> `agent/channels/eve.ts` for route auth, path templates report `portability-unknown` (§5).
> *Built 2026-10-25* (`feature/eve-*` stack, six layers): `AgentAdapter` and its conformance kit in
> `@getdonn/adapter-sdk`, `@getdonn/adapter-eve` (public from this release), the capability
> matrix's "Agent adapters" section and an opt-in real-eve e2e (`DONN_E2E=1`). What the build
> learned is in the `*Amended 2026-10-25 (build)*` notes in §1, §2 and §5.
> *Amended 2026-10-27 (kody smoke):* with a gateway, subagents go through it too: each
> `agent/subagents/<name>/agent.ts` spreads its `donnSubagent` entry (§2 "Subagents", §3–§5).

## Re-check 2026-10-25

eve moved from 0.82.0 to 0.83.2 between this spec's first draft and this re-check, before any of
it was built. Read from the `eve@0.83.2` npm tarball (its `docs/` and `CHANGELOG.md`), the
`vercel/eve` repository and `eve.dev/templates`. What changed for this spec, and why:

- **No directory mount.** An `agent/extensions/<name>` mount must default-export an installed
  extension *package* (`package.json#eve.extension`, built by `eve extension build`, checked
  against a compatibility manifest). The folder of contributions this spec put at
  `agent/extensions/donn/` is not a valid mount, which answers open question 1. The maintainer
  chose (2026-10-25) to drop the extension and write into the agent's slots (Decisions, §2–§4).
- **Slots that make that easy:** `agent/instructions/` is a directory of instruction fragments
  that eve appends after the root `instructions.md`; `skills/` and `connections/` are path-named.
- **Connections:** names are lowercase letters, digits and dashes; bearer tokens go in
  `auth: { getToken }`, other schemes in `headers`; there is no transport option, the URL speaks
  Streamable HTTP or SSE (§3).
- **Models:** eve peers `ai@^7` and builds on `@ai-sdk/*@^4`; `includeUsage: true` is still the
  documented OpenAI-compatible form (§2).
- **Sandbox:** the default sandbox picks Docker when a daemon answers at build time; Docker takes
  only `allow-all` or `deny-all` network policies (§2, §5).
- **Templates:** the real gallery slugs differ from the ones this spec used, and only some
  templates live in eve's repository (§1, §5). The GitHub channel checks a pull request out into
  the sandbox only on Vercel (§5).
- **Breaking minors:** 0.82.0 replaced the per-session token limits with `limits.sessionUsage`;
  0.83.0 changed the custom sandbox provider API and `VercelSandbox`'s relative working directory.
  The pin and range below follow from that (§2).

## Intent

Turn one resolved agent (a persona plus an `agents.define` entry plus `models`) into the files
that make an eve project run that persona: its instructions, skills and MCP servers, with the
model routed through the organisation's gateway. The adapter is pure, like every adapter: it
returns files and reports, and `donn agent` (`25`) carries out the side effects. It never owns the
whole eve project; the template and the user own everything donn does not generate, so custom
tools, hooks and channels live next to donn's files and survive every regeneration.

## Decisions (and the alternatives rejected)

*Amended 2026-10-25:* row 2 first read "The persona becomes a **directory extension** mounted at
`agent/extensions/donn/`", rejecting a published npm extension per persona and files written
straight into `agent/skills/` and `agent/connections/`. eve 0.83 has no such mount, so the
rejected slot option is now the decision (option A); row 3 follows it.

| Decision | Rejected | Why |
|---|---|---|
| A new `AgentAdapter` contract in `@getdonn/adapter-sdk`, beside `HarnessAdapter` | eve as a `HarnessAdapter`; an `agent?` hook on `HarnessAdapter` | An agent is not a harness session: `switch`, `launch` and live refresh do not apply, and `donn switch` would offer eve as a harness. A separate contract keeps both small, and leaves room for other agent frameworks later |
| **Option A:** the persona is written into the agent's own slots under donn-reserved names (`instructions/donn.md`, `skills/donn-<name>/`, `connections/donn-<name>.ts`), each file in the ownership manifest; a name the template already uses is refused, never overwritten | **Option B:** generate a real extension package (`package.json` with `eve.extension`, `extension/…`) and run `eve extension build` on every sync, mounted by `agent/extensions/donn.ts`; the first draft's directory mount (eve has none); a published npm extension per persona | Slots are first-class in eve and need no build, so the compile stays pure (files only) and the manifest's per-file hashes already cover them. B adds a package to every agent, puts a build step outside the compile, and ties donn to eve's extension format and its compatibility manifest, which eve checks per version and has kept changing within 0.x (mount-scoped extension state in 0.69) |
| donn owns `agent/lib/donn/` and its `donn`-named slot files; `agent.ts` stays the template's, with a one-time edit at create | donn owns `agent.ts` | Templates put real settings in `agent.ts` (compaction, workflow world, build options); owning it would erase them on every regeneration |
| An ownership manifest with a hash per file; a hand-edited donn file stops regeneration | Overwrite donn's files silently | The same rule as overlays and managed bundles: never clobber a hand edit without `--force` |
| The portability report is a static table in the adapter, per template and target | Discover it from the template's code; no report | It must be shown before anything is created; a table is reviewable and tested |

## 1. The `AgentAdapter` contract

*Amended 2026-10-25:* `project` gains `existing` (the compile needs the template's names to refuse
a collision, §3); `TemplateInfo` takes eve's real gallery slugs and gains `repoPath`; the
`VercelService` list gains `github-checkout` (§5).

*Amended 2026-10-25 (build):* `PortabilityEntry.service` is `PortabilityService`, which is
`VercelService | "route-auth"`: route auth is not a Vercel service but the entry shape is the
same. `AgentAdapter` gains `providerEnv?: readonly string[]`, the env names generated files may
read although the agent does not set them (the provider keys, `AI_GATEWAY_API_KEY`, a world's
connection variable); the `env-declared` check allows exactly those besides `env` and
`secretEnv`. The conformance list also gains `connection-description` (every connection file has a
non-empty description). `texts` must carry **every** file of a local skill directory (keys
`<source>/<file>`), and a local skill with no `<source>/SKILL.md` text is an input error, as an
instruction file is in every harness adapter; the compile reads them to validate the skill and the
CLI supplies them (`25`).

```ts
interface AgentAdapter {
  apiVersion: 1;
  /** Kebab-case; also the template prefix: "eve" for `eve:<slug>`. */
  id: string;
  irVersions: readonly number[];
  /** The framework versions this adapter compiles for, as a semver range. */
  frameworkRange: string;
  /** Every fixed capability field declared, as for harnesses (spec 13). */
  capabilities(): CapabilityMatrix;
  /** Known templates and what each needs at each target. */
  templates(): TemplateInfo[];
  compile(input: AgentCompileInput): AgentCompileOutput; // pure, synchronous
}

interface AgentCompileInput {
  personaId: Ref;
  ir: ResolvedPersona;
  /** A key of `ir.agents`. */
  agent: string;
  /** The pinned framework version (`25` §2). */
  frameworkVersion: string;
  /** Text of every file the IR references by path, as for harnesses. */
  texts: Record<string, string>;
  /** Facts about the created project that change the output (did the template author a sandbox). */
  project: {
    hasSandbox: boolean;
    /** Agent-directory paths not in the manifest (template- or user-owned), for collisions. */
    existing: string[];
  };
}

interface AgentCompileOutput {
  /** Agent-directory-relative; every one is donn-owned. */
  files: Record<string, FileEntry>;
  /** Placeholder env var → secret ref. Files read `process.env.<NAME>`, never values. */
  secretEnv: Record<string, SecretRef>;
  /** Plain values from `agents.define.<name>.env`. */
  env: Record<string, string>;
  report: CompileReport;
  portability: PortabilityEntry[];
}

interface TemplateInfo {
  slug: string;                       // the eve.dev gallery slug: "kody-eve-template"
  title: string;                      // "GitHub Project Maintainer"
  /** Directory in the eve repository at the version tag; absent for a template kept elsewhere. */
  repoPath?: string;                  // "apps/templates/eve-slack-agent-template"
  /** Vercel-only services the template's code uses. */
  services: VercelService[];          // "connect" | "sandbox" | "drive" | "daemons" | "ai-gateway"
                                      // | "github-checkout"
}

interface PortabilityEntry {
  target: "local" | "self-host" | "vercel";
  service: PortabilityService;
  /** What to do instead at this target, written to be read as an instruction. */
  instead: string;                    // "Bring a GitHub App: set GITHUB_APP_PRIVATE_KEY …"
  /** Env names the replacement needs, if any. */
  env?: string[];
  /** The agent cannot run at this target until the user acts on it. */
  blocking: boolean;
}
```

- `capabilities()` declares the same fixed fields as a harness adapter. `CompileReport`,
  `ReportEntry`, `FileEntry` and `SecretRef` are reused unchanged.
- **Conformance kit**, an agent half beside the harness half: every field declared with a note when
  not native; compile is deterministic; no `secret://` string and no secret value in any file;
  every path stays inside the agent directory; every `env` name a file reads is in `env` or
  `secretEnv`; `templates()` slugs are unique; every skill and connection donn writes is named
  `donn-…` and passes eve's name rule (added 2026-10-25).
- Loading: first-party only in this track. Third-party agent adapters can follow the plugin rules
  of spec 08 later; the contract is ready for it.

## 2. What the compile writes

*Amended 2026-10-25:* the `extensions/donn/` folder is gone; donn's files sit in the agent's own
slots under `donn` names. `agent.ts` without a template file, the AI SDK majors, the
`sandbox.ts` form and the pinned version are updated for eve 0.83.2.

*Amended 2026-10-25 (build):* what the build and its checks settled, against eve 0.83.2.

- **The env check.** `lib/donn/env.ts` never throws at import: eve builds the agent without the
  run-time environment, so a missing variable logs a warning naming every one at load. The hard
  failure is at the first model call, where `lib/donn/config.ts` wraps the model with
  `wrapLanguageModel` (from `ai`) and a middleware that throws "donn: missing environment
  variables: …" before any request. A `vercel-ai-gateway` model is a plain string and cannot be
  wrapped, so it is warn-only. Agent `env` values may carry secret refs, which become
  `secretEnv`.
- **Context window.** eve 0.83.2 has no context-window fallback, so the "approximated entry
  naming eve's default" above does not exist. `openai-compatible` without
  `targets.eve.contextWindow` is the compile error `context-window-required` (eve's catalog never
  knows a custom gateway's ids). An `anthropic` gateway gets an advisory entry: eve looks the
  model up in the AI Gateway catalog at build (network), so set `targets.eve.contextWindow` if it
  is not there. The direct and `vercel-ai-gateway` rows get none. Model ids reach every gateway
  unchanged (`23`'s `default`).
- **Anthropic gateway provider.** `createAnthropic({ baseURL, apiKey, headers })` has no `name`:
  the form the spike built, and it keeps eve's catalog lookup. Only the openai-compatible form
  uses the `donn-gateway` name.
- **Direct provider keys** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) are optional for `local`, where
  eve accepts `/login` credentials; they are required for `self-host` and `vercel`.
- **The config module.** `lib/donn/config.ts` exports exactly one name, `donn`, an object with
  only `model`, `modelContextWindowTokens?` and `experimental?` (eve rejects any other key), and
  `agent.ts` uses `import { donn } from "./lib/donn/config"` and `...donn`, not the namespace
  form shown above.
- **Dependencies.** The generated config imports `ai` (for the guard) and the provider package,
  so `25` adds `ai@^7.0.152` and `@ai-sdk/openai-compatible@^3` or `@ai-sdk/anthropic@^4` to the
  agent's `package.json`.
- **Real eve.** The opt-in e2e (`src/packages/adapters/eve/src/e2e.test.ts`) ran the form
  against `eve dev --no-ui` with `NODE_ENV=development` and a stub gateway: the call arrived with
  the configured bearer key and header. That is the only path verified. Under vitest's
  `NODE_ENV=test` eve's session never reached the gateway, and the production path (`eve build`
  and a production run) is unverified; `25`'s spike must check it.

```
agents/pr-reviewer/                    (the eve project; `25` creates it from the template)
  package.json                         template-owned; `25` pins eve in it
  agent/
    agent.ts                           template-owned; `25` edits it once (below)
    instructions.md                    template-owned: the agent's own role
    instructions/donn.md               donn: the persona's instructions, a fragment after the role
    channels/github.ts                 template-owned; the user may edit it
    tools/…  hooks/…  skills/…         template- or user-owned
    skills/donn-<name>/SKILL.md …      donn: the persona's skills
    connections/donn-<name>.ts         donn: the persona's HTTP MCP servers
    lib/donn/config.ts                 donn: model and runtime settings for the target
    lib/donn/env.ts                    donn: the env names donn's files read, checked at start
    sandbox.ts                         donn, only to pin Docker for `self-host` (below)
  .donn/agent.json                     donn: the ownership manifest (§4)
```

- **Instruction order.** eve reads the root `instructions.md` (or `.ts`) first, then the
  `instructions/` entries non-recursively in filename order (`localeCompare`), all as system
  instructions. `donn.md` therefore always follows the template's role file. When the template
  has its own `instructions/` directory, `donn.md` sorts among its entries; that is acceptable,
  since the persona text is project context, not a rule that must come last.
- **Layout.** donn writes into `agent/`. eve also accepts a flat layout (agent files at the app
  root) and workspace members (`agents/<name>/agent/`); see open question 2.

**The edit to `agent.ts`.** `donn agent create` (`25` §2) edits the template's `agent.ts` once:
it imports `donn` from `./lib/donn/config` and spreads it as the last property of the
`defineAgent({...})` call (`import { defineAgent } from "eve"`, unchanged in 0.83), removing a
literal `model` property if there is one. The edit uses the TypeScript parser and refuses
(`agent-ts-unrecognised`, with the two lines to add by hand) unless the file has exactly one
default-exported `defineAgent` call with an object literal. eve 0.83 makes `agent.ts` optional
(the default model is then eve's own); a template without one gets a minimal
`export default defineAgent({ ...donn })` from `create`, which satisfies eve's rule that a present
`agent.ts` names a `model`, and is the user's file from then on (`agentTs: "created"` in the
manifest). Regeneration never touches `agent.ts` again; `donn doctor` warns when it no longer
spreads `donn`, because the gateway is then no longer enforced for that agent.

**Subagents.** *Amended 2026-10-27 (kody smoke).* eve gives a declared subagent
(`agent/subagents/<name>/`) nothing of the root's, its model included, so the kody template's
researcher called `openai/gpt-5.6-terra` past the gateway. With `models.gateway`:

- The compile reads each `agent/subagents/<name>/agent.ts` (`AgentCompileInput.project.texts`,
  an optional field added for this) and `lib/donn/config.ts` also exports `donnSubagent`, one
  entry per subagent with only the keys eve takes on a subagent, `model` and
  `modelContextWindowTokens` (`experimental.workflow.world` is root-only): the agent's gateway
  model, or `targets.eve.subagents.<name>.model`, another model of the same gateway with the same
  window (`targets.eve.contextWindow`).
- `patchSubagentTs` makes the same one-time edit as `agent.ts`'s, with `import { donnSubagent }
  from "../../lib/donn/config"` and `...donnSubagent.<name>` (`donnSubagent["<name>"]` for a name
  that is not an identifier) as the last property. Unlike `agent.ts`, the subagent keeps its own
  `model`: the spread wins with a gateway, and the file keeps building without one. The entry is
  keyed by subagent rather than one shared object so the edit never depends on the persona: an
  override added or removed later changes only `config.ts`.
- The report carries one advisory per routed subagent: "subagent researcher's own model
  openai/gpt-5.6-terra is replaced by the gateway's claude-sonnet-5-5" ("own model" alone when the
  model is not a string literal; "which sets no model, gets …" when there is none), at the path
  that chose the model.
- A subagent `agent.ts` the edit does not recognise (a `defineDynamic` export, two calls, …) is
  the compile error `agent-ts-unrecognised`, naming the file and the two lines to add by hand.
- Without a gateway nothing changes: no edit, no entry, no `donnSubagent`; an override is
  reported dropped. A subagent an earlier gateway's edit left spreading its entry gets an empty
  one (`{}`), so it builds on its own model.
- Only `agent/subagents/<name>/agent.ts` is read: nested subagents and `defineWorkspaceAgent`
  peers (remote, no model) are not edited.

**`lib/donn/config.ts`** exports `{ model, modelContextWindowTokens?, experimental? }`:

| `models` | `model` |
|---|---|
| `gateway.type: openai-compatible` | `createOpenAICompatible({ name: "donn-gateway", baseURL, apiKey, headers, includeUsage: true })(<id>)` |
| `gateway.type: anthropic` | `createAnthropic({ baseURL, apiKey, headers })(<id>)` from `@ai-sdk/anthropic` |
| `gateway.type: vercel-ai-gateway` | The plain string `<id>`; the key goes to `AI_GATEWAY_API_KEY` (on Vercel, OIDC needs none) |
| no gateway, `anthropic/<id>` | `anthropic("<id>")` from `eve/models/anthropic` (reads `ANTHROPIC_API_KEY`) |
| no gateway, `openai/<id>` | `openai("<id>")` from `eve/models/openai` (reads `OPENAI_API_KEY`) |
| no gateway, any other provider | compile error `model-needs-gateway`: "set models.gateway, or use an anthropic/ or openai/ model" |

- The provider gets its own `name` so eve does not detect a known provider and add built-in tools
  the gateway may reject (eve's docs warn of this for OpenAI-compatible endpoints).
- `modelContextWindowTokens` is required by eve for models the AI Gateway has no metadata for.
  donn sets it from `targets.eve.contextWindow` when given; otherwise the report carries an
  `approximated` entry naming the default eve falls back to.
- For `self-host`, `experimental.workflow.world` is `@workflow/world-postgres`, and its connection
  variable is added to the env the agent needs (`25` §4). *Amended 2026-10-25 (`25`'s spike):*
  only when the agent sets `world: postgres` (`23` §2); by default `self-host` keeps eve's local
  world, like `local`. `local` and `vercel` leave the world to
  eve's default for the host. *(2026-10-25)* At 5.0.4 or later: eve's session handoff needs it,
  and the world must match the `@workflow/*` 5.x line eve vendors.
- Any added provider package (`@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`,
  `@workflow/world-postgres`) is a dependency `25` adds to the agent's `package.json`, pinned.
- *(2026-10-25)* **AI SDK majors.** eve 0.83.2 peers `ai@^7.0.137` and builds against
  `@ai-sdk/anthropic@^4` and `@ai-sdk/provider@^4`. `@ai-sdk/openai-compatible@3.0.78` (npm
  `latest`) depends on `@ai-sdk/provider` 4.x and npm's `ai-v6` tag points at its 2.x line, so the
  pairing is presumed `@ai-sdk/openai-compatible@^3` and `@ai-sdk/anthropic@^4`; layer 1 confirms
  it by building. `createOpenAICompatible({ name, baseURL, apiKey, includeUsage: true })` is the
  form eve's own docs show.
- *(2026-10-25)* **The pin.** The adapter compiles for eve 0.83.2 at this re-check. eve breaks
  within 0.x minors (0.82.0 and 0.83.0 both did), so `frameworkRange` spans one minor
  (`>=0.83.2 <0.84.0`) and widens only after the next re-check.

**`sandbox.ts`** (self-host only, and only when the template authored none). *Amended
2026-10-25:* eve's default sandbox selects Vercel Sandbox on Vercel and otherwise Docker when
`docker version` answers within five seconds **at build time**, and records the choice in the
build; a production build with neither still succeeds and the first session that opens the
sandbox fails. donn writes `sandbox.ts` only to pin Docker, so the provider no longer depends on
what the build host can reach (whether `eve build` then needs a daemon to prepare the image is
checked in layer 1):

```ts
import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";

export const environment = DockerSandbox.environment();
export default defineSandbox(() => environment.open({ networkPolicy: "allow-all" }));
```

donn emits `allow-all`, because the persona's skills and the agent's tools reach the network.
Docker accepts only `"allow-all"` and `"deny-all"`; domain allow-lists and credential transforms
are Vercel Sandbox features (§5).

## 3. Field mapping

*Amended 2026-10-25:* outputs move from `extensions/donn/` to the agent's slots; secrets use
`auth.getToken` for bearer tokens; the SSE condition is dropped; names follow eve 0.83's rules
with a `donn-` prefix in place of the `donn__` mount prefix, and collisions are refused.

| Persona field | eve output | Support | Note |
|---|---|---|---|
| `instructions` | `instructions/donn.md`, fragments in resolved order | native | The template's `agent/instructions.md` stays the agent's role; the persona's text is the project context (order: §2) |
| `skills` | `skills/donn-<name>/` (the `SKILL.md` directory, copied whole) | native | caveat: supporting `scripts/` run only where the agent has a sandbox, which is eve's rule. eve names the skill from the directory and requires `description` frontmatter in a packaged `SKILL.md`; a skill without one is dropped with that reason |
| `mcp.servers` (url) | `connections/donn-<name>.ts` with `defineMcpClientConnection({ url, description, auth?, headers? })` | native | caveat: stdio servers and `gateway://` refs are dropped (below) |
| `mcp.servers` (stdio) | — | (item) dropped | "eve connects to HTTP MCP and OpenAPI only" |
| `mcp.servers` (`gateway://`) | — | (item) dropped | The same reason as the other adapters until gateway resolution exists |
| `knowledge` | pointer lines in `instructions/donn.md`; an `mcp://<server>` pointer names the `donn-<server>` connection (the mapped name below) | advisory | As `agents-md` renders it (spec 11) |
| `secrets` | `process.env.DONN_SECRET_<n>` reads; `secretEnv` maps each to its ref | native | Values reach the process at run or deploy time (`25` §5) |
| `permissions.allow\|deny\|ask` | — | none | "Harness permission rules do not map to eve; eve's tool allow-lists per connection are a later mapping" |
| `hooks.*` | — | none | "eve hooks are TypeScript modules; author them in the agent's hooks/" |
| `policy` | — | none | "Managed policy is harness enforcement; eve has no managed surface" |
| `models` | `lib/donn/config.ts` | native | — |
| `targets.eve` | `contextWindow` (above); `subagents.<name>.model` (§2 "Subagents", added 2026-10-27); unknown keys are reported | native | The per-compiler escape hatch, as for other adapters |

- **Connection descriptions.** eve routes on a connection's `description`. A persona's MCP server
  has none, so donn writes "`<name>` MCP server from persona `<id>`" unless
  `targets.eve.connections.<name>.description` gives one. The report does not flag this; the
  conformance kit checks every connection has a description.
- **Secrets in headers.** A secret ref becomes `process.env.DONN_SECRET_<n>` in the connection
  file. An `Authorization: Bearer <ref>` header becomes
  `auth: { getToken: async () => ({ token: process.env.DONN_SECRET_<n>! }) }`, eve's bearer
  form (an app-owned credential by default); any other header, secret or plain, stays in
  `headers`, which eve stacks on top of `auth`.
- **Transport.** eve's MCP client has no transport option: the URL must speak Streamable HTTP or
  SSE, and eve uses either. A persona server's `transport` (`http` or `sse`) is therefore not
  written, and an SSE server compiles like any other URL server.
- **Names.** donn's slot files carry a `donn-` prefix, which replaces eve's `donn__` mount prefix:
  - **Connections** (eve 0.83: lowercase ASCII letters, digits and dashes, starting with a letter,
    at most 64): the persona name is lowercased and `_` becomes `-`; a name with any other
    character outside `[a-z0-9-]` after that, or longer than 64 with the prefix, is dropped with
    the reason (`name-unmappable`). Two persona servers that map to one name (`my_db`, `My-DB`) are
    a compile error (`name-collision`) naming both, since dropping either would be arbitrary.
    A connection owns `donn-<name>__…`, so no tool or subagent may use that prefix.
  - **Skills** (ASCII letters, digits, `_` and `-`, starting with a letter or digit, at most 64):
    the persona name is kept after the prefix; a name eve rejects is dropped with the reason.
  - **Collisions with the template are refused**, never overwritten: a donn path or name that is
    already in `project.existing` and not in the manifest (a template `instructions/donn.md`,
    `skills/donn-x.md` or `skills/donn-x/`, `connections/donn-x.ts`, a file under `lib/donn/`,
    a tool or subagent named `donn-x__…`) is a compile error, `slot-collision`, naming both files.

## 4. The ownership manifest

*Amended 2026-10-25:* the paths are the slot files of §2, the pinned version is 0.83.2, the
template uses its gallery slug, and `agentTs` can be `created`.

`<agent dir>/.donn/agent.json`, committed with the project:

```json
{
  "agent": "pr-reviewer",
  "persona": "project/payments-api",
  "adapter": "eve",
  "frameworkVersion": "0.83.2",
  "template": "eve:kody-eve-template",
  "target": "self-host",
  "files": {
    "agent/instructions/donn.md": "sha256:…",
    "agent/skills/donn-review-conventions/SKILL.md": "sha256:…",
    "agent/connections/donn-github.ts": "sha256:…",
    "agent/lib/donn/config.ts": "sha256:…",
    "agent/lib/donn/env.ts": "sha256:…",
    "agent/sandbox.ts": "sha256:…"
  },
  "agentTs": "patched"
}
```

- **Regenerating** (`donn agent sync`, or the daemon on a persona edit): a donn-owned file whose
  hash no longer matches the manifest stops the sync with `owned-file-edited`, naming the file;
  `--force` overwrites it. Files the new compile no longer produces are removed (a skill removed
  from the persona removes its `skills/donn-<name>/` directory). Files outside the manifest are
  never touched; a new donn path that a template or user file already holds stops the sync with
  `slot-collision` (§3), and `--force` does not override it.
- `agentTs` is `patched` (the template's file, edited once) or `created` (§2).
- *Amended 2026-10-27:* a subagent's `agent.ts` edited for the gateway (§2 "Subagents") is
  listed in `edits`, as `agent/agent.ts` is, never in `files`. `create` edits each subagent once;
  `sync` edits one that does not spread its entry yet (a subagent added later, a gateway added
  later), the one template-owned edit a regeneration makes (`25` §3).
- The manifest holds no secrets and no resolved values beyond what is already in the files.

## 5. The portability report

*Amended 2026-10-25:* the template slugs and sources are corrected, and a GitHub checkout row
is added.

*Amended 2026-10-25 (build):* three additions to the table's facts.

- **Per-user OAuth** (`personal-agent-template`'s `tools/github.ts`, `getToken()` with
  `UserAuthorizationRequiredError`) is a `connect` row, blocking off Vercel: replace the tool with
  your own OAuth or token flow. The template's MCP connections that use `auth: connect(...)` get a
  row of their own.
- **Subagent model strings.** A template whose subagents name AI Gateway models in their own
  `agent/subagents/*/agent.ts` (`eve-llm-council-template`) keeps them: only the top agent's
  `agent.ts` is patched. Off Vercel that is a blocking `ai-gateway` entry asking for
  `AI_GATEWAY_API_KEY` or a model of your own in each subagent.
  *Amended 2026-10-27:* with `models.gateway` the subagents are routed (§2 "Subagents") and the
  entry is not blocking; without one it stays blocking and names `models.gateway` as the fix.
- **The personal-agent advisory.** `personal-agent-template`'s `agent.ts` carries
  `modelOptions.providerOptions.anthropic` (thinking), which applies only to Anthropic models and
  stays in the file when donn replaces `model`; with a non-Anthropic gateway or model the compile
  report carries an advisory saying it is ignored.

`templates()` lists the known templates with the Vercel-only services their code uses, read from
each template's source at the pinned eve version and kept in a table in the adapter.

- **Slugs** are eve.dev's gallery slugs, which differ from the titles: GitHub Project Maintainer
  is `kody-eve-template`, Software Factory `eve-software-factory-template`, Incident
  Investigation Assistant `eve-sre-agent-template`, Coding Agent on Slack
  `eve-coding-agent-template`, Slack Assistant `eve-slack-agent`. The gallery lists twenty.
- **Sources.** eve's repository holds eight templates in `apps/templates/`, each with its own
  `package.json` and `pnpm-lock.yaml`: six of the gallery's (`eve-chat-template`,
  `eve-coding-agent-template`, `eve-company-brain-template`, `eve-voice-template`, and
  `eve-slack-agent` and `eve-discord-agent` under `…-template` directory names, hence
  `repoPath`) and two the gallery does not list (`eve-llm-council-template`,
  `personal-agent-template`). The other fourteen gallery templates, `kody-eve-template` among
  them, live in their own repositories (the gallery links `vercel-labs/kody-eve-template` and
  `vercel-labs/eve-software-factory-template`, for example). Only the repository's templates are
  read at the pinned tag and get table rows; every other slug compiles with
  `portability-unknown` until another source is defined (open question 3). *2026-10-25:* spec 25
  keeps it that way and creates such a template from a local clone as a path template; a
  donn-maintained PR-reviewer template is a later spec (`25`, open question 2).

`compile` turns the services into entries for the agent's target:

| Service | `vercel` | `self-host` / `local` |
|---|---|---|
| Vercel Connect (GitHub, Slack credentials) | fine | blocking: "Bring a GitHub App: set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_WEBHOOK_SECRET", and the same for Slack |
| Vercel Sandbox | fine | not blocking: "Runs on Docker; `donn doctor` checks the daemon". Blocking when the template's sandbox uses a domain allow-list or credential transform: Docker accepts only `allow-all` and `deny-all` |
| GitHub channel sandbox checkout (`github-checkout`, added 2026-10-25) | fine | not blocking, a known limitation: "The GitHub channel checks the repository out into the sandbox only on a firewall-capable backend (Vercel). Here the agent gets the pull request's diff in context but not the repository's files" |
| AI Gateway (a model string in the template) | fine | not blocking: replaced by `lib/donn/config.ts` |
| Vercel Drive, Vercel Daemons | fine | blocking: "No self-hosted equivalent in eve; pick another template or target" |
| Route auth (`vercelOidc()`) | fine | blocking: "Configure Basic, JWT or OIDC auth for the agent's routes" (*2026-10-25:* see the route-auth note below) |

- **The PR reviewer without checkout.** Outside Vercel the reviewer reviews the diff (eve sends
  the changed files' patches and drops bodies of large generated files) against the persona's
  conventions, and cannot read the rest of the repository or run its tests. eve's docs name only
  Vercel as firewall-capable and say the local backend skips checkout; that Docker skips it too
  is inferred (it supports no credential transforms) and checked in `25`'s spike. Comment turns
  start on eve's invocation token (`@<botName>` in the comment), which an `onComment` handler in
  the template's `channels/github.ts` replaces; donn does not change the gate.
- `blank` and path templates list no services; the report then covers only route auth.
  *Amended 2026-10-25 (`25`'s spike):* a path template's services are unknown, so it compiles
  with `portability-unknown` as an unknown slug does (kody, as a path template, uses Connect, a
  Vercel sandbox and the checkout, none of which the report showed).
- *Amended 2026-10-25 (`25`'s spike), route auth.* eve fails closed under `eve start`, and
  `localDev()` opens only under `eve dev`. For `local` and `self-host`, when the template has no
  `agent/channels/eve.ts`, the compile writes one as a donn-owned file: `eveChannel({ auth:
  [donnToken, localDev()] })`, where `donnToken` accepts a bearer token equal to
  `DONN_ROUTE_TOKEN`, read per request (so `eve build` needs no value). Route auth is then
  not blocking for `local` and an advisory for `self-host` ("routes accept a bearer
  `DONN_ROUTE_TOKEN`; put Basic, JWT or OIDC in front before exposing them"). A template with its
  own `channels/eve.ts` keeps the blocking entry, with the two lines to add by hand. `vercel`
  is unchanged (eve's default channel, with `vercelOidc()`).
  *Amended 2026-10-25 (review):* the token check lives in its own donn-owned module,
  `agent/lib/donn/route-auth.ts` (exports `donnToken`), written for `local` and `self-host` whether
  or not the template has a channel; the generated `agent/channels/eve.ts` imports it. A template
  with its own channel therefore needs two lines by hand: `import { donnToken } from
  "../lib/donn/route-auth";` and `donnToken, localDev()` in its `auth: [...]` list (with `localDev`
  imported from `eve/channels/auth`). `vercel` writes neither file.
- `donn agent create` and the GUI show the report before anything is written (`25` §2, `26`).
- A template missing from the table compiles with a `portability-unknown` warning rather than an
  error: eve adds templates faster than donn will release.

## 6. Stack and testing

*Amended 2026-10-25:* layer 1's spike checks the slot layout instead of the directory mount;
golden builds and refusals gain names and collisions.

| Layer | Contents |
|---|---|
| 1 `sdk` | `AgentAdapter`, `TemplateInfo`, `PortabilityEntry` in `@getdonn/adapter-sdk`; the agent half of the conformance kit; a spike against the pinned eve confirming: `instructions/donn.md` composes after the template's root file and among its fragments as §2 says; what `eve build` does with a template file and a donn file that resolve to one skill or connection name (so `slot-collision` matches eve's own rule); the name rule for static connection files (the lowercase rule is documented for dynamic connections); the `@ai-sdk/openai-compatible` and `@ai-sdk/anthropic` majors that build with `ai@^7`; an SSE-only MCP server connecting by URL; the `agent.ts` edit and the created `agent.ts` |
| 2 `compile` | `src/packages/adapters/eve`: field mapping, `lib/donn/config.ts` per gateway type, `sandbox.ts`, connections, skills, knowledge; the report |
| 3 `templates` | the template table and portability entries; the manifest's shape; capability declarations; `docs/capabilities.md` gains an "agent adapters" section |

- **Golden builds** in `test/golden/eve/`: one per gateway type and the two direct providers; a
  persona with stdio, `gateway://` and URL servers; skills with scripts; knowledge pointers;
  self-host with and without a template sandbox; server names that map (`my_db` → `donn-my-db`),
  a bearer secret in `auth` and an API-key secret in `headers`.
- **Refusals and reports:** `model-needs-gateway`; a name eve rejects (`name-unmappable`); two
  servers mapping to one name (`name-collision`); a template file on a donn path
  (`slot-collision`); a packaged skill without `description`; an unknown or out-of-repository
  template (`portability-unknown`); every report entry.
- **The `agent.ts` edit:** fixtures for each template's real `agent.ts` at the pinned version,
  plus files the edit must refuse.
- **Real eve (`DONN_E2E=1`):** compile into a scratch copy of a template, `eve build`, start it
  with a stub OpenAI-compatible gateway that records requests; the agent answers one HTTP-channel
  turn and the gateway saw the call with the configured key and headers.
  *(2026-10-25, build:)* as built it drives `eve dev --no-ui`, not `eve build`; see §2's build note.

## Non-goals

Running, building or deploying (`25`); third-party agent adapters; mapping permissions to eve's
connection tool allow-lists; compiling persona hooks into eve hooks; publishing the persona as an
npm extension package, or generating one per agent (option B, rejected 2026-10-25).

## Open questions

1. **Directory-mount layout.** The eve docs show file mounts and packages in detail and mention
   directory mounts; layer 1's spike confirms the exact layout of `extensions/donn/` at the pinned
   version before the compile is written.
   *Answered 2026-10-25 (eve 0.83.2 docs and discovery code):* there is no such layout. A
   directory mount is `agent/extensions/<name>/extension.ts`, which must default-export an
   installed, built extension package, plus same-named overrides of that package's
   contributions beside it. The contribution layout (`instructions.md`, `skills/`,
   `connections/`) exists only inside an extension package. Resolved by option A (Decisions).
2. **Other agent layouts** (added 2026-10-25). eve also accepts a flat layout (agent files at the
   app root) and workspace members (`agents/<name>/agent/`). Lean: `create` refuses a template
   in either layout (`agent-layout-unsupported`) until one of the known templates uses it.
3. **Templates outside eve's repository** (added 2026-10-25). Fourteen of the twenty gallery
   templates, the GitHub Project Maintainer among them, live in their own repositories with no
   eve version tag. Should the adapter's table name each one's repository and a pinned commit,
   read and checked like the repository's templates (`25` §2, open question 1)? Until then they
   compile with `portability-unknown` and `25` can create them only as path templates.
4. **Checkout on Docker** (added 2026-10-25). If `25`'s spike confirms Docker skips the GitHub
   channel's checkout, should the PR reviewer's persona gain a skill or connection that reads
   repository files through the GitHub API instead, or is a diff-only review the documented
   self-host behaviour?
