# Spike: what a Codex CLI launch can carry per invocation — findings

> 2026-10-21. Codex CLI **0.163.0** on macOS: `codex exec` runs and one interactive TUI session
> in a herdr pane, plus the Codex source docs (via Context7). Throwaway: nothing here is imported.
> `run.sh <scratch> <probe>` reruns a probe. Spend: six `exec` calls (~35k tokens) and one TUI turn.

## Recommendation

Build `adapters/codex` on the relaunch model, like Claude Code: everything goes on the command line
as `-c` overrides (a session-flags config layer), nothing is written to `~/.codex` or the repo.

| Persona field | Per-launch mechanism | Status |
|---|---|---|
| instructions | `-c developer_instructions="…"` (added to Codex's own; **not** `model_instructions_file`, which replaces Codex's base instructions) | **native** — ran in `exec` and the TUI; ~40 KB inline worked |
| mcp.servers (stdio) | `-c mcp_servers.<name>={command=…,args=[…],env_vars=["VAR"]}` | **native** — ran; the server started |
| secrets | the launch environment, forwarded by name with `env_vars` | **native** — ran: the server saw `ZZ_TOKEN` (value never printed) |
| MCP tool permissions | `-c mcp_servers.<name>.default_tools_approval_mode="approve"` (and per-tool `tools.<t>.approval_mode`) | **native for MCP tools** — ran: without it `exec` refuses MCP calls under approval `never` |
| shell/file permissions | `-s read-only \| workspace-write \| danger-full-access`, `-a on-request \| never` | **approximated** — sandbox ran (read-only blocked a write); no per-rule allow/deny on the command line |
| knowledge | rendered into the instructions | advisory |
| skills | none per launch: skill roots are `~/.codex/skills`, `~/.agents/skills`, repo `.agents/skills`, plugins, and "extra roots" set only through the app-server protocol | **dropped** |
| hooks | `-c hooks.PreToolUse=[…]` is discovered, but **untrusted hooks do not run**; they ran only with `--dangerously-bypass-hook-trust`, which trusts every hook including the repo's | **dropped** (never pass the bypass) |
| model | `-m` / `-c model=` | native (targets.codex) |

## Details

- **Instructions:** `developer_instructions` is additive; Codex also reads the repo's `AGENTS.md`
  (spec 11). `model_instructions_file` replaces the built-in base instructions and must not be used.
  A ~40 KB value passed inline worked (spec 05 open question 2: no file option is needed at
  persona sizes; macOS `ARG_MAX` is ~1 MB).
- **MCP:** `env_vars` forwards variables **by their own name**, so two servers wanting the same
  variable name with different secrets would collide; Claude Code's `ZZP_SECRET_<n>` placeholder
  trick does not apply unless Codex's static `env` table can reference the launch environment (not
  probed).
- **Approvals in `exec`:** with approval policy `never`, MCP calls need per-server or per-tool
  approval; the persona's `permissions.allow` entries for MCP tools map onto that.
- **Hooks:** hook trust is stored in the user's `config.toml` (`[hooks.state]`, keyed by source and
  hash) and read from the user and session-flags layers. Pre-trusting persona hooks from the
  session-flags layer might be possible but depends on Codex's internal hash; not pursued.
- **Folder trust:** like Claude Code, Codex asks to trust a new folder once and saves the answer.
- `codex --strict-config` rejected even a known-good key here (likely the user's own config), so it
  could not confirm config keys; the skills finding rests on the source docs.

## Open questions for the adapter spec

1. Secrets for two MCP servers that use the same variable name (does Codex's `env` table expand
   `${VAR}` from the launch environment?).
2. Persona hooks: a one-time trust flow, or report them as dropped for good.
3. Persona skills: wait for a per-launch skill root, or install a plugin (writes `~/.codex`).
4. Mapping `permissions.deny/ask/allow` for shell commands onto sandbox and approval policy:
   which combination is closest, and how to report it.
