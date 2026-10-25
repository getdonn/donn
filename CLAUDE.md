# donn

> The name is **donn** (chosen 2026-10-23): npm org `@getdonn` (CLI package `@getdonn/cli`,
> command `donn`), GitHub org `getdonn`, domain `getdonn.dev`. The rename landed 2026-10-23
> (`docs/planning/22-rename-donn.md`): code and docs say donn, with the old names kept only in
> `donn migrate`, the changelogs and history notes. _(2026-10-24)_ The 13 runtime packages are
> public, published from `release.yml` (`docs/planning/27-first-publish.md`); tooling
> (`eslint-config`, `typescript-config`, `release`) and the root stay `"private": true`. See `docs/planning/00-handoff.md` → "Naming".

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
6. `docs/planning/06-cli-core-loop.md` — store-local (mounts by layer), secrets, plan executor, and `donn resolve|compile|claude`
7. `docs/planning/07-cli-daily-use.md` — `switch` (+ `state.json`) and persona selection precedence, flags-only `init`, `doctor`, CLI hardening
8. `docs/planning/08-cli-reach.md` — third-party adapter and secret provider plugins, the built-in OS `keychain` provider, `diff`, hardening
9. `docs/planning/09-mod-claude-code.md` — the Claude Code mod: band with the active persona, folder-mismatch nudge, `/persona list|switch|clear`, `donn mod install`
10. `docs/planning/10-live-switching.md` — live in-session switching: session plugin folders, `donn live`, `/persona use`, the superseding instructions section
11. `docs/planning/11-agents-md.md` — Phase 2 starts: the `agents-md` adapter, a committed `AGENTS.md` block from the project persona, `donn write [--check]`
12. `docs/planning/12-codex.md` — the Codex adapter (relaunch model: `-c developer_instructions`, MCP with `env_vars`, sandbox defaults) and `donn codex`
13. `docs/planning/13-capability-matrix.md` — every adapter declares every field with reasons; `donn capabilities` and the generated `docs/capabilities.md`
14. `docs/planning/14-daemon.md` — the daemon, first slice: `donn daemon`, a socket API, the session registry, live sessions refreshed on persona edits, `donn status`
15. `docs/planning/15-mod-transport.md` — the mod talks to the daemon over its socket (`POST /run`), CLI fallback; `/persona` works under policy that blocks `process.run`
16. `docs/planning/16-daemon-service.md` — the daemon as a login service (`donn daemon install|uninstall`, launchd / systemd), auto-start in `claude` and `codex`, one daemon per home under a start race
17. `docs/planning/17-switch-report.md` — `donn switch` reports per harness: what each keeps and drops, sessions still on another persona, what `AGENTS.md` carries
18. `docs/planning/18-registry-contract.md` — Phase 3 starts: the registry contract (`@getdonn/registry-api`, mock, conformance kit), `store-remote`, `donn login|logout|whoami|pull|publish`, `--local`
19. `docs/planning/19-publish-engine.md` — the publish rules as a storage-independent engine (`publishLayer` over a `LayerStore`) shared by the mock and the control plane; a harder conformance kit
20. `docs/planning/20-registry-identity.md` — registry identity: browser sign-in (`donn login <url>`), server-issued sessions, roles in `whoami`, tolerant reading of registry answers; the OSS half of C
21. `docs/planning/21-managed-settings.md` — Claude Code enforcement (open-source half of E): org/area/team locks compiled to a managed policy bundle, `policy` block, `donn managed build|install|uninstall|check`, `/v1/managed/bundle`
22. `docs/planning/22-rename-donn.md` — the rename to donn: the full name mapping, the one-off rename script, `donn migrate` for existing installs, the move to the `getdonn` GitHub org, release 0.13.0
23. `docs/planning/23-models-and-agents.md` — the agents and GUI track starts: `models` (model routing through an org's gateway, lockable) and `agents` (project agents built on a persona) in the spec, merge rules, the capability-matrix row
24. `docs/planning/24-adapter-eve.md` — `AgentAdapter` and `adapters/eve`: a persona compiled into an eve extension inside a template's project, the ownership manifest, the portability report
25. `docs/planning/25-agent-runner.md` — `donn agent create|sync|run|build|deploy|env|exec`; local, self-host and Vercel targets; secrets; driving the project-local eve CLI; a GitHub Actions spike
26. `docs/planning/26-gui.md` — the GUI: one React app served by the daemon (`donn ui`) and a Tauri desktop shell, the loopback bridge, the screens, the agent builder
27. `docs/planning/27-first-publish.md` — the first npm publish: 13 runtime packages public under Apache-2.0, `getdonn/donn` public, trusted publishing with provenance from a tag-triggered `release.yml`, a Verdaccio rehearsal, release 0.14.0

## Key decisions already made (don't relitigate without reading the doc that made them)

- Harness-neutral core; adapters report what they drop (`CompileReport`). No silent loss.
- Open core: spec/resolver/adapters/CLI/daemon/mod are OSS (likely Apache-2.0); control plane,
  console, policy, gateway integrations, deploy are a **separate private repo** that depends only
  on published `@getdonn/*` packages.
- Secrets are `secret://` references in persona files; values only ever land in gitignored builds.
- No vector DB / document ingestion. Knowledge = pointers to MCP-reachable sources.
- Claude Code adapter: plugin + settings fragment + instructions via system-prompt/SessionStart;
  relaunch wrapper is the deterministic switch, mod is status/nudge only; org locks compile to
  managed settings. (See `03` Appendix A — a plugin cannot carry CLAUDE.md or permissions.)
- Desktop presence = a local daemon (`donnd`) first; tray app is a thin client of it, later.
  _Revised 2026-10-24 (`26`):_ a web and desktop GUI over the daemon is planned, still with no
  logic of its own.
- Agents are optional (`23`–`25`): eve is the first agent framework; local and self-host are
  first-class, Vercel is an option; model calls go through the org's gateway when there is one.
- Critical path is `spec → resolver → adapter-sdk → adapters/claude-code`; one person, serial.

## Current phase

**Phase 1** (see roadmap). Phase 0 shipped as `v0.1.0`: `@getdonn/spec`, the resolver with
its fixture suite (`src/packages/resolver/fixtures/`, the executable merge spec) and
`explain()`, and the `spikes/claude-code` and `spikes/agents-md` findings. Phase 1 starts with
`docs/planning/05-adapter-sdk.md`: `@getdonn/adapter-sdk` and `adapters/claude-code` (relaunch
path, conformance kit, golden builds in `test/golden/`, opt-in `DONN_E2E=1` end-to-end test) are
built, and so is the core loop from `docs/planning/06-cli-core-loop.md`: `store-local`,
`secrets`, `executor` and `donn resolve|compile|claude` (opt-in `DONN_E2E=1` runs the built
binary against real `claude`). Spec 07 (`switch`, `init`, `doctor`, CLI hardening) and spec 08 (plugin adapters and secret providers, the built-in `keychain` provider, `diff`, hardening) are built too, and so is spec 09 (the Claude Code mod: band, nudge, `/persona`, `donn mod install`). Spec 10 (live in-session switching: session plugin folders, `donn live`, `/persona use`) is built too; findings in `spikes/live-smoke/FINDINGS.md`. Phase 2 has started: spec 11 (`agents-md`, `donn write`), spec 12 (the Codex adapter, `donn codex`), spec 13 (the capability matrix: `donn capabilities`, `docs/capabilities.md`), spec 14 (the daemon's first slice: `donn daemon`, `donn status`, live sessions refreshed on persona edits), spec 15 (mod transport: `/persona` through the daemon) and spec 16 (the daemon service: `donn daemon install|uninstall`, auto-start in `claude`/`codex`, the race-safe lock) and spec 17 (`switch` reports per harness) are built; Phase 2's roadmap items are done; Phase 3 has started with spec 18 (registry contract and client, built ahead of a design partner); spec 21 (managed settings: `policy`, `donn managed build|install|uninstall|check`, the registry's `/v1/managed/bundle`, a real Claude Code e2e) is built (the open-source half of Claude Code enforcement); also open: the hardening pass on spec 16's deferred minors, or the rest of Phase 3 (spec 18 built the registry contract and client; spec 19 the shared publish engine; the control plane lives in a private repo; identity's open-source half is spec 20). The name is chosen
(donn) and the rename is done (spec 22; release 0.13.0 follows; `donn migrate` moves an existing
install); the first npm publish is done: spec 27 shipped release 0.14.0 on 2026-10-24, with the 13
runtime packages on npm (trusted publishing, provenance) and `getdonn/donn` public. Next: the agents
and GUI track, specs 23–26 (designed 2026-10-24): spec 23 is built (`models` and `agents` in the
spec, the resolver and the capability matrix) and spec 24 is built (`AgentAdapter`,
`@getdonn/adapter-eve`, the agent half of the capability matrix; the adapter becomes the 14th public
package with the next release); specs 25–26 are designed, not built.

## Conventions (once code exists)

- TypeScript, pnpm, turborepo, zod, vitest, changesets — latest versions.
- Node: develop on 26 (pnpm downloads it via `devEngines.runtime`; system Node is irrelevant);
  `engines` floor is >=24, and `@types/node` tracks the floor, not the dev version.
- Workspaces live under `src/apps/*` and `src/packages/*` (adapters in `src/packages/adapters/*`),
  never at the repo root. The runtime packages are public (13 at 0.14.0; `@getdonn/adapter-eve` is the 14th from the release that carries spec 24; published from `release.yml`, spec 27); tooling (`eslint-config`, `typescript-config`, `release`) and the root stay `"private": true`.
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
