# Spike: Claude Code activation — findings

> 2026-10-21, Claude Code **v2.1.306**, macOS. Throwaway: nothing here is imported. Answers the
> five spikes in `docs/planning/03-architecture.md` Appendix A and recommends the v0 activation
> strategy. Evidence is either **docs** (code.claude.com, via context7) or **ran** (a command in
> this folder, output quoted). Total model spend: four Haiku calls, under $0.01.

## Recommendation

1. **Relaunch is the v0 switch, and it works end to end today.** `zzpersona claude` execs:
   ```
   claude --plugin-dir <build>/plugin --settings <build>/settings.json \
          --mcp-config <build>/mcp.json --strict-mcp-config \
          --append-system-prompt-file <build>/system-prompt.md
   ```
   Every persona component reached the session in one run, and the user's own plugins stayed
   loaded (see "Relaunch, end to end").
2. **Drop config-root swap (`CLAUDE_CONFIG_DIR`) for good.** It isolates fully, but each config
   directory has its own login, so every persona would need its own sign-in.
3. **In-session switching (Phase 1, mod) cannot rely on the `--settings` file.** It is read once
   at startup. Live permission changes must go through a watched file:
   `.claude/settings.local.json` is the only per-project option. The best in-session design is
   now: launch with `--plugin-dir <a folder of plugins>`, swap the child plugin to switch
   (skills, hooks and agents apply mid-session), write permissions to `settings.local.json`, and
   deliver new instructions from the mod's `prompt.submit` hook. MCP changes still need
   `/reload-plugins --force` or a new session. Needs the two manual checks below before it is
   designed.
4. **Locked-down orgs:** `disableSideloadFlags` kills `--plugin-dir` and `--mcp-config` (but not
   `--settings` or `--append-system-prompt-file`), and a deployed `managed-mcp.json` makes
   `--mcp-config` and `--strict-mcp-config` exit at startup. The adapter must detect both and
   fall back to an allowlisted marketplace; see spike 5.

## The five spikes

### 1. Does `CLAUDE_CONFIG_DIR` move `~/.claude.json`? — **Yes, and the login with it.** (ran + docs)

- **Ran** (`CLAUDE_CONFIG_DIR=<tmp> claude mcp add --scope user zz-cfgdir-probe …`): the server
  was written to `<tmp>/.claude.json`; the real `~/.claude.json` hash was unchanged
  (`273a9f8fef50ec15` before and after) and does not contain the probe.
- **Ran** (`CLAUDE_CONFIG_DIR=<tmp> claude -p "Reply with just: ok"`): `Not logged in · Please run /login`.
- **Docs** (authentication): "Each directory has its own settings, session history, and claude.ai
  login or API key."
- **Conclusion:** full isolation, but a separate login per persona. Not viable as a switch.

### 2. Is a mod's `/persona switch` acceptable UX? — **Deferred to Phase 1; constraints now known.** (docs)

A mod still cannot toggle plugins or run `/reload-plugins` (`$.settings` is read-only; no such
API in the mods reference). What it *can* do changes the design:
- `$.process.run` and `$.fs.write` can swap a plugin folder or rewrite `settings.local.json`.
- `prompt.submit` can append hidden `context` to the next prompt (see spike 3).
- Plugins added to or removed from a `--plugin-dir` **folder of plugins** apply mid-session in
  interactive sessions (v2.1.265+); if that would force a full re-read, Claude Code shows a
  notice to run `/reload-plugins` instead (docs: prompt-caching → "When plugin changes apply").

Whether the resulting flow feels acceptable can only be judged with a prototype mod: manual
check A below, then a Phase 1 prototype.

### 3. Can a mod inject instructions into the current session? — **Yes.** (docs)

`on('prompt.submit', …)` can return `next({ ...e, context: [...(e.context ?? []), text] })`,
adding hidden context to that prompt (docs: mods events). Injected once, the text lives in the
conversation history, not the system prompt, so it can be lost to compaction; re-inject on
`session.compact` or on the first prompt after it. `--append-system-prompt-file` (relaunch) has
no such problem.

### 4. Are MCP changes picked up mid-session? — **No, except plugin MCP via `--force`.** (docs)

- "Editing your MCP config does not by itself change the cache. The new config takes effect only
  after a restart" (docs: prompt-caching).
- Plugin MCP servers change on `/reload-plugins --force` (interactive), which invalidates the
  prompt cache; in `-p` sessions they wait for the next session (docs: prompt-caching).
- An SDK-only `RefreshMcpTools` tool exists (v2.1.211+, behind
  `CLAUDE_CODE_ENABLE_REFRESH_MCP_TOOLS=1`) but only re-lists tools of already-connected servers.

