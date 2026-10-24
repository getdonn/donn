# 23 — Models and agents: personas that power project agents

> Status: design, 2026-10-24. Opens a new track, **agents and the GUI**: project agents built on
> personas, with eve (`vercel/eve`, beta) as the first agent framework, and a web and desktop GUI.
> The track starts after the first `npm publish` and does not block the control plane. Four
> specs: this one (the `models` and `agents` fields), `24-adapter-eve.md` (the compile),
> `25-agent-runner.md` (`donn agent`: create, run, build, deploy) and `26-gui.md` (the GUI).
> Builds on `02` (merge semantics, locks), `05` (adapter SDK), `13` (capability matrix) and
> `14`–`16` (daemon). Built as a `gh stack`: layer 0 is specs 23–26 and their amendments.
> *Amended 2026-10-24:* personal and private control-plane details removed before the repository went public (spec 27).

## Intent

donn already carries what a coding agent uses: instructions, skills, MCP servers and knowledge
pointers. The same persona can power an agent that runs for the project outside any editor: a PR
reviewer that reviews against the team's conventions, issue triage, a weekly digest. This track
lets a user build such an agent from a template, wired to the persona, and run it locally,
self-host it, or deploy it to Vercel, with every model call going through the organisation's
gateway when there is one.

The maintainer's constraints (2026-10-24):

- **Agents are an option.** Nothing else in donn requires eve or an agent; a user who never
  creates one sees two optional fields and one command group.
- **Vercel is one target, never the only one.** Enterprises may be unable to use it and host the
  agent themselves.
- **Model calls follow the organisation's gateway when one exists.** A gateway is never required;
  OSS and free users mostly will not run one.
- **A GUI drives adoption.** Web and desktop apps for managing donn outside the CLI are planned;
  the agent builder is one of their workflows (`26`).

The agent the four specs are measured against: **a PR reviewer that reviews against the project
persona.** The persona already holds the team's conventions, skills and MCP pointers, so the
agent is useful on day one with no new authoring, and it is used by everyone on the team, not
only by whoever set it up.

## Facts this design rests on

From the eve docs (`vercel/eve` through Context7, and `eve.dev/templates`; read 2026-10-24; eve is
beta, before 1.0):

- **An agent is a directory.** `agent/` holds `instructions.md` (required), `agent.ts` (model and
  runtime config), `skills/`, `tools/`, `hooks/` (TypeScript modules), `connections/`,
  `channels/`, `schedules/`, `subagents/`, `extensions/`, `lib/` (import-only), `sandbox.ts` and
  `memory.ts`.
- **Extensions** are mounted from a file or a directory under `agent/extensions/<name>`. They
  contribute instructions, skills, tools, connections, hooks, channels, schedules and subagents;
  the mount name prefixes the contributed names (`crm__search`). An extension cannot declare agent
  config (the model), memory or a sandbox: those stay with the consuming agent.
- **Skills** are flat Markdown files or packaged `SKILL.md` directories with sibling files; eve
  ignores frontmatter it does not use, "so skills authored for other Agent Skills clients remain
  importable". Supporting files need a sandbox.
- **Connections** are HTTP MCP (`defineMcpClientConnection`) and OpenAPI, with credentials in
  headers or `getToken`. No stdio MCP.
