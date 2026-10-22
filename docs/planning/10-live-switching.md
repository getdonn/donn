# 10 — Live in-session persona switching (Claude Code)

> Status: design, 2026-10-21. Phase 1, sixth spec. Agreed in conversation section by section.
> Builds on spec 09 (the mod), `spikes/claude-code/FINDINGS.md`, `spikes/mod-smoke/FINDINGS.md`
> (checks A and B) and a `prompt.compose` check run while designing this spec (section 5). Built
> as a `gh stack`: layer 0 is this spec and its plan.

## Intent

`/persona switch` and the new `/persona use` change the running session's persona without a
restart, as far as Claude Code allows, and say exactly what did not change.

Done means: in a session started by `zzpersona claude`, switching persona swaps the persona's
skills, hooks and agents immediately and makes the model follow the new persona's instructions,
including after compaction; MCP servers and permissions stay as launched and the user is told so,
with the stricter-rules case called out.

## What can switch (from the spike, checks A and B, and the compose check)

| Part | Delivered by | Live? |
|---|---|---|
| Skills, hooks, agents | the persona plugin | **yes**: a child of a `--plugin-dir` folder of plugins is swapped mid-session, silently (check A) |
| Instructions | `--append-system-prompt-file` | **added to, not replaced**: a mod's `prompt.compose` section is read by the model and rebuilt every request; the launch file's text is not a compose section and stays |
| Permissions | `--settings` | no (only `.claude/settings.local.json` reloads; rejected, below) |
| MCP servers | `--mcp-config` | no (restart; secrets come from the launch environment) |

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| Plugin and instructions switch live; permissions and MCP stay as launched, and the mod says so | Write permissions into the repo's `.claude/settings.local.json`; also move MCP into the plugin and use `/reload-plugins --force` | Nothing written into the user's repo; no block left behind by a crash; MCP servers with secrets could not switch anyway |
| `/persona switch` saves and applies live; `/persona use` applies to this session only | `switch` live-only plus `/persona save`; no session-only form | One verb for the common case; trying a persona does not change the folder's choice |
| Keep the launch instructions; on a switch add a `prompt.compose` section that supersedes them by name | Let the mod carry instructions from launch (no `--append-system-prompt-file`) | A disabled or refused mod would silently drop all instructions; the launch file keeps headless runs and mod-less sessions correct |
| The CLI does the switch (`zzpersona live`); the mod stays a thin client | The mod copies plugins itself | One place for building and copying; the mod keeps calling only the CLI (spec 09) |

## 1. Launch

