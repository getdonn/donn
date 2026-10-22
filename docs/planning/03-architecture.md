# 03 — Top-Level Architecture

> Status: draft v0, 2026-10-20. One document to see the whole system; `04-roadmap.md` will slice
> it into phases. Working name Hatrack; `@hatrack/*` package names are placeholders.
> Amended 2026-10-20: Hatrack is taken. Every `hatrack` identifier below maps to the code
> placeholder `zzpersona` (`@zzpersona/*`, `zzpersonad`, …); see `00-handoff.md` → "Naming".

## Principles

1. **Harness-neutral core.** The persona spec, resolver, and resolved intermediate representation
   (IR) know nothing about any specific AI tool. Claude Code is the *first adapter*, not a
   dependency. Codex, Antigravity, Cursor, Gemini CLI, Copilot, etc. are peers.
2. **Adapters are honest about loss.** Every harness expresses a different subset of a persona.
   An adapter declares its capability matrix and every compile emits a report of what it could
   not map. No silent drops.
3. **Compile, don't sync.** Generated harness config is a build artifact: reproducible from
   persona sources, gitignored, never hand-edited.
4. **Policy travels with the persona.** Locks, deny-lists, and gateway routing are part of the
   resolved IR, so every adapter enforces the same policy to the extent the harness allows, and
   reports where it cannot.
5. **Local-first, control-plane-optional.** Everything works from files + git. The control plane
   adds publishing, identity, policy enforcement, and audit; it never becomes a runtime dependency
   of the developer's session.
6. **Secrets are references.** Persona files contain `secret://` refs. Values are resolved by a
   provider at compile time into gitignored output only.

## System overview

```
                 ┌──────────────────────────── sources ────────────────────────────┐
                 │  org / area / team personas    project .hatrack/    ~/.hatrack/  │
                 │  (git repo  or  control plane)  persona.yaml         user layer  │
                 └───────────────┬─────────────────────┬───────────────────┬────────┘
                                 ▼                     ▼                   ▼
                          ┌────────────────────────────────────────────────────┐
                          │                  @hatrack/resolver                 │
                          │  load → DAG → C3 linearize → merge → locks → IR    │
                          │              + provenance + warnings               │
                          └───────────────────────────┬────────────────────────┘
                                                      ▼
                                      ┌──────────────────────────────┐
                                      │   Resolved Persona (IR)      │  ← harness-neutral
                                      │   @hatrack/spec              │
                                      └──────┬───────┬───────┬───────┘
          ┌──────────────┐                   │       │       │                  ┌──────────────┐
          │ secrets      │◄── resolve refs ──┤       │       ├── resolve names ─►│ MCP gateway  │
          │ providers    │                   │       │       │                   │ adapters     │
          └──────────────┘                   ▼       ▼       ▼                   └──────────────┘
                              ┌──────────┐ ┌───────┐ ┌─────────────┐ ┌────────┐ ┌─────────┐
                              │claude-   │ │codex  │ │antigravity  │ │cursor  │ │agents-md│ ...
                              │code      │ │       │ │             │ │        │ │(generic)│
                              └────┬─────┘ └───┬───┘ └──────┬──────┘ └───┬────┘ └────┬────┘
                                   ▼           ▼            ▼            ▼           ▼
                              build/<persona>/<harness>/  → activate() → the running tool

   ┌──────────────── CLI (@hatrack/cli) ────────────────┐   ┌──── in-harness UX ────┐
   │ init · resolve · compile · switch · doctor · diff  │   │ claude-code mod,       │
   │ publish · login · explain                          │   │ per-harness equivalents│
   └─────────────────────────┬──────────────────────────┘   └────────────────────────┘
                             │ (optional)
                             ▼
   ┌──────────────── control plane (private repo) ───────────────────────────────┐
   │ persona registry · versions · RBAC/OIDC · policy engine · audit · drift     │
   │ gateway integration · web console · Postgres · Docker + Helm                │
   └──────────────────────────────────────────────────────────────────────────────┘
```

## Components

### Core (OSS, `packages/`)

