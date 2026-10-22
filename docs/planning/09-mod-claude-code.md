# 09 — The Claude Code mod: status, nudge, `/persona`

> Status: design, 2026-10-21. Phase 1, fifth spec. Agreed in conversation section by section.
> Builds on `03-architecture.md` Appendix A (activation strategy), `spikes/claude-code/FINDINGS.md`
> and specs 05–08. Live in-session switching is spec 10, after the spike's manual checks A and B.
> Built as a `gh stack`: layer 0 is this spec and its plan.

## Intent

Inside a Claude Code session you can always see which persona is active and why; you are nudged
when the folder you are in implies a different one; and you can list and switch personas without
leaving, with an honest answer about what applies now and what needs a restart.

Done means: `zzpersona claude` sessions show their persona above the prompt; a plain `claude`
session in a project that has a persona says how to load it; `/persona list|switch|clear` work
in-session; and the mod degrades to a clear "unavailable" message, never a crash, when the CLI
cannot be reached.

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| v1 shows and saves; live switching is spec 10 | Run manual checks A/B now and design live switching here; one spec with a spike layer | v1 needs neither check; live switching's design depends on their results |
| One standalone mod, installed once (`zzpersona mod install`) | The mod inside every persona build; both | Loads in plain `claude` too, which is where the nudge matters; one copy, not one per build |
| The mod calls the CLI (`$.process.run`, cached) | Bundle store/resolver/selection into the mod; read files directly | One source of truth for selection and error messages; no drift between mod and CLI |
| The active persona reaches the mod through launch environment variables | The mod infers it | Known exactly at launch; works even when `process.run` is blocked |
| Plugin names map `/` to `--` | Keep `/` → `-`; append a hash | Unambiguous because a ref segment never contains `--`; still readable |

## 1. Package, install, data flow

`src/packages/mod-claude-code` (`@zzpersona/mod-claude-code`) builds a plugin directory:

```
dist/mod/
├── .claude-plugin/plugin.json      name "zzpersona", version = the package version, userConfig
└── hooks/
    ├── hooks.json                  { "modules": ["./register.js"] }
    └── register.js                 one bundled ES module, no runtime dependencies
```

**Install.** `zzpersona mod install` copies the built mod to `<home>/mod/` and registers it as a
user-scope plugin with Claude Code's own CLI, printing exactly what it ran; `zzpersona mod
uninstall` reverses both. The registration command (a local marketplace entry, or installing the
directory) is fixed during planning against the plugin docs and verified with the real `claude`.
`doctor` gains a `mod` check: installed or not (`warn`, fix `zzpersona mod install`), and a
version that differs from the CLI's (`warn`, same fix).

**Launch environment.** `zzpersona claude` adds to its launch step's `env` (refs and paths only):
`ZZPERSONA_PERSONA=<ref>`, `ZZPERSONA_SOURCE=argument|switch|project|default`, and
`ZZPERSONA_PROJECT=<repo>` inside a project. `--dry-run` shows them.

**Data flow.** At `session.start` the mod reads those variables (no CLI needed), then runs
`zzpersona switch --json` in the session's directory in the background and caches the answer.
`/persona` forms run the matching CLI command with `--json`. CLI calls have a 5 s timeout. Failure
reasons: `zzpersona not found on PATH` (exit 127), the CLI's `--json` error message (non-zero
exit), `blocked by policy` (the runtime refuses `process.run`), `timed out`. Each reaches the user
once as a status line, never as a thrown error.

## 2. What the mod shows

**Band** (`ui.render`, component `AbovePrompt`), one dim line, only when there is something to
say. The mod keeps what other mods draw (its tree includes `await next(e)`).

| Session | Band |
|---|---|
| Launched by `zzpersona claude` | `persona <ref> · <source>` |
| Plain `claude`; this folder has a project persona or a switch | `persona none · this folder uses <ref>` |
| Plain `claude`; nothing for this folder, or only the default | nothing |

**Nudge** (`$.ui.status`), at most once per session; any `/persona` command clears it.

| When | Nudge |
|---|---|
| Launched with A; this folder selects B (a newer switch, or `zzpersona claude A` inside B's project) | `this folder uses <B> (<source>); this session runs <A>. /persona switch <B>, then relaunch` |
| Plain `claude`; this folder's project or switch selects a persona | `this folder uses <ref>; start with zzpersona claude to load it, or zzpersona claude -- --continue to keep this conversation` (the resume hint added 2026-10-22) |
| The CLI cannot be reached | `zzpersona unavailable: <reason>` |

Selection that comes only from the default never nudges a plain `claude` session.

**Settings** (`userConfig` in the manifest): `nudge` (default `true`), `band` (default `true`).

The mod never changes the session's persona, injects instructions, or starts a turn.

## 3. `/persona`

Registered at `session.start`, argument hint `[list | switch <persona> [--default] | clear [--default]]`.
Command output lands in the transcript, where Claude reads it; it carries refs and paths only.

| Command | Runs | Prints |
|---|---|---|
| `/persona` | `zzpersona switch --json` | this session's persona and source; what this folder selects, if different |
| `/persona list` | `zzpersona list --json` | personas by layer; marks this session's and this folder's |
| `/persona switch <p> [--default]` | `zzpersona switch <p> [--default] --json` | what was saved, then how to apply it |
| `/persona clear [--default]` | `zzpersona switch --clear [--default] --json` | what was cleared, and what this folder selects now |

After a switch:

```
team/platform is now used for /Users/you/repo.
This session still runs team/payments. To apply it, exit and run:
  zzpersona claude -- --continue
