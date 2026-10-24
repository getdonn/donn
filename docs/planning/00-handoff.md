# 00 — Handoff Brief

> Purpose: get a fresh session (or a new engineer) fully up to speed in one read. This captures
> the reasoning and the rejected alternatives that the numbered docs state only as conclusions.
> Written 2026-10-20 from the original brainstorming session. Update it when decisions change.
> 2026-10-23: renamed zzpersona/hatrack → donn (spec 22).

## How this started

The founder (Jacob) works in a large enterprise where many orgs, business areas and teams each
use some AI harness, and every repo/team has its own `.claude/` (skills, permissions, MCPs) plus
knowledge and data sources *outside* the repo that are referenced while working in it. Some of
that crosses project boundaries, some doesn't. The original idea: a Claude Code plugin + mod that
lets you "switch to a persona" and have everything relevant become available.

Initial instincts also included: a free/OSS core plus a paid tier (multi-user, a vector database
for persona knowledge graphs, user management/admin), web and desktop (Electron) clients, VS Code
and other IDE plugins, loading allowed MCP servers from a gateway like Bifrost, self-hosting via
Docker + Helm, and a turborepo monorepo with the enterprise piece possibly living outside it.

This is a **personal project**, built only on personal machines and time, with a possible team
of 2–3 engineers if it shows legs. Scope is not the constraint; sequencing is.

## The reframe (why the docs look the way they do)

1. **"Persona switcher" is a thin wedge.** People already do it with shell aliases, per-dir
   `.mcp.json` + `CLAUDE.md`, and `CLAUDE_CONFIG_DIR`. Small OSS tools (e.g. `claudectx`) exist.
   And any harness vendor could ship native profiles tomorrow, which kills a single-harness
   switcher.
2. **What survives that:** (a) composition/inheritance with real merge semantics across org →
   area → team → project → user; (b) governance that travels with the persona rather than the
   machine (gateways govern tools, nobody governs the whole bundle); (c) multi-harness
   compilation, which no harness vendor will build because each only cares about itself.
3. Therefore: **the product is a persona compiler + control plane. Claude Code is the first
   adapter, not the product.** The founder explicitly confirmed Claude Code was an example and a
   natural starting point, and that Codex, Antigravity, etc. must be first-class.

## Decisions and the alternatives rejected

| Decision | Rejected alternative | Why |
|---|---|---|
| Harness-neutral spec + IR; adapters compile to each harness | Claude-Code-specific plugin generator | Platform risk; vendor could ship profiles; enterprises run many harnesses |
| Adapters emit a `CompileReport` of dropped/weakened fields | Silent best-effort mapping | Policy owners must know where enforcement is advisory; also a marketing asset |
| Open core with a **separate private enterprise repo** depending on published OSS packages | Private packages inside the monorepo excluded from the OSS mirror | Forces a clean boundary; monorepo-with-exclusions always leaks |
| Knowledge = pointers to MCP-reachable sources | Ship/own a vector database | Every enterprise already has RAG + data-residency review; owning vectors makes this a data vendor, a worse business than config/governance |
| Local daemon (`donnd`) is core; tray app is a thin client, later | Electron desktop app as a primary surface | Founder's real need was "something running locally for sync/agent pod"; that's a daemon. A third UI with no new user is cost without benefit. Tauri preferred over Electron for footprint |
| IDE support = compile to that IDE's config; extensions later as daemon clients | VS Code extension early | Large surface area for a status indicator; wait for the daemon |
| `locks` as the policy primitive; enforced server-side at publish, client-side advisory, drift as compensating control | Client-side enforcement only | Client is trivially editable; the gap *is* the enterprise upsell |
| Replace (not deep-merge) opaque objects like MCP server defs; `deny` always beats `allow`; absence never deletes | Deep-merge everything | Deep-merged `args` arrays produce nonsense; security sets should only grow without explicit `remove` |
| Relaunch wrapper is the deterministic Claude Code switch; mod is status/nudge | Mod performs the switch | Verified: mods have read-only `$.settings`, no API to toggle plugins or run `/reload-plugins` |
| Apache-2.0 leaning for OSS | MIT | Patent grant matters to enterprise buyers (not final) |
| Postgres, TypeScript everywhere, pnpm + turborepo, zod → JSON Schema | — | Boring defaults; change with reason |

## Research findings that shaped the design (verified 2026-10-20 against code.claude.com docs)

- A Claude Code plugin can ship skills, hooks, MCP servers, agents, commands, `bin/`, but **not**
  a root `CLAUDE.md` (not loaded) and **not** permission rules. Plugin `settings.json` only honors
  `agent` and `subagentStatusLine`.
- Instructions therefore go via `--append-system-prompt-file` (launch) or a `SessionStart` hook's
  `additionalContext` (10k-char cap). Permissions go in a settings file (`--settings` or
  `.claude/settings.local.json`), which **hot-reloads** permissions and hooks.
