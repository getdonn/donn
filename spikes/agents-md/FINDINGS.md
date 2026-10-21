# Spike: AGENTS.md as the lowest-common-denominator target — findings

> 2026-10-21. Codex CLI **0.163.0** and GitHub Copilot CLI **1.0.78** on macOS (ran); Gemini
> CLI and Claude Code from docs (via context7). Throwaway: nothing here is imported.
> `run.sh <scratch> [codex|copilot|both]` rebuilds the probe and runs it. Spend: one Codex
> `exec` (6.3k tokens) and two Copilot `-p` calls (0.33 premium requests).

## Recommendation

1. **`AGENTS.md` works as the lowest common denominator only as a file in the repo.** Every
   tool tested reads `<repo>/AGENTS.md` and nested ones, but none reads an `AGENTS.md` from a
   location we control outside the repo without switching its whole config home. So
   `adapters/agents-md` is a **file-overlay** target: it renders instructions (and policy as
   text) into one `AGENTS.md` for a project that commits its persona, or for tools that have no
   adapter. Its `CompileReport` drops skills, MCP servers, hooks, and enforcement of permissions.
2. **Relaunch generalizes.** Both Codex and Copilot accept a whole persona at launch, outside
   the repo, the same way Claude Code does: instructions plus MCP servers plus tool permissions,
   as flags or env vars. Thin `codex` and `copilot` adapters that wrap the binary are cheap and
   lose far less than `agents-md`. This changes the Phase 2 plan: build `agents-md` (trivial)
   **and** `codex` as the real second adapter; `copilot` is a close third.
3. **Persona instructions add to the repo's own `AGENTS.md`; they never replace it.** Every tool
   concatenated both. That is the right default (the repo's rules still apply), but the adapter
   cannot guarantee precedence, so conflicting persona and repo rules must be resolved in text.

## Per-tool results

| | Codex 0.163.0 | Copilot CLI 1.0.78 | Gemini CLI | Claude Code |
|---|---|---|---|---|
| Repo `AGENTS.md` | ✅ ran | ✅ ran | only if `context.fileName` lists it (default `GEMINI.md`) | only when there is no `CLAUDE.md`, by default (v2.1.277+) |
| Nested `AGENTS.md` | ✅ ran: concatenated root → cwd, never past the repo root | ✅ ran: discovered cwd → git root | hierarchical: global, root, subdirectories | via `CLAUDE.md` imports |
| Global / user file | `$CODEX_HOME/AGENTS.md` (`AGENTS.override.md` wins) — docs | `~/.copilot/instructions/**/*.instructions.md` — docs | `~/.gemini/GEMINI.md` — docs | `~/.claude/CLAUDE.md` |
| **Out-of-repo, per launch** | ✅ `-c developer_instructions="…"` (ran: `ZZ-DEV`) | ✅ `COPILOT_CUSTOM_INSTRUCTIONS_DIRS=<dir>` with **`*.instructions.md` only** (ran: `ZZ-PERSONA-INSTR` yes, `AGENTS.md` there no — confirmed twice) | `context.includeDirectories` in settings — docs | ✅ `--append-system-prompt-file` (Claude Code spike) |
| MCP per launch | ✅ `-c mcp_servers.<name>={command=…,args=[…]}` (ran: tool registered) | ✅ `--additional-mcp-config @file.json` (ran: `pong: ZZ-MCP-CODEWORD`) | `mcpServers` in settings.json — docs | ✅ `--mcp-config` |
| Tool permissions per launch | approval/sandbox via `-c approval_policy`, `-c sandbox_mode` — docs. MCP calls in `exec` were refused under `approval_policy = never` (ran) | ✅ `--allow-tool` / `--deny-tool` globs, e.g. `shell(npm run test:*)` (ran: `--allow-tool zz-probe`) | `tools.exclude` — docs | ✅ `--settings` |
| Size cap | `project_doc_max_bytes`, total across all files — docs (default not confirmed here) | none documented | `context.discoveryMaxDirs` (200 dirs) | 10k chars for SessionStart context |

Notes from the runs:
- **Codex trust:** the docs say untrusted projects skip `AGENTS.md` entirely, yet a fresh,
  never-seen scratch repo loaded it. Unknown is not untrusted; an explicitly untrusted project
  would lose repo instructions, but `-c developer_instructions` is unaffected.
- **Codex `AGENTS.override.md`** shadows `AGENTS.md` in the same directory. Tempting as a
  persona drop-in, but it *replaces* the repo's file in that directory, and it is still a file
  in the repo. Do not use it.
- **`CODEX_HOME` / `COPILOT_HOME`** would let us drop a global `AGENTS.md`, but they also move
  each tool's login state (for Codex, `auth.json` lives there), the same problem as
  `CLAUDE_CONFIG_DIR`. Rejected for the same reason.
- **Copilot reads `CLAUDE.md` too** (and `.claude/settings*.json` for repo config), and
  deduplicates identical instruction files. A repo with both `CLAUDE.md` and `AGENTS.md` sends
  both unless they are identical.

## What this means for the capability matrix (`03`)

| IR field | codex | copilot (CLI) | agents-md (generic) |
|---|---|---|---|
| instructions | native, per launch (`developer_instructions`) | native, per launch (`.instructions.md` dir) | native (repo file only) |
| skills | ? (not probed) | native dirs (`~/.copilot/skills`, plugins) — not probed | text only |
| mcp.servers | native, per launch | native, per launch | — |
| permissions | partial: approval policy and sandbox, not per-rule | allow/deny tool globs per launch | text only |
| hooks | ? (has hooks; not probed) | `.github/hooks/`, `~/.copilot/hooks/` — not probed | — |
| secrets refs | via env | via env (`${VAR}` in MCP config) | — |

## Not covered

- Skills and hooks for Codex and Copilot: both have them, but the formats were not probed. Do
  that when their adapters start (Phase 2).
- Codex per-tool MCP approval keys: the run showed MCP calls need approval in `exec`; the
  config key that pre-approves one server's tools was not found in this pass.
- Gemini CLI is not installed; its column is docs only.
