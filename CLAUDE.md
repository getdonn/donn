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

**Planning only. No code exists yet.** Personal project, not affiliated with any employer.
The planning docs are the source of truth; nothing in this chat history or anywhere else
overrides them.

## Read these first, in order

0. `docs/planning/00-handoff.md` — one-read brief: how this started, the reframe, decisions **with rejected alternatives**, research findings, consolidated open questions, glossary

1. `docs/planning/01-vision-and-wedge.md` — problem, thesis, who it's for, OSS vs. enterprise split, risks, validation plan
2. `docs/planning/02-persona-spec.md` — persona YAML shape, layer model, **per-field merge semantics**, locks, resolution algorithm
3. `docs/planning/03-architecture.md` — full system: components, harness adapter contract + capability matrix, local daemon, control plane, security, repo layout. Appendix A has verified Claude Code facts and the activation strategy.
4. `docs/planning/04-roadmap.md` — phases with exit questions, dependency graph, team-shape notes

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

Phase 0 (see roadmap): spikes + `spec` + `resolver` with a fixture suite. Next concrete steps:
bootstrap the turborepo under the `zzpersona` placeholder, write resolver fixtures from the `02`
example. Picking the name runs in parallel and only blocks the first `npm publish`.

## Conventions (once code exists)

- TypeScript, pnpm, turborepo, zod, vitest, changesets — latest versions.
- Node: develop on 26 (pnpm downloads it via `devEngines.runtime`; system Node is irrelevant);
  `engines` floor is >=24, and `@types/node` tracks the floor, not the dev version.
- Workspaces live under `src/apps/*` and `src/packages/*` (adapters in `src/packages/adapters/*`),
  never at the repo root. All packages `"private": true` until the name is chosen.
- Every CLI command supports `--json`.
- Planning docs live in `docs/planning/`, numbered. Append new ones; amend old ones in place
  with a dated note rather than silently rewriting decisions.
- Spikes go in `spikes/<topic>/` with a `FINDINGS.md`; they are throwaway and never imported.