- `enabledPlugins` toggles need `/reload-plugins`; if plugin MCP servers change, `--force`.
  Local marketplaces with relative-path sources load in place without version bumps.
- `CLAUDE_CONFIG_DIR` relocates `~/.claude` but full isolation (esp. `~/.claude.json`, where MCP
  user/local scopes live) is **unverified** → spike.
- *Spike results, 2026-10-21 (`spikes/claude-code/FINDINGS.md`, Claude Code v2.1.306):* the
  relaunch path is **verified end to end**. Corrections to the bullets above: a `--settings`
  file is **not** hot-reloaded (only user/project/local/managed files are), and
  `CLAUDE_CONFIG_DIR` does move `.claude.json` but each directory has its own login, so
  config-root swap is rejected. New: a mod's `prompt.submit` can inject instructions
  mid-session, and plugins added to a `--plugin-dir` folder of plugins apply mid-session.
- Managed settings can enforce `enabledPlugins`, `strictKnownMarketplaces`, `allowedMcpServers`,
  `managed-mcp.json`, `allowManagedPermissionRulesOnly`, `allowManagedHooksOnly`,
  `disableSideloadFlags`, etc. → org locks compile to a managed-settings bundle for MDM. Note
  `disableSideloadFlags` breaks the `--plugin-dir`/`--mcp-config` relaunch path; locked-down orgs
  need the marketplace-only path.
- Mod capabilities: panes, bands, status text, toasts, `/commands`, tools, model calls, fs/
  process/http, `$.prompt.submit`. `$.settings` read-only.
- MCP gateways (Bifrost etc.) do per-key/team tool allowlists, RBAC, audit, but stop at the
  gateway — none bundle instructions/skills/permissions with tools. Integrate, don't compete.

Sources: https://code.claude.com/docs/en/ (plugins, mods, settings, managed-settings,
claude-directory, env-vars, mcp, hooks, cli-reference); https://claude-codex.fr/en/advanced/mcp-profiles/ ;
https://www.getmaxim.ai/articles/best-mcp-gateways-in-2026-compared-by-deployment-model-and-governance-depth/

## Naming (amended 2026-10-20, 2026-10-23)

### Chosen 2026-10-23: donn

The name is **donn**: to *don* a persona, putting on the right setup for the work in front of you.
The double n is deliberate. `don` is taken on npm (a 2022 templating DSL) and as `don.sh` /
`don.dev`; a Go tool named `don` already connects LLMs to command-line tools; and a dictionary
word is hard to search for and weak as a trademark.

Reserved 2026-10-23:

- **Domain `getdonn.dev`.** `donn.dev` is for sale at about $5k (declined); `donn.ai` is parked
  on a resale marketplace; `donn.sh` (about $90 a year) and `usedonn.com` were free and are
  optional.
