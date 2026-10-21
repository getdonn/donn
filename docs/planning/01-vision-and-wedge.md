# 01 — Vision and Wedge

> Working name: **Hatrack** (unverified — check npm, GitHub org, domain before committing).
> Amended 2026-10-20: Hatrack is taken. Placeholder is `zzpersona` until a name is chosen; see
> `00-handoff.md` → "Naming".
> Status: brainstorm, 2026-10-20. Nothing here is decided.

## The problem

Developers in large organizations work across several projects, teams, and business areas,
and each context comes with its own pile of AI-tooling configuration:

- instructions (`CLAUDE.md`, `AGENTS.md`, rules files)
- skills / slash commands / subagents
- MCP servers (and the credentials behind them)
- permission policies (allow / deny / ask)
- hooks
- knowledge sources that live *outside* the repo (wikis, schemas, data catalogs, internal docs)

Today this is scattered across `~/.claude`, per-repo `.claude/`, `.mcp.json`, shell aliases,
and tribal knowledge. Some of it is org-wide, some business-area-wide, some team-specific,
some project-specific, some personal. Nothing models that layering. Switching context means
manually reassembling it, and nobody can answer "what does a new hire on team X actually get?"

## The thesis

A **persona** is a declarative, versioned, *composable* bundle of everything above.
Personas inherit from each other (org → business area → team → project → personal), and a
resolver flattens the stack deterministically. The result **compiles** to whatever AI harness
the developer uses: a Claude Code plugin first, then other targets.

The product is a **persona compiler and control plane**. The Claude Code plugin + mod is the
first and best target — not the product itself.

### Why "switcher" alone is not enough

- A per-harness profile switcher is thin: people already approximate it with shell aliases,
  per-directory `.mcp.json` + `CLAUDE.md`, and `CLAUDE_CONFIG_DIR` swaps.
- Anthropic (or any harness vendor) could ship native profiles at any time. A single-harness
  switcher dies that day.

### What survives that

1. **Composition / inheritance with real merge semantics** — the hard, interesting problem.
   See `02-persona-spec.md`.
2. **Governance that follows the persona, not the machine** — MCP gateways (Bifrost etc.) do
   tool allowlists per key/team, but stop at the gateway. Nobody ties "who you are + what you're
   working on" to "which instructions, skills, permissions *and* tools you get" as one
   auditable, versioned unit.
3. **Multi-harness compilation** — enterprises run Claude Code, Cursor, Codex, Copilot, Gemini
   CLI side by side. A harness-neutral spec that compiles to each is something no harness
   vendor will build.

## Who it is for

| Persona (ha) | OSS or paid | What they want |
|---|---|---|
| Solo developer with many hats | OSS | `hatrack switch payments` and everything is right |
| Team lead / staff engineer | OSS → paid | Publish *the* persona for the team; stop answering setup questions |
| Platform / DevEx team | Paid | Org baseline, policy, audit, drift detection, gateway integration |
| Security / compliance | Paid | "Which tools can which teams reach, and who changed it?" |

The OSS tool must be **fully useful for the solo developer** or there is no adoption funnel.

## Product surfaces

**Open source (core):**
- `spec` — schema + TypeScript types for a persona
- `resolver` — inheritance, merge, conflict reporting
- `adapters/*` — one per harness; `claude-code` first
- `cli` — `init`, `resolve`, `compile`, `switch`, `doctor`, `diff`
- `mod-claude-code` — in-terminal UX: status line, `/persona switch`, "you're in a
  repo whose persona isn't loaded" warning

> Amended 2026-10-20: renamed `compilers/*` → `adapters/*` and `claude-plugin` + `claude-mod` →
> `mod-claude-code` to match `03-architecture.md`. The generated persona plugin is build output of
> `adapters/claude-code`, not a package.
- `store-local` — `~/.hatrack/` + git as the persona store

**Enterprise (separate private repo, licensed):**
- control-plane server: persona registry, RBAC, SSO/OIDC, audit log, policy engine
- web admin console
- gateway adapters (Bifrost first) — resolve MCP servers by name through an allowed set
- drift detection: local persona vs. published persona
- Docker image + Helm chart (table stakes for the buyer)

**Later phases (sequencing, not scope cuts — see `04-roadmap.md`):**
- Desktop presence — reframed: the valuable part is a **local daemon** (sync, pre-build, watchers,
  drift, local API) that CLI, mod, IDE extensions and a tray app all talk to. The tray/desktop app
  is a thin client of that daemon, not a product of its own. Daemon is core (OSS); tray app is
  phase 2. See `03-architecture.md` → "Local daemon".
- IDE extensions — start with "compile to that IDE's config files"; a real extension (status,
  switch, drift warning) comes after the second compile target proves the spec is harness-neutral.
- **Knowledge / vector store.** v1 is pointers to MCP-reachable sources the gateway governs.
  A managed index is a plausible paid feature later, but it turns this into a data-residency
  vendor; decide deliberately, with a customer asking for it, not by default.

## Risks

| Risk | Mitigation |
|---|---|
| Harness vendor ships native profiles | Be the layer *above* profiles: composition, governance, multi-harness |
| Claude Code plugin / mod APIs churn | Keep the compiler target thin; the spec and resolver are harness-free |
| Nobody switches personas more than once a day | Validate early (below); if true, it's a utility, price time accordingly |
| Enterprise buyer wants it inside their existing gateway | Integrate, don't compete; gateway adapters are first-class |
| Small team (1–3 engineers) | Sequence hard: OSS core → first paid feature with a buyer → surfaces. Design the enterprise boundary now so it is not a rewrite later |

## Validation plan

Personal project: no dogfooding at work. So:

1. Build the smallest thing that tests the thesis: YAML spec → resolver with `extends` →
   `compile --target claude-code` → launch `claude`.
2. Use it personally across 3+ distinct contexts for a few weeks.
3. Ship it. Watch whether issues/discussions describe **team** problems ("I want to publish
   this for my team") vs. solo ones. The former means the paid tier has a buyer.
4. Recruit 2–3 people who lead small teams elsewhere to try the "publish a persona" flow.

The question is not "does it work." It is:
**"Does anyone besides me switch personas more than once a day, and does a lead want to publish one?"**

## Open questions

- Name. (~~Hatrack~~ taken / Mantle / Guise / Dramatis / Roleset / Manyhats — rest unverified.)
  Not blocking until first publish; see `00-handoff.md` → "Naming".
- License for OSS core: Apache-2.0 vs. MIT. Lean Apache-2.0 (patent grant matters for enterprise).
- ~~Does the enterprise server need to be a separate repo from day one, or a private package in
  the turborepo that is excluded from the OSS mirror?~~ **Decided 2026-10-20:** separate private
  repo depending only on published `@hatrack/*` packages. See `03-architecture.md` → "Enterprise"
  and `00-handoff.md`.
- Second compile target: Cursor or `AGENTS.md`-family (Codex/Copilot)? `AGENTS.md` is cheapest
  and covers several harnesses at once.
  *2026-10-21 (spike): both. `agents-md` is a cheap repo-file target, but `AGENTS.md` cannot be
  delivered from outside the repo. Codex takes instructions, MCP servers and approval policy
  per launch, so it is the stronger "real" second adapter. See `spikes/agents-md/FINDINGS.md`.*
- How much of "knowledge" is in scope for v1? Probably: pointers + an optional local indexer,
  nothing more.