(--continue resumes this conversation with the new persona.)
```

If the smoke test (section 5) shows `--continue` does not carry the conversation over, the text
says `zzpersona claude` instead. An unknown form prints the usage line; a CLI error prints its
message.

**`zzpersona list [--json]`** (new CLI command): every available persona (`store.list()`), grouped
by layer in text; `--json` is `{ "personas": [{ "ref", "layer" }] }`.

## 4. Plugin names

`pluginName(ref)` becomes `zzp-` + the ref with `/` replaced by `--`: `team/platform-payments` →
`zzp-team--platform-payments`, `team/platform/payments` → `zzp-team--platform--payments`. Ref
segments are kebab-case without `--`, so the mapping is one-to-one. Golden builds change; spec 05
open question 3 gets a dated note.

## 5. Stack and testing

| Layer | Contents |
|---|---|
| 0 `spec` | this spec and its plan |
| 1 `plugin-name` | `/` → `--`; golden builds |
| 2 `cli-list-env` | `zzpersona list [--json]`; the `ZZPERSONA_*` launch variables |
| 3 `mod` | `@zzpersona/mod-claude-code`: band, nudge, `/persona`, CLI runner and failures, plugin build |
| 4 `mod-install` | `zzpersona mod install|uninstall`; doctor's `mod` check |
| 5 `smoke-e2e` | `claude plugin validate`; opt-in e2e; herdr smoke run and findings; changeset; docs |

- **Unit:** the mod's decisions are pure functions (launch variables + CLI JSON → band, nudge,
  command text), tested with vitest and a fake `$` that records `process.run` calls and captures
  `ui.status` and band trees, covering every failure reason.
- **CLI:** `list --json`; the launch variables in `--dry-run`; `mod install|uninstall` against a
  temporary home and a fake `claude`; doctor's `mod` check.
- **Opt-in e2e (`ZZP_E2E=1`):** `claude plugin validate` on the built mod; `mod install` with the
  real `claude`, then uninstall.
- **Interactive smoke (herdr pane):** `zzpersona claude` in a seeded project shows the band;
  `/persona list`; `/persona switch <other>`, `/exit`, `zzpersona claude -- --continue` keeps the
  conversation and runs the new persona; plain `claude` in the project shows the nudge. Recorded
  in `spikes/mod-smoke/FINDINGS.md`, with manual checks A and B run in the same session for
  spec 10.

## Non-goals (this spec)

Live in-session switching (spec 10); instruction injection; the daemon; in-session UX for other
harnesses; Windows.

## Open questions

1. **`--continue`.** Keep recommending it only if the smoke test shows the conversation survives
   a relaunch with a different persona.
2. **Mod and CLI versions.** `doctor` warns on a mismatch; an automatic reinstall on CLI upgrade
   may be better once the CLI is published.
3. **`process.run` blocked by policy.** The band still shows the launched persona from the
   environment; `/persona` can only explain why it is unavailable. A daemon (Phase 2) could serve
   the mod over a socket instead.

## Amendment: open question 3 answered (2026-10-21)

Spec 15 answers open question 3: the mod reaches the daemon over its socket with `$.http.fetch`.
`/persona` works when `process.run` is refused, as long as the daemon runs.

## Amendments from implementation and the smoke run (2026-10-21)

Made while building this spec (`docs/plans/2026-10-21-mod-claude-code.md`); see
`spikes/mod-smoke/FINDINGS.md`. Each overrides the section it names.

- **§3 after a switch** the text recommends `zzpersona claude`, and says
  `zzpersona claude -- --continue` keeps the conversation but not the new persona's instructions:
  a resumed session keeps the system prompt it began with. Open question 1 is answered.
- **§3 `/persona list`** prints layers in inheritance order (org, area, team, project, user).
- **§1 doctor's `mod` check** compares the installed mod with the mod this CLI ships, not with the
  CLI's own version (the packages version separately).
- **§1 failure reasons:** a refused `process.run` reads `blocked: <the refusal's message>`.
- **§1 hooks** are top-level functions over module state, as `claude plugin validate` requires.
- **Spec 10 inputs:** manual checks A (a child of a `--plugin-dir` folder of plugins swaps
  mid-session, silently) and B (`prompt.submit` context survives later turns) both passed.

