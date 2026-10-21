# Live switching smoke run — findings

> 2026-10-21. Interactive Claude Code sessions driven from a herdr pane, against a throwaway
> `ZZPERSONA_HOME` and project; the mod loaded with `--plugin-dir`. Personas `team/a` (skill
> `zz-skill-a`, "end every reply with ALPHA") and `team/b` (skill `zz-skill-b`, "end every reply
> with BRAVO", an MCP server and an extra deny rule). Throwaway probes: nothing here is imported.

## Results (after the fixes below)

| Step | Result |
|---|---|
| `zzpersona claude team/a` | band `persona team/a · argument`; Claude lists only `zz-skill-a` and ends with ALPHA |
| `/persona use team/b` | message lists held MCP servers and permissions, and that team/b denies more; Claude Code prints `zzp-team--b: loaded (new in plugins/)` then `zzp-team--a: unloaded (gone from plugins/)` (copy before remove; no duplicate from staging); band `persona team/b · live · MCP and permissions from team/a` |
| ask | "I'm running team/b … end every reply with BRAVO" |
| `/compact`, ask again | still team/b and BRAVO |
| `/persona use team/a` | team/a's plugin back, ALPHA again, band `persona team/a · argument` |
| `/persona switch team/b` | `team/b is now your default.` plus the live lines; `state.json` default is team/b |
| `/exit` | the session folder is removed |

Checked on both Claude Code 2.1.304 (Homebrew, what `zzpersona claude` found on `PATH`) and
2.1.306.

## What the first run found, and the fixes

1. **`prompt.compose` is fixed after a session's first request.** The spec's design added the
   superseding section in `prompt.compose`; after a switch it never reached the model ("no team/b
   instructions have reached me"). Probes showed: a section added before the first request is sent;
   one added later is never sent, with or without `$.ui.invalidate("prompt.section")`; a
   `prompt.section` hook on a mod-added section has no effect; a `prompt.section` hook that
   **appends to an engine section** (`env_info_simple`) **does** change the next request after
   `$.ui.invalidate("prompt.section")`. Fix: the mod appends the superseding text to an engine
   section through `prompt.section` and invalidates it on every switch and after a reload.
2. **Not every composed section passes through `prompt.section`.** The first anchor, the last
   composed session section, was `total_tokens`, which `prompt.section` is never called with (a
   debug log listed the names it is called with, and that compose runs after them). Fix: the anchor
   is the last composed session section that `prompt.section` has been called with.

## The `prompt.compose` check from the design (spec 10 §5)

`--append-system-prompt-file` text is not a `prompt.compose` section (the sections are the engine's
own: `lean_body`, then `communication` … `total_tokens`), so a mod cannot replace or drop it. That
is why the live instructions supersede it by name rather than replace it.

## Notes

- Two Claude Code installs on this machine: the interactive `claude` is an alias to
  `~/.claude/local/claude` (2.1.306), while `PATH` has the Homebrew cask (2.1.304), which
  `zzpersona claude` launches. `doctor`'s `claude` check reports the `PATH` one.
- The model's answers can mention the previous persona's rule once ("my earlier ALPHA was a
  mistake"); it follows the new one.
