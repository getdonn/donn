# 24 — `adapter-eve`: a persona compiled into an eve agent

> Status: design, 2026-10-24. Track "agents and the GUI", second spec (order: 23, 24, 25, with 26
> in parallel). Builds on `23` (the `models` and `agents` fields; its "Facts" section is the eve
> research this spec relies on), `05` (adapter SDK, compile report, conformance kit), `11`
> (knowledge pointers as text) and `13` (every field declared). Built as a `gh stack` after `23`'s
> layers.

## Intent

Turn one resolved agent (a persona plus an `agents.define` entry plus `models`) into the files
that make an eve project run that persona: its instructions, skills and MCP servers, with the
model routed through the organisation's gateway. The adapter is pure, like every adapter: it
returns files and reports, and `donn agent` (`25`) carries out the side effects. It never owns the
whole eve project; the template and the user own everything donn does not generate, so custom
tools, hooks and channels live next to donn's files and survive every regeneration.

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| A new `AgentAdapter` contract in `@getdonn/adapter-sdk`, beside `HarnessAdapter` | eve as a `HarnessAdapter`; an `agent?` hook on `HarnessAdapter` | An agent is not a harness session: `switch`, `launch` and live refresh do not apply, and `donn switch` would offer eve as a harness. A separate contract keeps both small, and leaves room for other agent frameworks later |
| The persona becomes a **directory extension** mounted at `agent/extensions/donn/` | A published npm extension package per persona; files written straight into `agent/skills/` and `agent/connections/` | A local mount needs no publishing; the mount keeps donn's files in one folder with one name prefix, apart from the template's |
| donn owns `agent/lib/donn/` and the extension; `agent.ts` stays the template's, with a one-time edit at create | donn owns `agent.ts` | Templates put real settings in `agent.ts` (compaction, workflow world, build options); owning it would erase them on every regeneration |
| An ownership manifest with a hash per file; a hand-edited donn file stops regeneration | Overwrite donn's files silently | The same rule as overlays and managed bundles: never clobber a hand edit without `--force` |
| The portability report is a static table in the adapter, per template and target | Discover it from the template's code; no report | It must be shown before anything is created; a table is reviewable and tested |

## 1. The `AgentAdapter` contract

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
  project: { hasSandbox: boolean };
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
  slug: string;                       // "github-project-maintainer"
  title: string;
  /** Vercel-only services the template's code uses. */
  services: VercelService[];          // "connect" | "sandbox" | "drive" | "daemons" | "ai-gateway"
}