- **Models.** `model` in `agent.ts` takes a string, which routes through the Vercel AI Gateway, or
  an AI SDK `LanguageModel`, which calls a provider directly: `createOpenAICompatible({ baseURL
  })` for any OpenAI-compatible endpoint (LiteLLM, Bifrost, Ollama, Bedrock's OpenAI endpoint),
  `eve/models/anthropic` and `eve/models/openai` helpers for the two direct providers.
- **Hosting.** Vercel (`eve deploy`: Vercel Workflow, Cron and Sandbox) or self-hosted: `eve
  build` writes a Node server to `.output/` and `eve start` runs it; durable runs use the local
  Workflow world or a custom one (`experimental.workflow.world`, e.g.
  `@workflow/world-postgres`); the sandbox runs on Docker. Outside Vercel, routes need Basic, JWT
  or generic OIDC auth (`vercelOidc()` is not enough).
- **GitHub channel.** Webhooks arrive at `/eve/v1/github`; a pull-request turn checks the repo out
  into the sandbox with the diff in context; comment turns are gated to owners, members and
  collaborators by default. On Vercel, Vercel Connect manages the GitHub App credentials; anywhere
  else the user brings a GitHub App (private key and webhook secret).
- **CLI.** `eve init [target] --non-interactive`; `eve add <item> --non-interactive` prints NDJSON
  events and exits 0 (done), 1 (failed) or 2 (needs an answer: the final event carries a question
  key and a continuation command); `eve link` and `eve deploy` have `--non-interactive --yes`
  forms. A running agent streams session events as NDJSON at `GET
  /eve/v1/session/{id}/stream`.
- **Templates.** Twenty at `eve.dev/templates` (among them Software Factory, GitHub Project
  Maintainer, Coding Agent on Slack, Incident Investigation). They are standalone source projects
  in `apps/templates/<slug>` of the eve repo, each with its own `package.json` and lockfile; `eve
  init` has no template flag. Several name Vercel-only services: Vercel Connect, Sandbox, Drive,
  Daemons, AI Gateway.
- **`eve init` and Git.** On a new directory `eve init` runs `git init`; on an existing package it
  adds `agent/` and the missing dependencies only.

The 2026-10-22 evaluation (during spec 18) put eve at "possible later, as a third-party plugin
adapter". This track brings it forward as a first-party adapter, still optional.

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| A persona compiles to an eve **extension** inside a thin generated agent; donn owns only its own files (`24`) | Compile the whole eve project into a build directory; scaffold once and hand it over | Repo automation nearly always needs a custom tool or hook, which a full compile cannot hold; a one-off scaffold drifts from the persona from its first edit |
| `agents` is a field of the persona spec | A standalone `agent.yaml` naming a persona | Agents then layer like everything else: a team defines a reviewer once, an org locks the model gateway |
| An agent takes the persona it is resolved in, not the declaring layer's | The declaring layer's persona | One team-layer entry gives every repo a reviewer that knows that repo's rules |
| Declaring an agent does not create it; `donn agent create` does | Materialise every declared agent in every repo | An org-wide declaration would write files into every repo |
| Channels and triggers stay in eve code, owned by the template | Model eve's channels in the YAML | eve's channel API is beta and moving; the YAML would chase it for little gain |
| `models` is top-level and lockable | `models` under each agent | Gateway routing is a fact about the organisation, not an agent; Claude Code and Codex can consume it later |
| The engine and a basic local builder are open source; organisation-wide agent governance is private | Builder only in the paid console; everything open; everything paid | Mirrors the persona split: building and running your own is open, governing who deploys what is paid. Adoption is the GUI's reason to exist |
| Local and self-host are first-class targets; Vercel is optional | Vercel only | Enterprise hosting constraints |
| GUI → daemon → eve CLI, every step also a `donn agent` command (`25`, `26`) | The GUI drives the eve CLI directly | A web page cannot start processes; CLI parity (`03`); donn owns the persona, secrets and gateway parts eve knows nothing about |
| eve is pinned per agent as a project-local dependency | A global eve CLI | Beta churn; reproducible builds |

## 1. `models`

New in `@getdonn/spec`, allowed in persona files and the user overlay (a solo developer may run
their own LiteLLM):

```yaml
models:
  gateway:                       # optional; absent = call the provider directly
    type: openai-compatible      # openai-compatible | anthropic | vercel-ai-gateway
    baseURL: https://llm.corp/v1
    apiKey: secret://vault/llm/gateway-key
    headers:                     # optional; e.g. a Bifrost virtual key
      x-bf-vk: secret://vault/llm/virtual-key
  default: anthropic/claude-sonnet-5-5
```

| Field | Meaning |
|---|---|
| `gateway.type` | `openai-compatible`: an OpenAI-compatible endpoint (LiteLLM, Bifrost, Ollama). `anthropic`: an Anthropic-compatible endpoint. `vercel-ai-gateway`: the Vercel AI Gateway, by name |
| `gateway.baseURL` | Required for the first two types; not allowed for `vercel-ai-gateway` |
| `gateway.apiKey` | A secret ref. Optional (some gateways authenticate by network or header) |
| `gateway.headers` | Map of header name → string or secret ref |
| `default` | The model id, as the gateway knows it when there is one. Without a gateway it is `<provider>/<model>`; `24` lists the providers that work without a gateway |

- Without a gateway, the provider's key is its usual environment variable (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`), supplied through the agent's `env` (§2). `models` stays about routing.
- `models` is a capability field (§4). In this track only `adapter-eve` consumes it.

## 2. `agents`

New in `@getdonn/spec`, persona files only. The user overlay cannot carry it
(`agents-in-overlay`): an agent belongs to a project or a team, not to one person's machine.

```yaml
agents:
  define:
    pr-reviewer:
      template: eve:github-project-maintainer
      target: self-host
      path: agents/pr-reviewer
      model: anthropic/claude-opus-5-5
      env:
        GITHUB_APP_ID: "123456"
        GITHUB_APP_PRIVATE_KEY: secret://vault/gh/reviewer-key
        GITHUB_WEBHOOK_SECRET: secret://vault/gh/reviewer-webhook
  remove: [old-triage-bot]
```

| Field | Meaning |
|---|---|
| key | The agent's name: lowercase kebab-case, at most 64 characters (eve's own name limit) |
| `template` | `eve:<slug>` (a template from `eve.dev/templates`, at the eve version donn pins), `eve:blank` (`eve init`), or a path relative to the persona file, as `instructions[].file` is (a team's own eve template). The prefix names the agent adapter (`24` §1); a path template is an eve template in this track |
| `target` | `local`, `self-host` or `vercel` (`25` §4). `25` adds `github-actions` if its spike succeeds |
| `path` | Project-relative directory of the eve project. Default `agents/<name>`. Must stay inside the project and outside `.donn/` |
| `model` | Optional; overrides `models.default` for this agent. Still routed through `models.gateway` |
| `env` | Map of environment variable → string or secret ref, for what the template's code reads. Names are uppercase; the `DONN_` prefix is reserved |

- **Resolved where it is used.** An agent compiles against the persona resolved for the project
  that creates it, whichever layer declared it.
- **Declared is not created.** `donn agent list` shows inherited agents as available; only `donn
  agent create <name>` (or the GUI's Create) writes an eve project (`25`). When the agent is not
  declared yet, `create` with `--template` and `--target` adds the `agents.define.<name>` entry to
  the project persona first (`25` §2).
- No per-agent narrowing of the persona (excluding a skill or a server for one agent) in this
  track; see Open questions.

## 3. Merge rules and locks

Added to the table in `02`:

| Field | Type | Merge rule |
|---|---|---|
| `models.gateway` | object | **replaced whole** by a child (opaque objects are replaced, not deep-merged) |
| `models.default` | scalar | child wins |
| `agents.define` | map | shallow merge by key; a child entry **replaces** the whole agent, as `mcp.servers` entries do |
| `agents.remove` | set | deletes agents inherited so far; a child can re-add. The resolver warns on each removal |

- **Lock paths.** `models`, `models.gateway`, `models.default`, `agents.define` and
  `agents.define.<name>` are valid lock paths (`isValidLockPath` gains the two roots). Locking
  `models.gateway` at the org layer is how an organisation says "every model call goes through our
  gateway"; a lower layer that sets its own fails resolution, as any locked path does.
- `agents.remove` of a locked agent fails resolution, naming both layers.
- In OSS a lock is advisory, enforced when a persona resolves; server-side enforcement at publish
  is the control plane's, as for every other lock.

## 4. The IR and the capability matrix

- The IR gains `models` (an object, default `{}`) and `agents` (a map of name → resolved agent,
  default `{}`), with provenance like every other field. `IR_VERSION` does not change: added
  optional fields with defaults, as `policy` was in spec 21.
- **`models` is a fixed capability field** (`FIXED_CAPABILITY_FIELDS` in the adapter SDK), so
  every harness adapter declares it (spec 13). In this track:

  | Adapter | `models` | Note |
  |---|---|---|
  | `claude-code` | none | "Not yet: Claude Code reads a gateway from ANTHROPIC_BASE_URL; a later spec" |
  | `codex` | none | "Not yet: Codex takes a model_provider; a later spec" |
  | `agents-md` | none | "AGENTS.md is text; model routing is the harness's" |

  A persona that sets `models` therefore shows a `models` entry in those adapters' compile
  reports. That is accurate and prompts the later spec that makes `models` useful outside agents.
- **`agents` is not a capability field.** No harness compiles it; it is consumed by `donn agent`,
  like `extends` and `locks`. `docs/capabilities.md` is regenerated with the new row.

## 5. Amendments to earlier docs (made with this spec)

- `00-handoff.md`: the desktop decision is revised (the GUI, `26`); agents and eve join the
  decisions table and the glossary.
- `01-vision-and-wedge.md`: agents and the GUI join the product surfaces.
- `02-persona-spec.md`: a pointer to this spec for `models` and `agents`.
- `03-architecture.md`: `adapters/eve`, `ui` and `desktop` in the components table; the daemon's
  loopback HTTP bridge and agent runs.
- `04-roadmap.md`: the track and its place after the first `npm publish`.
- `CLAUDE.md`: 23–26 in the reading list.

## 6. Stack and testing

| Layer | Contents |
|---|---|
| 0 `spec` | specs 23–26 and the amendments in §5 (planning only) |
| 1 `fields` | `models` and `agents` in `@getdonn/spec`: zod schemas, JSON Schema export, the overlay refusal, name and path rules |
| 2 `resolve` | merge rules, lock paths, `agents.remove` warnings, the IR fields and provenance, `explain` output; fixtures |
| 3 `matrix` | `models` in `FIXED_CAPABILITY_FIELDS`; declarations in `claude-code`, `codex` and `agents-md`; `docs/capabilities.md` regenerated; changesets |

- **Fixtures** (`src/packages/resolver/fixtures/`, the executable merge spec): a gateway replaced
  whole; `models.default` overridden; an agent replaced by key; `agents.remove` with its warning;
  a locked `models.gateway` changed below (error); a locked agent removed (error); `agents` in the
  overlay (error); a `path` outside the project (error); an agent resolved in two projects gets
  two different personas.
- **Conformance kit:** a harness adapter that does not declare `models` fails, like any other
  fixed field.

## Non-goals

Model routing for Claude Code and Codex (a later spec; this one only makes them report it);
narrowing the persona per agent; agent frameworks other than eve (the `AgentAdapter` contract in
`24` leaves room for them); organisation-wide agent governance (a private-repo spec: who may
create or deploy which agents, against which gateway, with an inventory of running agents).

## Open questions

1. **Per-agent narrowing.** Should an agent be able to drop a skill or MCP server the persona
   carries ("the reviewer does not need the deploy server")? Lean: wait for a real case; the
   compile report already shows what each agent receives.
2. **`models` for harnesses.** Claude Code (`ANTHROPIC_BASE_URL`, managed `env`) and Codex
   (`model_provider`) can both route through a gateway. Worth a spec of its own once agents are
   built, because it makes `models` useful to every user with a gateway.