- **npm org `@getdonn`.** `@donn` is held by another npm account. The bare package name `donn`
  is unowned, but npm refuses to publish it ("too similar to existing packages dot, docx, conf,
  hono…"), so the CLI ships as **`@getdonn/cli`** and installs the `donn` command. Same shape
  as `@anthropic-ai/claude-code` → `claude` and `@openai/codex` → `codex`.
- **GitHub org `getdonn`.** `donn` and `donn-dev` are unrelated users. The repo moves into the
  org when it goes public (GitHub redirects the old URL).

**2026-10-23: the rename landed (spec 22).** Run `donn migrate` once on a machine that ran
zzpersona. The table below is kept as history:

Mapping for the rename (the code said `zzpersona` until then):

| Placeholder | Becomes |
|---|---|
| `@zzpersona/*` | `@getdonn/*` |
| `zzpersona` (CLI) | `donn`, from the package `@getdonn/cli` |
| `zzpersonad` | `donnd` |
| `~/.zzpersona/`, `.zzpersona/persona.yaml` | `~/.donn/`, `.donn/persona.yaml` |
| `apiVersion: zzpersona/v0` | `apiVersion: donn/v0` |
| `ZZPERSONA_*` | `DONN_*` |

`grep -ri zzpersona` is not the whole list: the short prefix `zzp` also appears (`ZZP_E2E`,
`ZZP_SECRET_*`, `zzp-*` plugin and folder names, `zzpd-`), and so do OS service labels
(`zzpersona.daemon`, `zzpersona-daemon.service`) and the managed-settings fragment
`50-zzpersona.json`. The rename plan decides those.

Rejected on the way, 2026-10-23:

- **innate** (and `un8` as its shorthand): "innate" means inborn and unchanging, the opposite of
  switching; `vima-tech/Innate`, an AI-agent knowledge layer, already uses it; `un8` reads as a
  derivative of n8n and cannot be spelled by ear.
- **Pluribus-derived** (`pluro`, `plures`, `plurex`, `luris`): the show's hive mind spreads like a
  virus, and "many minds" does not describe what the product does.
- **rolio** (role + portfolio): the runner-up; free on npm.
- legata, mantlr, avatara, incarna, mimiq, roledex, myrio: weaker fit or longer. Of the earlier
  list, Mantle, Guise and Manyhats are taken on npm.

Still open: a USPTO search for DONN in software classes 9 and 42 before the first public
release; a tagline (candidate: "Define it once. Don it anywhere."); the rename itself, including
golden files, fixtures and the private control-plane repo's `@zzpersona/*` dependencies.

The placeholder rules below (2026-10-20) hold until the rename lands.

**Hatrack is out** — the name is already taken by an existing project. No replacement is chosen,
and choosing one does **not** block Phase 0; it blocks only the first `npm publish`.

Until a name is picked:

- Code uses the single placeholder token **`zzpersona`** everywhere a name appears: package
  scope (`@zzpersona/spec`), CLI binary, `apiVersion: zzpersona/v0`, `~/.zzpersona/`,
  `.zzpersona/persona.yaml`, `ZZPERSONA_*` env vars, `zzpersonad`. It is chosen to be unique so
  one `grep -ri zzpersona` finds every occurrence at rename time.
- All packages are `"private": true` so nothing can publish to public npm under the placeholder.
  For testing real installs before naming, publish to **GitHub Packages** instead (decided
  2026-10-20). Caveats: its npm registry requires the package scope to equal the GitHub owner
  (so the publish scope is the owner, not `@zzpersona`, unless an org by that name exists), and
  installs need an auth token even for public packages. Fine for dogfooding, not for the funnel.
- The planning docs still say `hatrack` / `@hatrack/*` / `hatrackd`. Read those as the same
  placeholder; they are not rewritten so the decision history stays intact.
- Rename before the first public release. The expensive identifiers are the ones that land in
  users' files (`apiVersion`, `.zzpersona/` paths, config dirs); before any users exist, renaming
  is find-and-replace.

## Consolidated open questions

From `01`: name (Mantle / Guise / Dramatis / Roleset / Manyhats — all unverified; Hatrack taken;
*decided 2026-10-23: **donn**, see "Naming"*);
license; second compile target (lean `agents-md`; *2026-10-21 spike: `agents-md` as a repo-file
target plus Codex as the real second adapter, since relaunch works for Codex and Copilot too*).
From `02`: Claude Code switch mechanism (now mostly answered in `03` App. A, spikes remain);
instruction token budget; skills registry (v0: git/local only); `extends` version pinning (lean:
float locally, pin on publish); user layer cannot declare locks; provenance format; whether a lock
on a grow-only set forbids *adding*; where `permissions`/`hooks` explicit removals live in the
shape; linearization direction (root-first = reverse C3) — these three added 2026-10-20.
From `03`: `irVersion` independent of `apiVersion` (lean yes); multi-harness switch atomicity
(lean per-harness); skills portability (lean: Claude's SKILL.md dir format as de facto standard);
daemon in v0 or not; "persona as MCP endpoint" parked for phase 3/4.

## Validation thesis (the thing that decides if this is a business)

Not "does it work." It is: **does anyone besides the founder switch personas more than once a
day, and does a team lead want to *publish* one for their team?** First yes = useful OSS tool.
Second yes = the enterprise tier has a buyer. Can't be dogfooded at the founder's employer, so:
ship OSS early, watch for team-shaped issues, recruit 2–3 friends who lead small teams elsewhere.

## Glossary

- **Persona** — a versioned, composable bundle of AI-harness configuration + policy + knowledge pointers.
- **Layer** — a level in the inheritance stack (org, area, team, project, user). `extends` is a DAG; layers are a convention.
- **IR / ResolvedPersona** — the flattened, harness-neutral output of the resolver; the contract for adapters and the control plane.
- **Adapter** — per-harness package implementing `HarnessAdapter`: detect, capabilities, compile, activate.
- **CompileReport** — what an adapter dropped, approximated or weakened.
- **Lock** — a path a higher layer forbids lower layers from changing.
- **Provenance** — which layer set each resolved value; powers `--explain` and drift.
- **Drift** — difference between a user's local resolved persona and the published one.
- **Gateway** — an MCP gateway (e.g. Bifrost) that governs which tools exist; personas reference servers by `gateway://name`.
- **`donnd`** — the local daemon: sync, cache, pre-build, watchers, local API.
- **Mod** — a Claude Code plugin with in-process JS/TS hooks; our in-session UX for that harness.

## If you are a fresh session starting work

Read `CLAUDE.md`, then docs `01`→`04`. Current phase is **Phase 0**. Do not start building
adapters or UIs; the critical path is spikes → `spec` → `resolver` + fixtures. When you make a
decision that changes anything above, update the relevant numbered doc *and* this brief.