### 5. `disableSideloadFlags` + `strictKnownMarketplaces` — **marketplace path needs admin allowlisting.** (docs only)

- `disableSideloadFlags` rejects `--plugin-dir`, `--plugin-url`, `--agents`, `--mcp-config`, and
  folders in `CLAUDE_CODE_PLUGIN_DIRS`; Claude Code exits naming them. `--settings` and
  `--append-system-prompt-file` are **not** affected. Users can still `claude mcp add` or use
  `.mcp.json` unless `allowedMcpServers` restricts them.
- A deployed `managed-mcp.json` makes `--mcp-config` exit at startup on a workstation, and
  `--strict-mcp-config` exit everywhere (docs: managed-mcp).
- `strictKnownMarketplaces` accepts `directory`/`file` sources and a `pathPattern` regex, so a
  local persona marketplace (`~/.zzpersona/marketplace`) works **only if the admin allowlists
  that path**. Otherwise persona plugins must be published to an approved git marketplace —
  which is what the enterprise control plane would do anyway.
- Not run: testing needs a system-level managed settings file. The docs are explicit enough for
  the adapter design; verify on a managed machine before shipping the fallback.

## Relaunch, end to end (ran)

`build/` holds a hand-made persona build. Each component carries a codeword:

| Component | Mechanism | Result |
|---|---|---|
| Instructions | `--append-system-prompt-file build/system-prompt.md` | ✅ `ZZ-PROMPT-CODEWORD` reported |
| SessionStart context | plugin `hooks/hooks.json` | ✅ `ZZ-HOOK-CODEWORD` reported |
| Skill | plugin `skills/zz-probe-skill` | ✅ listed as `zz-persona-probe:zz-probe-skill` |
| MCP server | `--mcp-config build/mcp.json` | ✅ `persona_ping` returned `pong: ZZ-MCP-CODEWORD` |
| MCP isolation | `--strict-mcp-config` | ✅ only `zz-probe` visible; the user's context7 etc. hidden |
| Allow rule | `--settings`: `Bash(echo:*)` | ✅ `echo zz-allowed` ran without a prompt |
| Deny rule | `--settings`: `Bash(echo zz-denied:*)` | ✅ `permission_denials: ["echo zz-denied now"]` |
| User's plugins | (untouched) | ✅ all 15 `superpowers:*` skills still loaded |

One Haiku call, 5 turns, $0.0043. Note the plugin name prefixes skills
(`<plugin>:<skill>`): the adapter should name the plugin after the persona.

`--strict-mcp-config` is a product decision, not a given: it makes the persona the whole tool
set (good for governance) but hides the user's own MCP servers. Default to strict for org
personas; consider a `targets.claude-code.strictMcp: false` escape hatch.

## `--settings` is not hot-reloaded (ran, with control)

`settings-reload.mjs` runs one headless session with two turns and adds a deny for
`echo zz-two` to the settings file between them.

| Run | Rules file | Turn 2 `echo zz-two` |
|---|---|---|
| `flag` | passed with `--settings` | ran (no denial) |
| `flag`, repeated | passed with `--settings` | ran (no denial) |
| `local` (control) | `<cwd>/.claude/settings.local.json` | **denied** |

The control proves the harness can observe a reload, so the `--settings` file is read once at
startup. The docs list the watched files as user, project, local and managed; `--settings` is
not among them. This contradicts the in-session plan in Appendix A, which assumed hot reload.

## Manual checks (interactive only, ~2 minutes each)

Run these before designing the in-session switch (Phase 1):

**A. Plugin-folder hot swap.**
```
mkdir -p /tmp/zz-plugins && cp -R build/plugin /tmp/zz-plugins/zz-persona-probe
claude --plugin-dir /tmp/zz-plugins
# in the session: ask "list skills starting with zz-"  → expect zz-persona-probe:zz-probe-skill
# in another terminal: rm -rf /tmp/zz-plugins/zz-persona-probe
# back in the session: ask again → expect it gone, or a notice to run /reload-plugins
```
Record whether it applied silently, showed a notice, or needed a restart.

**B. Instructions via `prompt.submit` survive a turn.** Needs a 10-line mod; do it as the first
task of `mod-claude-code` in Phase 1, not here.

## Files

- `build/` — hand-made persona build used by the relaunch run (plugin validated with
  `claude plugin validate`; warnings only concern directory submission).
- `build/mcp-server.mjs` — minimal stdio MCP server, one tool.
- `settings-reload.mjs` — the two-turn hot-reload probe, `flag` or `local` mode.
