# Mod smoke run and spike checks A and B — findings

> 2026-10-21. Interactive Claude Code sessions (v2.1.304 and v2.1.306) driven from a herdr pane,
> against a throwaway `ZZPERSONA_HOME` and project. The mod was loaded with `--plugin-dir`, so no
> user configuration was changed. Throwaway: nothing here is imported.

## Mod v1 (spec 09)

| Step | Result |
|---|---|
| `zzpersona claude` in a project | band `persona project/persona · project`; no nudge (the folder selects the same persona) |
| `/persona list` | lists personas and marks `(this session, this folder)`. Layers were in alphabetical order; **fixed** to inheritance order |
| `/persona switch team/payments` | saves the switch and prints the restart text |
| `/exit`, `zzpersona claude -- --continue` | the conversation comes back (a word planted before the exit is remembered) and the band shows `persona team/payments · switch` |
| ...but the new persona's instructions | **not applied.** Asked to quote its "You are running the …" lines, the resumed session gave only the old persona's line, although the relaunch passed the new `--append-system-prompt-file`. A fresh `zzpersona claude` (control) quoted both lines of the new persona. A resumed session keeps the system prompt it began with |
| plain `claude` in the project | band `persona none · this folder uses team/payments`; nudge `⚠ zzpersona: this folder uses team/payments; start with zzpersona claude to load it` |
| `/persona` in that session | `this session runs no persona (it was not started by zzpersona claude)` / `this folder uses team/payments (switch)`; the nudge clears |

**Change made:** the post-switch text now recommends `zzpersona claude` and says that
`zzpersona claude -- --continue` keeps the conversation but not the new persona's instructions.

## Check A — plugin-folder hot swap: applies silently

`claude --plugin-dir <folder of plugins>` loads each child plugin (`zz-persona-probe:zz-probe-skill`
was listed). With the session running, the child was moved out and another added. Claude Code
printed `zz-persona-probe: unloaded (gone from plugins/)`, then `1 skill available`. Invoking the
removed skill failed with a tool error; the new plugin's skill was available. **No
`/reload-plugins` needed** for skills (v2.1.306). The model's own earlier answers still mention
the old skill until it is told, since they are in the conversation.

## Check B — instructions injected by `prompt.submit`: survive turns

A ten-line mod added one context line (`end every reply with the word MANGO`) to the first prompt
only. All three replies, including the two prompts without injection, ended with `MANGO`.
Not tested: whether it survives compaction (the spike's open point: re-inject after
`session.compact`).

## For spec 10 (live switching)

- Skills (and so the plugin's other components) can switch mid-session by swapping the child of a
  `--plugin-dir` folder of plugins: launch with the folder, not the plugin.
- Instructions can be delivered mid-session through `prompt.submit` context; the original
  `--append-system-prompt-file` text stays in the session, so the new instructions must say they
  supersede it.
- `--continue` is not a way to switch instructions.

## Files

- `../../src/packages/mod-claude-code` — the mod under test.
- The throwaway probe plugins and the check B mod lived in the session's scratch folder and were
  not kept.
