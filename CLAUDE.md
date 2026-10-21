# persona-ai (name TBD)

> Hatrack is taken; no name is chosen yet. Code uses the placeholder `zzpersona`
> (`@zzpersona/*`, `~/.zzpersona/`, etc.); docs still say `hatrack`, read it as the same
> placeholder. See `docs/planning/00-handoff.md` → "Naming".

A persona compiler and control plane for AI coding harnesses. A **persona** is a declarative,
composable bundle (instructions, skills, MCP servers, permissions, hooks, knowledge pointers,
secret refs) that inherits through org → business area → team → project → user layers and
**compiles** to each harness's native config. Claude Code is the first adapter; Codex,
Antigravity, Cursor, Gemini CLI and a generic `AGENTS.md` target are peers, not afterthoughts.

## Status

**Phase 0, early code.** Personal project, not affiliated with any employer.
The planning docs are the source of truth; nothing in this chat history or anywhere else
overrides them.

## Read these first, in order

0. `docs/planning/00-handoff.md` — one-read brief: how this started, the reframe, decisions **with rejected alternatives**, research findings, consolidated open questions, glossary

1. `docs/planning/01-vision-and-wedge.md` — problem, thesis, who it's for, OSS vs. enterprise split, risks, validation plan
2. `docs/planning/02-persona-spec.md` — persona YAML shape, layer model, **per-field merge semantics**, locks, resolution algorithm
3. `docs/planning/03-architecture.md` — full system: components, harness adapter contract + capability matrix, local daemon, control plane, security, repo layout. Appendix A has verified Claude Code facts and the activation strategy.
4. `docs/planning/04-roadmap.md` — phases with exit questions, dependency graph, team-shape notes
5. `docs/planning/05-adapter-sdk.md` — the adapter contract (pure compile + activation plan), compile report, conformance kit, and the Claude Code adapter
6. `docs/planning/06-cli-core-loop.md` — store-local (mounts by layer), secrets, plan executor, and `zzpersona resolve|compile|claude`
7. `docs/planning/07-cli-daily-use.md` — `switch` (+ `state.json`) and persona selection precedence, flags-only `init`, `doctor`, CLI hardening
8. `docs/planning/08-cli-reach.md` — third-party adapter and secret provider plugins, the built-in OS `keychain` provider, `diff`, hardening
9. `docs/planning/09-mod-claude-code.md` — the Claude Code mod: band with the active persona, folder-mismatch nudge, `/persona list|switch|clear`, `zzpersona mod install`
10. `docs/planning/10-live-switching.md` — live in-session switching: session plugin folders, `zzpersona live`, `/persona use`, the superseding instructions section
11. `docs/planning/11-agents-md.md` — Phase 2 starts: the `agents-md` adapter, a committed `AGENTS.md` block from the project persona, `zzpersona write [--check]`
12. `docs/planning/12-codex.md` — the Codex adapter (relaunch model: `-c developer_instructions`, MCP with `env_vars`, sandbox defaults) and `zzpersona codex`
13. `docs/planning/13-capability-matrix.md` — every adapter declares every field with reasons; `zzpersona capabilities` and the generated `docs/capabilities.md`

## Key decisions already made (don't relitigate without reading the doc that made them)

- Harness-neutral core; adapters report what they drop (`CompileReport`). No silent loss.
- Open core: spec/resolver/adapters/CLI/daemon/mod are OSS (likely Apache-2.0); control plane,
  console, policy, gateway integrations, deploy are a **separate private repo** that depends only
  on published `@hatrack/*` packages.
- Secrets are `secret://` references in persona files; values only ever land in gitignored builds.
- No vector DB / document ingestion. Knowledge = pointers to MCP-reachable sources.
- Claude Code adapter: plugin + settings fragment + instructions via system-prompt/SessionStart;
  relaunch wrapper is the deterministic switch, mod is status/nudge only; org locks compile to
  managed settings. (See `03` Appendix A — a plugin cannot carry CLAUDE.md or permissions.)
- Desktop presence = a local daemon (`hatrackd`) first; tray app is a thin client of it, later.
- Critical path is `spec → resolver → adapter-sdk → adapters/claude-code`; one person, serial.

## Current phase

**Phase 1** (see roadmap). Phase 0 shipped as `v0.1.0`: `@zzpersona/spec`, the resolver with
its fixture suite (`src/packages/resolver/fixtures/`, the executable merge spec) and
`explain()`, and the `spikes/claude-code` and `spikes/agents-md` findings. Phase 1 starts with
`docs/planning/05-adapter-sdk.md`: `@zzpersona/adapter-sdk` and `adapters/claude-code` (relaunch
path, conformance kit, golden builds in `test/golden/`, opt-in `ZZP_E2E=1` end-to-end test) are
built, and so is the core loop from `docs/planning/06-cli-core-loop.md`: `store-local`,
`secrets`, `executor` and `zzpersona resolve|compile|claude` (opt-in `ZZP_E2E=1` runs the built
binary against real `claude`). Spec 07 (`switch`, `init`, `doctor`, CLI hardening) and spec 08 (plugin adapters and secret providers, the built-in `keychain` provider, `diff`, hardening) are built too, and so is spec 09 (the Claude Code mod: band, nudge, `/persona`, `zzpersona mod install`). Spec 10 (live in-session switching: session plugin folders, `zzpersona live`, `/persona use`) is built too; findings in `spikes/live-smoke/FINDINGS.md`. Phase 2 has started: spec 11 (`agents-md`, `zzpersona write`) and spec 12 (the Codex adapter, `zzpersona codex`) are built; next the capability matrix docs, then the daemon. Picking the name runs
in parallel and only blocks the first `npm publish`.

## Conventions (once code exists)

- TypeScript, pnpm, turborepo, zod, vitest, changesets — latest versions.
- Node: develop on 26 (pnpm downloads it via `devEngines.runtime`; system Node is irrelevant);
  `engines` floor is >=24, and `@types/node` tracks the floor, not the dev version.
- Workspaces live under `src/apps/*` and `src/packages/*` (adapters in `src/packages/adapters/*`),
  never at the repo root. All packages `"private": true` until the name is chosen.
- Every CLI command supports `--json`.
- Formatting: Prettier at width 80 (`.prettierrc.json`). `pnpm format` before committing;
  `pnpm format:check` must pass. `.prettierignore` excludes generated files, test fixtures and
  golden files (compared exactly), `docs/` (prose wrapped at 100) and `spikes/`.
- Git flow: `main` = released, `develop` = integration. All work happens on `feature/<topic>`
  branched from `develop` and merged back into it; `release/*` and `hotfix/*` per standard
  gitflow. Never commit directly to `main` or `develop`. Changesets `baseBranch` is `develop`.
  Merge style: feature → `develop` is always **squash**; `release/*` and sync PRs into `main`
  or `develop` use a **merge commit** so the two branches keep shared history.
- Planning docs live in `docs/planning/`, numbered. Append new ones; amend old ones in place
  with a dated note rather than silently rewriting decisions.
- Spikes go in `spikes/<topic>/` with a `FINDINGS.md`; they are throwaway and never imported.