`zzpersona claude` in relaunch mode creates a **session folder** `<home>/sessions/<id>/` with
`plugins/<plugin name>/`, a copy of the build's plugin (a copy, as check A verified), and launches
with `--plugin-dir <home>/sessions/<id>/plugins` in place of the plugin itself. It writes
`<home>/sessions/<id>/launched.json` (`{ "persona", "source", "pid" }`) and adds
`ZZPERSONA_SESSION=<home>/sessions/<id>` to the launch environment (spec 09's variables stay). When
`claude` exits, `zzpersona claude` removes the folder; `doctor --fix` removes session folders older
than a day whose `pid` is not alive.

The Claude Code adapter starts `system-prompt.md` with `## zzpersona persona: <ref>`. Settings,
MCP and the instructions file are passed as before. Partial mode (managed settings block
`--plugin-dir`) launches as before, with no session folder. `zzpersona claude -- --continue` gets
a new session folder with the current persona.

## 2. `zzpersona live <persona> --session <dir> [--json]`

1. Resolve and compile `<persona>` for Claude Code (`prepareBuild`); no secrets are resolved.
2. Write the build (atomic version swap, as a launch).
3. Copy the build's plugin into `<dir>/plugins/<plugin name>`, then remove every other child of
   `<dir>/plugins` (copy before remove: the session is never without the persona's skills). The same
   persona again refreshes its copy.
4. **Held:** compare the new persona with the launched one (`launched.json`) using `diff()` (spec
   08) over `mcp.*` and `permissions.*`; `held` lists `"mcp"` and/or `"permissions"` when they
   differ. `stricter` is true when the new persona's `permissions.deny` has a rule the launched one
   lacks.
5. Write `<dir>/live.json`: `{ "persona", "previous", "instructions", "held", "stricter",
   "appliedAt" }`.

`--json`: `{ "persona", "previous", "launched", "instructions", "held", "stricter", "plugin" }`.
`instructions` is the new `system-prompt.md` text (no secret values; builds never hold any).
Errors: `live-unavailable` (no session folder; a partial-mode session; the folder is gone), and the
usual resolve and compile errors. On any error the old plugin stays in place.

## 3. The mod

- **State.** After a live switch the mod keeps `live` from the CLI's answer; on `session.start` it
  reads `<session>/live.json`, so a reload keeps it.
- **Instructions.** While the live persona differs from the launched one, a `prompt.compose` hook
  adds one section, id `zzpersona:live-persona`, scope `session`, after what `next(e)` returns:

  ```
  The persona for this session is now <new>. Disregard the section headed
  "## zzpersona persona: <launched>"; the instructions below replace it.

  <the new system-prompt.md text, which starts with "## zzpersona persona: <new>">
  ```

  Switching back to the launched persona removes the section.
- **Band.** `persona <new> · live`, or `persona <new> · live · <held> from <launched>` (`MCP and
  permissions`, `MCP`, or `permissions`).
- **Nudge.** Compares this folder's selection with the live persona.
- **`/persona use <p>`** runs `zzpersona live`; **`/persona switch <p>`** runs `zzpersona switch`
  (save) and then `zzpersona live`. Both print:

  ```
  team/platform is now live in this session (skills, hooks, agents, instructions).
  Still from team/payments until you relaunch: MCP servers, permissions.
  To apply those too, exit and run: zzpersona claude
  ```

  with the "Still from" lines only for what is held, `team/platform denies more than
  team/payments; those rules apply after a relaunch.` when `stricter`, and, for `switch`, what was
  saved. In a session without `ZZPERSONA_SESSION`, `use` says live switching needs a session started
  by `zzpersona claude`, and `switch` saves as in spec 09.
- The mod still never starts a turn, edits settings or repo files; only the CLI writes, under
  `<home>/sessions/`.

## 4. Failures

| Case | Result |
|---|---|
| No `ZZPERSONA_SESSION` | `use` explains; `switch` saves only |
| Partial-mode session | `live-unavailable: managed settings block --plugin-dir` |
| The persona fails to resolve or compile | the CLI's error; old plugin and instructions stay |
| Session folder gone | `live-unavailable: the session folder is gone; relaunch` |
| CLI unreachable | `zzpersona unavailable: <reason>` (spec 09) |

## 5. The `prompt.compose` check (2026-10-21, Claude Code 2.1.306)

A throwaway mod logged the sections `prompt.compose` returns: `lean_body` (shared), then
`communication`, `pronouns`, `action_caution`, `session_guidance`, `memory`, `env_info_simple`,
`context_management`, `act_dont_rederive`, `endconv_deferred_hint`, `total_tokens` (session). The
`--append-system-prompt-file` text is **not** among them, and a marker in it was never seen, so a
mod cannot replace or drop it. A section the mod **added** was read by the model (a fresh session
quoted the added line, then the launch file's). Recorded again in `spikes/live-smoke/FINDINGS.md`.

## 6. Stack and testing

| Layer | Contents |
|---|---|
| 0 `spec` | this spec and its plan |
| 1 `adapter` | the instructions heading; `activate` launching with a folder of plugins; golden builds |
| 2 `session` | session folder create/copy/cleanup, `launched.json`, `ZZPERSONA_SESSION`; `doctor --fix` for orphaned session folders |
| 3 `live` | `zzpersona live`: compile, swap, `held`/`stricter`, `live.json` |
| 4 `mod-live` | `/persona use`, live `switch`, the compose section, band and nudge from live state, reload recovery |
| 5 `smoke-e2e` | herdr smoke run, `spikes/live-smoke/FINDINGS.md`, changeset, docs |

- **Unit:** the heading and the plugin-folder launch; session folder lifecycle including a failed
  launch; `live`'s copy-then-remove order, `held` for equal and differing personas, `stricter`, and
  every error leaving the old plugin; the mod's section text, no section after switching back, band
  and nudge with `held`, reload from `live.json`.
- **Smoke (herdr pane):** `zzpersona claude` on A; `/persona use B` → B's skill listed, A's gone,
  the model quotes B's instructions as current; `/compact`, quote again → still B; the band shows
  what is held; `/persona use A` → the section is gone; `/persona switch B` also saves.

## Non-goals

Live permissions or MCP; live switching in partial mode; other harnesses; the daemon.

## Open questions

1. How reliably the model follows "disregard" over a long session. The smoke run checks the short
   case.
2. Each switch costs one prompt-cache miss.
3. If Claude Code exposes the launch instructions as a compose section, the mod can replace them
   outright; the heading makes that a small change.

## Amendments from implementation and the smoke run (2026-10-21)

Made while building this spec (`docs/plans/2026-10-21-live-switching.md`); see
`spikes/live-smoke/FINDINGS.md`. Each overrides the section it names.

- **§3 instructions** are delivered through `prompt.section`, not `prompt.compose`: Claude Code
  fixes the composed section list after a session's first request, so a section added on a later
  switch is never sent. The mod appends the superseding text (unchanged wording) to an engine
  section, the last composed session section that `prompt.section` is called with (not every
  composed section is), and calls `$.ui.invalidate("prompt.section")` after each switch and after
  restoring from a reload. Verified on Claude Code 2.1.304 and 2.1.306, including after `/compact`.
- **§1 launch** keeps the adapter's `activate` unchanged: `zzpersona claude` replaces the plan's
  `--plugin-dir` value with the session folder (the SDK contract stays as it is).
  `system-prompt.md` is always written, with the heading, even for a persona with no instructions.
- **§2** the new plugin is staged in the session folder (beside `plugins/`) and renamed in, so
  the watcher never sees a half-copied plugin; `live --show` reports the state for the mod.
  Errors read `live switching is unavailable: <reason>`.
- **§3 reload** the mod reads the live state through `zzpersona live --show`, keeping spec 09's
  rule that the mod only calls the CLI.
- **§1 launch record** `launched.json` also holds `overlay` and a `snapshot` of what was launched
  (`mcp`, `permissions`, and `settings` = `targets.claude-code`); **§2** `held` and `stricter`
  compare the new persona with that snapshot, so an edited or broken launched persona neither skews
  them nor blocks a switch, and the new persona is resolved with the launch's overlay setting.
- **§2 `held`** gains `"settings"`: `targets.claude-code` (model, env, `permissions.defaultMode`…)
  is in `--settings`, which does not reload. The band lists held parts ("MCP, permissions and
  settings"); the message names them ("Claude Code settings").
- **§2** the swap and the `live.json` write run under a lock on the session folder.
- **§3** the relaunch advice names the persona: `To apply those too, exit and run: zzpersona claude
  <persona>`, since `/persona use` saves nothing.


### Amendment: the daemon's refreshes (2026-10-21)

From the daemon (`docs/planning/14-daemon.md`, "From the smoke run"). Each overrides the section it
names.

- **§3 instructions** the superseding section now also applies when the live persona is the
  launched one (after switching back, or after the daemon refreshes it from an edit), reading `The
  instructions for this session's persona <p> were updated.` in place of `The persona for this
  session is now <new>.`; the rest of the text is unchanged. "Switching back to the launched
  persona removes the section" no longer holds: it carries the launched persona's current
  instructions.
- **§3 state** besides `session.start` and its own commands, the mod reads `<session>/live.json`
  itself with `$.fs.read` in a `prompt.submit` hook and adopts it when `appliedAt` changed. This is
  a file read, not a CLI call: an exception to the "only calls the CLI" rule above, kept to the one
  file the CLI writes for it, because it runs every turn.