| Package | Responsibility | Key interface |
|---|---|---|
| `spec` | Persona schema (zod → JSON Schema export), IR types, versioning (`apiVersion`) | `Persona`, `ResolvedPersona`, `validate()` |
| `resolver` | Load sources, build `extends` DAG, linearize, merge per field rules, enforce locks, emit provenance | `resolve(ref, opts) → { ir, provenance, warnings }` |
| `store` | Where personas come from. Pluggable: `store-local` (dirs + git), `store-remote` (control plane client) | `get(ref)`, `list()`, `publish()` |
| `secrets` | Provider interface + built-ins (env, OS keychain); 1Password, HashiCorp Vault, AWS SM as provider packages (amended 2026-10-21, `08`) | `resolve(secretRef) → string` |
| `gateway` | Resolve `gateway://name` MCP refs to concrete server configs via a gateway's API; enforce allowed set | `GatewayAdapter.resolve(name)`, `.list()` |
| `adapter-sdk` | The harness adapter contract (below), shared test harness, capability-matrix types | `HarnessAdapter` |
| `adapters/*` | One package per harness | implements `HarnessAdapter` |
| `cli` | User entry point; orchestrates resolve → compile → activate. Thin: talks to the daemon when it is running, falls back to in-process otherwise | commands |
| `daemon` (`hatrackd`) | Long-running local service: sync, cache, watchers, local API. See "Local daemon" below | local HTTP/unix-socket API |
| `mod-claude-code` | In-session UX for Claude Code (status line, `/persona`, nudges); a client of the daemon | mod |
| `desktop` | Tray/menubar app (Tauri or Electron) over the daemon: current persona, switch, sync status, drift, logs. Optional; no logic of its own | daemon client |

### Enterprise (private repo)

| Component | Responsibility |
|---|---|
| `control-plane` | HTTP API: registry, versions, publish with server-side lock enforcement, RBAC, OIDC, audit log, drift reports |
| `console` | Web admin UI over the control plane |
| `policy` | Org/area/team policy authoring; what may be locked, who may publish at which layer |
| `gateway-integrations` | Deeper integrations than the OSS adapter: sync allowed-tool sets from Bifrost etc. into persona policy |
| `deploy` | Dockerfile, Helm chart, reference Terraform |

The enterprise repo depends on **published** `@hatrack/spec`, `@hatrack/resolver`, `@hatrack/store`
packages. That dependency direction is the boundary and is non-negotiable.

## The harness adapter contract

> *Superseded 2026-10-21 by `05-adapter-sdk.md`:* `compile` and `activate` are pure, and
> `activate` returns a plan of steps (`launch`, `overlay`) that the CLI carries out;
> `deactivate()` and `current()` move to the CLI; `detect` sees the machine only through a
> probe. The sketch below is kept as the original record.

This is what makes "not limited to Claude Code" real. Every adapter implements:

```ts
interface HarnessAdapter {
  id: string                                   // "claude-code" | "codex" | "antigravity" | ...
  detect(): Promise<Detection>                 // installed? version? config root?
  capabilities(): CapabilityMatrix             // which IR fields it can express, and how
  compile(ir: ResolvedPersona, ctx): Promise<{ files: FileTree; report: CompileReport }>
  activate(build: BuildRef, ctx): Promise<ActivationResult>   // make it the live config
  deactivate(build: BuildRef, ctx): Promise<void>
  current(ctx): Promise<BuildRef | null>       // which persona is live for this harness
  inSessionUX?: InSessionUX                    // optional: mod/extension hooks if the harness has them
}
```

`CompileReport` lists every IR element that was **dropped**, **approximated**, or **weakened**
(e.g. "harness has no deny-list; `permissions.deny` emitted as instructions text only"). The CLI
prints it; the control plane stores it so policy owners can see where enforcement is advisory.

### Capability matrix (to be filled by spikes — see `spikes/`)

*Amended 2026-10-21 (spec 13): superseded by `docs/capabilities.md`, generated from the adapters'
own matrices by `zzpersona capabilities --markdown`. The tables below are kept as the planning
record.*