interface PortabilityEntry {
  target: "local" | "self-host" | "vercel";
  service: VercelService;
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
  `secretEnv`; `templates()` slugs are unique.
- Loading: first-party only in this track. Third-party agent adapters can follow the plugin rules
  of spec 08 later; the contract is ready for it.

## 2. What the compile writes

```
agents/pr-reviewer/                    (the eve project; `25` creates it from the template)
  package.json                         template-owned; `25` pins eve in it
  agent/
    agent.ts                           template-owned; `25` edits it once (below)
    instructions.md                    template-owned: the agent's own role
    channels/github.ts                 template-owned; the user may edit it
    tools/…  hooks/…                   template- or user-owned
    lib/donn/config.ts                 donn: model and runtime settings for the target
    lib/donn/env.ts                    donn: the env names the extension reads, checked at start
    extensions/donn/
      instructions.md                  donn: the persona's instructions
      skills/<name>/SKILL.md …         donn: the persona's skills
      connections/<name>.ts            donn: the persona's HTTP MCP servers
    sandbox.ts                         donn, only for `self-host` when the template has none
  .donn/agent.json                     donn: the ownership manifest (§4)
```

**The edit to `agent.ts`.** `donn agent create` (`25` §2) edits the template's `agent.ts` once:
it imports `donn` from `./lib/donn/config` and spreads it as the last property of the
`defineAgent({...})` call, removing a literal `model` property if there is one. The edit uses the
TypeScript parser and refuses (`agent-ts-unrecognised`, with the two lines to add by hand) unless
the file has exactly one default-exported `defineAgent` call with an object literal. Regeneration
never touches `agent.ts` again; `donn doctor` warns when it no longer spreads `donn`, because the
gateway is then no longer enforced for that agent.

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
  variable is added to the env the agent needs (`25` §4). `local` and `vercel` leave the world to
  eve's default for the host.
- Any added provider package (`@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`,
  `@workflow/world-postgres`) is a dependency `25` adds to the agent's `package.json`, pinned.

**`sandbox.ts`** (self-host only, and only when the template authored none): selects
`DockerSandbox.environment()` from `eve/sandbox/docker` explicitly, because a production build
outside Vercel without a reachable Docker daemon records no sandbox provider and fails.

## 3. Field mapping

| Persona field | eve output | Support | Note |
|---|---|---|---|
| `instructions` | `extensions/donn/instructions.md`, fragments in resolved order | native | The template's `agent/instructions.md` stays the agent's role; the persona's text is the project context |
| `skills` | `extensions/donn/skills/<name>/` (the `SKILL.md` directory, copied whole) | native | caveat: supporting `scripts/` run only where the agent has a sandbox, which is eve's rule |
| `mcp.servers` (url) | `extensions/donn/connections/<name>.ts` with `defineMcpClientConnection({ url, description, headers })` | native | caveat: stdio servers and `gateway://` refs are dropped (below) |
| `mcp.servers` (stdio) | — | (item) dropped | "eve connects to HTTP MCP and OpenAPI only" |
| `mcp.servers` (`gateway://`) | — | (item) dropped | The same reason as the other adapters until gateway resolution exists |
| `knowledge` | pointer lines in `extensions/donn/instructions.md`; an `mcp://<server>` pointer names the matching connection | advisory | As `agents-md` renders it (spec 11) |
| `secrets` | `process.env.DONN_SECRET_<n>` reads; `secretEnv` maps each to its ref | native | Values reach the process at run or deploy time (`25` §5) |
| `permissions.allow\|deny\|ask` | — | none | "Harness permission rules do not map to eve; eve's tool allow-lists per connection are a later mapping" |
| `hooks.*` | — | none | "eve hooks are TypeScript modules; author them in the agent's hooks/" |
| `policy` | — | none | "Managed policy is harness enforcement; eve has no managed surface" |
| `models` | `lib/donn/config.ts` | native | — |
| `targets.eve` | `contextWindow` (above); unknown keys are reported | native | The per-compiler escape hatch, as for other adapters |

- **Connection descriptions.** eve routes on a connection's `description`. A persona's MCP server
  has none, so donn writes "`<name>` MCP server from persona `<id>`" unless
  `targets.eve.connections.<name>.description` gives one. The report does not flag this; the
  conformance kit checks every connection has a description.
- **Secrets in headers.** A header whose value is a secret ref becomes `process.env.DONN_SECRET_<n>`
  in the connection file. `transport: sse` is passed through if eve's MCP client supports SSE at
  the pinned version (checked in layer 1); otherwise the server is dropped with that reason.
- **Names.** Contributed names carry eve's `donn__` mount prefix where eve applies one. Skill and
  connection file names follow eve's rules (ASCII letters, digits, `_` and `-`, at most 64);
  a persona name eve rejects is dropped with the reason.

## 4. The ownership manifest

`<agent dir>/.donn/agent.json`, committed with the project:

```json
{
  "agent": "pr-reviewer",
  "persona": "project/payments-api",
  "adapter": "eve",
  "frameworkVersion": "0.82.0",
  "template": "eve:github-project-maintainer",
  "target": "self-host",
  "files": { "agent/lib/donn/config.ts": "sha256:…", "…": "…" },
  "agentTs": "patched"
}
```

- **Regenerating** (`donn agent sync`, or the daemon on a persona edit): a donn-owned file whose
  hash no longer matches the manifest stops the sync with `owned-file-edited`, naming the file;
  `--force` overwrites it. Files the new compile no longer produces are removed (a skill removed
  from the persona leaves the extension). Files outside the manifest are never touched.
- The manifest holds no secrets and no resolved values beyond what is already in the files.

## 5. The portability report

`templates()` lists the known templates with the Vercel-only services their code uses, read from
each template's source at the pinned eve version and kept in a table in the adapter. `compile`
turns the services into entries for the agent's target:

| Service | `vercel` | `self-host` / `local` |
|---|---|---|
| Vercel Connect (GitHub, Slack credentials) | fine | blocking: "Bring a GitHub App: set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_WEBHOOK_SECRET", and the same for Slack |
| Vercel Sandbox | fine | not blocking: "Runs on Docker; `donn doctor` checks the daemon" |
| AI Gateway (a model string in the template) | fine | not blocking: replaced by `lib/donn/config.ts` |
| Vercel Drive, Vercel Daemons | fine | blocking: "No self-hosted equivalent in eve; pick another template or target" |
| Route auth (`vercelOidc()`) | fine | blocking: "Configure Basic, JWT or OIDC auth for the agent's routes" |

- `blank` and path templates list no services; the report then covers only route auth.
- `donn agent create` and the GUI show the report before anything is written (`25` §2, `26`).
- A template missing from the table compiles with a `portability-unknown` warning rather than an
  error: eve adds templates faster than donn will release.

## 6. Stack and testing

| Layer | Contents |
|---|---|
| 1 `sdk` | `AgentAdapter`, `TemplateInfo`, `PortabilityEntry` in `@getdonn/adapter-sdk`; the agent half of the conformance kit; a spike checking the directory-mount layout, MCP SSE support and the `agent.ts` edit against the pinned eve |
| 2 `compile` | `src/packages/adapters/eve`: field mapping, `lib/donn/config.ts` per gateway type, `sandbox.ts`, connections, skills, knowledge; the report |
| 3 `templates` | the template table and portability entries; the manifest's shape; capability declarations; `docs/capabilities.md` gains an "agent adapters" section |

- **Golden builds** in `test/golden/eve/`: one per gateway type and the two direct providers; a
  persona with stdio, `gateway://` and URL servers; skills with scripts; knowledge pointers;
  self-host with and without a template sandbox.
- **Refusals and reports:** `model-needs-gateway`; a name eve rejects; an unknown template;
  every report entry.
- **The `agent.ts` edit:** fixtures for each template's real `agent.ts` at the pinned version,
  plus files the edit must refuse.
- **Real eve (`DONN_E2E=1`):** compile into a scratch copy of a template, `eve build`, start it
  with a stub OpenAI-compatible gateway that records requests; the agent answers one HTTP-channel
  turn and the gateway saw the call with the configured key and headers.

## Non-goals

Running, building or deploying (`25`); third-party agent adapters; mapping permissions to eve's
connection tool allow-lists; compiling persona hooks into eve hooks; publishing the persona as an
npm extension package.

## Open questions

1. **Directory-mount layout.** The eve docs show file mounts and packages in detail and mention
   directory mounts; layer 1's spike confirms the exact layout of `extensions/donn/` at the pinned
   version before the compile is written.