| IR field | claude-code | codex | antigravity | cursor | gemini-cli | agents-md (generic) |
|---|---|---|---|---|---|---|
| instructions | hook/system-prompt (not plugin) | native (`AGENTS.md`) | ? | native (rules) | native (`GEMINI.md`) | native |
| skills | native | ? | ? | partial | ? | text only |
| mcp.servers | native | native | ? | native | native | — |
| permissions allow/deny/ask | native (settings, not plugin) | partial | ? | partial | partial | text only |
| hooks | native | ? | ? | — | ? | — |
| secrets refs | via env / `${VAR}` | via env | ? | via env | via env | — |
| in-session switch UX | mod (status/nudge; switch needs user reload) | ? | ? | ? | ? | — |

"?" means a spike is needed. The `agents-md` adapter is the lowest common denominator and should
exist early: it covers several harnesses at once and makes the "honest loss" story concrete.

*Amended 2026-10-21 (spike, `spikes/agents-md/FINDINGS.md`, Codex 0.163.0 and Copilot CLI
1.0.78 ran):* `AGENTS.md` is only read **from the repo**. No tested tool reads one from an
out-of-repo location without moving its whole config home (which moves its login), so
`agents-md` is a file-overlay target for projects that commit their persona. Both Codex and
Copilot accept a full persona **per launch**, outside the repo, so the relaunch strategy
generalizes beyond Claude Code:

| IR field | codex (per launch) | copilot CLI (per launch) |
|---|---|---|
| instructions | `-c developer_instructions=…` (ran) | `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` with `*.instructions.md` — **not** `AGENTS.md` (ran) |
| mcp.servers | `-c mcp_servers.<n>={…}` (ran) | `--additional-mcp-config @file` (ran) |
| permissions | partial: `approval_policy`, `sandbox_mode` | `--allow-tool` / `--deny-tool` globs (ran) |

Persona instructions are added alongside the repo's own `AGENTS.md`, never in place of it.

### Activation strategies

How `activate()` makes a build live varies by harness and is the riskiest per-adapter decision:

- **config-root swap** — point the harness at a per-persona config directory (cleanest isolation;
  may lose the user's unrelated settings/history unless layered).
- **enable/disable toggle** — install all persona builds as plugins/extensions, flip which is
  enabled (keeps user's other config; depends on the harness supporting runtime toggles).
- **launch-flag injection** — wrap the harness binary with flags (`--mcp-config`, `--settings`,
  etc.); simplest, no in-session switching.
- **file overlay** — write generated files into the project's expected config paths (works
  everywhere; pollutes the repo unless gitignored; risk of clobbering hand edits).

Each adapter documents which it uses and why. Claude Code specifics: see Appendix A.

## Local daemon (`hatrackd`)

Everything that should happen *without a terminal open* lives here, and every UI (CLI, mod, IDE
extension, desktop tray, eventually the web console via a loopback token) is a client of it.
It is the one piece of the system that is "always running on the dev's machine", which is the
real reason a desktop presence exists at all.

Responsibilities:

- **Sync.** Pull published personas and ancestors from the control plane on an interval / push;
  keep the local cache (`~/.hatrack/cache/`) warm so `switch` is instant and works offline.
- **Pre-build.** Resolve + compile personas the user is likely to need (recently used, cwd-matched)
  ahead of time, per installed harness.
- **Watchers.** Watch persona source dirs and project `.hatrack/` files; rebuild on change;
  optionally trigger harness-specific reload where a harness exposes one.
- **Drift + telemetry (opt-in).** Compute local-vs-published diffs and report to the control plane;
  nothing leaves the machine in OSS mode unless the user is logged in and opted in.
- **Local marketplace / registry server.** Serve persona builds to harnesses that prefer a
  URL or marketplace over a directory (Claude Code local marketplace; others as discovered).
- **Secrets broker.** Hold short-lived resolved secrets in memory so builds on disk can reference
  `${HATRACK_SECRET_X}` env vars instead of materialising values (reduces secrets-on-disk).
- **Harness detection.** Know which harnesses are installed and which persona is live in each.
- **Local API.** Unix socket (Windows: named pipe) with a simple JSON-RPC/HTTP surface:
  `personas.list`, `personas.resolve`, `switch`, `status`, `events` (SSE for UIs). Authenticated
  by filesystem perms + a local token file.

Lifecycle: installed as a user service (launchd / systemd --user / Windows service); `hatrack
daemon start|stop|status`; `hatrack` CLI auto-starts it on first use (configurable). Must degrade
gracefully: every CLI command works in-process with the daemon absent, just slower and without
background sync.

> 2026-10-21: the first slice (spec 14) is built. It runs as `zzpersona daemon run` inside the CLI
> package until the build code is a package of its own. Sync, drift, the marketplace, pre-build, the
> secrets broker and service install are later slices.
>
> 2026-10-22: service install and auto-start are built (spec 16, `16-daemon-service.md`):
> `zzpersona daemon install|uninstall` (launchd, systemd --user; not Windows yet), and `zzpersona
> claude` / `codex` start the daemon when it is not running (`daemon: { autoStart: false }` turns
> it off). Other commands do not auto-start it.

Desktop app: a **tray/menubar client** of the daemon (Tauri preferred over Electron for footprint;
revisit if a webview constraint appears). It shows current persona per harness, a switcher, sync
and drift status, and the compile report. Enterprise can later add "assigned to you" personas and
notifications here. It never embeds business logic; if it works in the tray app, it must also work
via `hatrack --json`.

## Data flows

**Author / publish**
```
edit persona.yaml → hatrack resolve --explain (local lint)
  → git commit (OSS)  |  hatrack publish (control plane: validate, enforce locks, version++, audit)
```

**Switch**
```
hatrack switch <persona> [--harness claude-code|all]     (CLI → daemon if running, else in-process)
  1. store.get(persona) + ancestors           (daemon cache; remote if logged in and stale)
  2. resolver.resolve → IR + provenance
  3. secrets.resolve, gateway.resolve
  4. for each target harness: adapter.compile → build/<persona>/<harness>/ (+ report)
  5. adapter.activate
  6. write ~/.hatrack/state.json { current, perHarness, builtFrom: {versions/shas} }
```

**Drift** (control plane)
```
client periodically (or on switch) posts { persona, builtFrom, local resolve hash }
server compares to published version → drift report per user/team → console
```

**Project auto-detect**
```
cwd walk-up finds .hatrack/persona.yaml → compare to state.current → nudge in-session (never auto-switch)
```

## Control plane

- **API:** REST + JSON; OpenAPI published; the OSS `store-remote` is the only client the CLI needs.
- **Tenancy:** single-tenant per deployment in v1 (self-hosted). Multi-tenant SaaS is a later
  decision, not an architectural assumption — keep `org_id` on every row from day one anyway.
- **Identity:** OIDC (Okta, Entra, Google). Service tokens for CI publishing.
- **RBAC:** roles scoped to a layer path (`org`, `area/fintech`, `team/payments`): *view*,
  *publish*, *lock*. Locking is a separate privilege from publishing.
- **Storage:** Postgres. Personas stored as content-addressed blobs + version rows; audit log
  append-only.
- **Policy engine:** evaluates publish requests against layer rules (who may publish where, what
  must be locked at org level, allowed gateway set). Start as code; consider OPA/Rego only if
  customers ask for custom policy.
- **Deployment:** single container + Postgres; Helm chart with external-DB option; air-gapped OK
  (no outbound calls required).

## Security model

- Persona files never contain secret values; CI lint rejects anything that looks like one.
- Generated builds are gitignored and may contain resolved secrets; builds live under
  `~/.hatrack/build/` with `0700` perms.
- In enterprise mode, MCP servers may be declared **only** as `gateway://` refs (org lock on
  `mcp.servers` to disallow inline definitions). This makes the gateway the single tool route.
- Locks are enforced server-side at publish and client-side at resolve. The client side is
  advisory by nature; drift detection is the compensating control.
- Audit: every publish, lock change, role change; optionally every switch (opt-in, privacy).

## Repo layout

**OSS monorepo (turborepo, pnpm, TypeScript):**

> Amended 2026-10-20: `apps/` and `packages/` moved under `src/` (founder preference; keeps the
> root to config + docs). `src/packages/adapters/` is a grouping directory and must never get its
> own `package.json` (Turborepo forbids nested packages). Shared `typescript-config` and
> `eslint-config` packages are internal and never published.

```
src/
  apps/
    cli/
    daemon/
    desktop/         (tray app; thin client of daemon)
    docs/            (Docusaurus/Starlight; the spec reference is generated from zod → JSON Schema)
    marketing/
  packages/
    spec/  resolver/  store-local/  store-remote/  secrets/  gateway/
    adapter-sdk/
    adapters/  claude-code/  codex/  antigravity/  cursor/  gemini-cli/  agents-md/
    mod-claude-code/
    typescript-config/  eslint-config/
spikes/              (throwaway investigations per harness; findings feed the capability matrix)
docs/planning/       (these documents)
```

**Enterprise private repo:** `control-plane/`, `console/`, `policy/`, `gateway-integrations/`,
`deploy/`. Depends on published `@hatrack/*` packages only.

## Technology choices (defaults, change with reason)

- TypeScript everywhere; pnpm + turborepo; zod for schema; vitest. Latest versions by default.
- Node: develop on the newest LTS line (26, LTS 2026-10-28); support floor `engines: >=24`.
  *Amended 2026-10-20: was "Node 22+". 22 is maintenance-only (EOL 2027-04) and would be the
  floor for a product that will not ship before 26 is the active LTS.*
- CLI: `clipanion` or `commander`; output machine-readable with `--json` on every command.
- Control plane: Hono or Fastify; Drizzle + Postgres; OpenAPI generated.
- Console: Next.js or Vite + React; talks only to the public API.
- Distribution: npm (`npx hatrack`), Homebrew tap, single-binary via `bun build --compile` later.

## Open questions (architecture-level)

1. **IR stability.** The IR is the contract between resolver and every adapter *and* the control
   plane. Version it independently of the YAML `apiVersion`? (Lean: yes, `irVersion`.)
   *Decided 2026-10-20: yes. `@zzpersona/spec` exports `IR_VERSION = 0` separately from
   `API_VERSION = "zzpersona/v0"`; the IR carries `irVersion`.*
2. **Multi-harness switch atomicity.** `switch --harness all` can partially fail. Per-harness
   state with a summary, or all-or-nothing? (Lean: per-harness; report.)
   *Decided 2026-10-22 (spec 17): one choice for every harness, saved first; `switch` then reports
   per harness, and a harness that fails is reported without undoing the choice.*
3. **Where in-session UX lives for harnesses without a mod/extension API.** Likely: none, CLI only.
4. **Skills portability.** Skill formats differ per harness. Treat a skill as a directory with a
   `SKILL.md` and let adapters translate, or define a harness-neutral skill manifest? (Lean: the
   former for v1; Claude's format is the de facto standard.)
5. **Knowledge pointers.** v1: pass through as MCP servers / instruction links. Anything richer
   waits for a customer.
6. **Daemon vs. no daemon for v0.** The daemon is the right end state but is not required for the
   first OSS release; the CLI must work without it. Decide whether v0 ships it or the CLI only.
7. **Daemon as agent runtime?** "Agent pod" could also mean the daemon hosting long-running
   agents/MCP servers locally on the persona's behalf (e.g. a persona-scoped MCP aggregator that
   exposes one endpoint per persona). Attractive — it would make the persona itself an MCP
   server any harness can connect to — but it is a second product. Park it as a phase-3 idea and
   note it in the roadmap.

## Appendix A — Claude Code adapter

Facts below are from the official Claude Code docs (code.claude.com) as of 2026-10-20; this
surface changes fast, so re-verify against `claude --help` / `claude plugin --help` before
building. Items marked **spike** need a hands-on test.

### What a plugin can and cannot carry

| IR field | Plugin can ship it? | Where it actually goes |
|---|---|---|
| skills | yes — `skills/<name>/SKILL.md` | plugin |
| hooks | yes — `hooks/hooks.json` | plugin |
| mcp.servers | yes — `.mcp.json` in plugin | plugin (tools named `mcp__plugin_<plugin>_<server>__<tool>`) |
| instructions | **no** — a root `CLAUDE.md` in a plugin is not loaded | see below |
| permissions | **no** — plugins cannot set `permissions` | settings file / `--settings` |
| statusLine | **no** — plugin settings only honor `agent` and `subagentStatusLine` | user settings, or the mod draws its own |

So the Claude Code "build" is not one plugin; it is a plugin **plus** a settings fragment
**plus** an instructions delivery mechanism:

- **Instructions**: three documented routes. (a) `--append-system-prompt-file` at launch —
  cleanest, always in context, relaunch only. (b) A plugin `SessionStart` hook returning
  `hookSpecificOutput.additionalContext` (10k-char cap, larger becomes a file path + preview) —
  works for new sessions without wrapping the binary. (c) A skill — only loaded on demand; not a
  substitute for always-on instructions. Adapter does (a) when launching, (b) otherwise, and emits
  a compile warning when fragments exceed the cap.
- **Permissions**: written to `.claude/settings.local.json` (project scope, gitignored by
  convention) or passed via `--settings`. Settings-file edits to `permissions` and `hooks` are
  **hot-reloaded**, which matters for in-session switching.
  *Amended 2026-10-21 (spike): only the user, project, local and managed files are watched. A
  file passed with `--settings` is read once at startup — verified with a control run. See
  `spikes/claude-code/FINDINGS.md`.*

### Activation: what is possible

| Mechanism | Mid-session? | Notes |
|---|---|---|
| `claude plugin enable/disable --scope local` + `/reload-plugins` | yes, user must type the reload | reload is **refused** when plugin MCP servers change until `/reload-plugins --force` |
| edit `settings.local.json` permissions/hooks | yes, automatic | documented hot-reload |
| `/mcp` enable/disable | yes | toggles existing servers only; add/remove is CLI-only |
| relaunch with `--settings --mcp-config --strict-mcp-config --plugin-dir --append-system-prompt-file` | no | deterministic; strict MCP set; zero config pollution |
| `CLAUDE_CONFIG_DIR` swap | no | relocates `~/.claude`; **full isolation unverified** (`~/.claude.json` not stated to move) — **spike** |

*Amended 2026-10-21 (spike, `spikes/claude-code/FINDINGS.md`):*

| Mechanism | Mid-session? | Finding |
|---|---|---|
| relaunch (row above) | no | **verified end to end**: system prompt, SessionStart hook, skill, MCP tool, allow and deny rules all reached the session; the user's own plugins stayed loaded; `--strict-mcp-config` hid the user's MCP servers |
| edit a file passed with `--settings` | **no** | read once at startup (control: `settings.local.json` did reload) |
| `CLAUDE_CONFIG_DIR` swap | no | `.claude.json` does move, but each directory has **its own login** — rejected |
| add/remove a plugin inside a `--plugin-dir` folder of plugins | yes, interactive, v2.1.265+ | applies right away, or shows a `/reload-plugins` notice if it would force a full re-read (docs; manual check A pending) |
| mod `prompt.submit` adds `context` | yes | injects instructions into the current session; lives in history, so re-inject after compaction |
| MCP config edit | no | takes effect only after restart; plugin MCP via `/reload-plugins --force` |

A **mod cannot perform the switch**: `$.settings` is read-only and there is no documented API to
enable plugins, change MCP, or run `/reload-plugins`. A mod *can* draw status, register
`/persona`, prompt the user, run a process, and call `$.prompt.submit`. Whether `$.process.run`
→ `claude plugin enable` + asking the user to `/reload-plugins --force` is an acceptable UX is a
**spike**, not a design assumption.

### Recommended strategy (v0)

Two tiers, both generated from the same build:

1. **Relaunch (primary, deterministic).** `hatrack switch <p>` writes
   `~/.hatrack/build/<p>/claude-code/{plugin/, settings.json, mcp.json, system-prompt.md}` and
   `hatrack claude` (or `switch --relaunch`) execs `claude --plugin-dir … --settings … --mcp-config
   … --strict-mcp-config --append-system-prompt-file …`. This is the one that is guaranteed
   correct and the one CI/`-p` uses.
2. **In-session (best effort).** The mod shows the active persona and a nudge when cwd implies a
   different one. `/persona switch <p>`: regenerate build, write `settings.local.json`
   (permissions hot-reload immediately), toggle `enabledPlugins` at local scope, then tell the
   user to run `/reload-plugins --force`. Instructions update only at next session (SessionStart
   hook) — the mod says so.

   *Amended 2026-10-21 (spike): tier 1 is verified as written. Tier 2 changes: the `--settings`
   file is not watched, so live permissions must go to `settings.local.json`; a mod can inject
   instructions mid-session via `prompt.submit`, so they need not wait for the next session; and
   swapping the child of a `--plugin-dir` folder of plugins may replace the `enabledPlugins`
   toggle entirely. Design tier 2 in Phase 1 after manual check A in the spike findings.
   Config-root swap is rejected (separate login per config directory).*

Persona plugins are served from a **local marketplace** (`~/.hatrack/marketplace/.claude-plugin/
marketplace.json` with relative-path sources), so all persona builds are installable by id
(`<persona>@hatrack`) and toggled via `enabledPlugins` rather than copied around. Edits in
place take effect on `/reload-plugins` with no version bump.

### Enterprise enforcement maps onto managed settings

This is the best news in the research. Claude Code's managed layer can enforce exactly the things
`locks` express: `enabledPlugins` (force-enable / block), `strictKnownMarketplaces`,
`allowedMcpServers` / `deniedMcpServers` / `managed-mcp.json`, `allowManagedPermissionRulesOnly`,
`allowManagedMcpServersOnly`, `allowManagedHooksOnly`, `strictPluginOnlyCustomization`,
`disableSideloadFlags`. So the control plane's Claude Code enforcement path is: **compile
org-level locks into `managed-settings.d/hatrack.json` + `managed-mcp.json`**, delivered through
the customer's existing MDM / claude.ai admin console. That turns client-side-advisory locks into
real policy for this harness without inventing a new enforcement mechanism. Note:
`disableSideloadFlags` would break the relaunch strategy's `--plugin-dir`/`--mcp-config`; in
locked-down orgs the adapter must fall back to marketplace install + managed MCP. The capability
report must say which mode it is in.

*Amended 2026-10-21 (spike, docs only): `disableSideloadFlags` also blocks
`CLAUDE_CODE_PLUGIN_DIRS`, but not `--settings` or `--append-system-prompt-file`. A deployed
`managed-mcp.json` independently makes `--mcp-config` and `--strict-mcp-config` exit at startup.
A local persona marketplace survives `strictKnownMarketplaces` only if the admin allowlists its
path (`directory` source or `pathPattern`); otherwise persona plugins go to an approved git
marketplace, which the control plane would publish to anyway.*

### Spikes for this adapter

1. `CLAUDE_CONFIG_DIR` isolation: does `~/.claude.json` (MCP user/local scopes, per-project state)
   follow it? If yes, config-root swap becomes a viable third strategy.
2. Mod UX for `/persona switch`: `$.process.run("claude plugin enable …")` + reload prompt —
   acceptable, or confusing?
3. Can a mod inject persona instructions into the *current* session (prompt/turn rewrite API)
   so instructions do not wait for SessionStart?
4. Does a `.mcp.json` edit or `claude mcp add` mid-session get picked up without restart?
5. Behaviour under `disableSideloadFlags` + `strictKnownMarketplaces`: full marketplace-only path.

*Answered 2026-10-21 in `spikes/claude-code/FINDINGS.md`: (1) yes, but separate login — rejected;
(2) deferred to a Phase 1 prototype, constraints recorded; (3) yes, via `prompt.submit`;
(4) no, restart needed except plugin MCP via `--force`; (5) docs only, needs admin allowlisting.*

Sources: plugins manifest/components/loading/marketplaces/CLI reference, settings, managed
settings, claude-directory, env-vars, MCP, mods overview/API, hooks, CLI reference — all under
https://code.claude.com/docs/en/ .
