# 07 — CLI daily use: switch, init, doctor, and hardening

> Status: design, 2026-10-21. Phase 1, third spec. Agreed in conversation section by section.
> Amended 2026-10-21: spec 08 replaced the 1Password provider with a built-in OS keychain
> provider and pluggable provider packages.
> Builds on `06-cli-core-loop.md`. Spec 08 covers the "reach" half (1Password provider,
> third-party adapter loading, `diff`, and the SDK-side deferred minors); the Claude Code mod
> (status line, nudge, in-session switch) gets its own spec after the spike's manual checks.
> Built as a `gh stack`: layer 0 is this spec and its plan.

## Intent

The Phase 1 exit question (`04`): *do I switch personas more than once a day without thinking
about it?* Spec 06 made `zzpersona claude` work; this spec makes it pleasant to live with:
choose a different persona for a repo or by default (`switch`), get set up in one command
(`init`), find out what is wrong (`doctor`), and stop tripping over the rough edges the last
two reviews found.

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| Split the remaining CLI into daily use (07) and reach (08) | One spec | Independent pieces; daily use answers the exit question, reach matters once others are involved |
| `switch` remembers a choice per project plus a default for everywhere else | One global current persona; no `switch` (files only) | A global switch fights project personas; files-only gives no quick way to try another persona without touching a committed file |
| Switch state lives in `~/.zzpersona/state.json`, keyed by project | A git-ignored `.zzpersona/local.yaml` per project; an environment variable | Nothing written into repos or committed by accident; one file the mod and `doctor` can read; per user and per machine, which is what a switch is |
| `init` is flags only | Interactive prompts; no `init` | Predictable, scriptable, works with `--json` and agents; a missing flag is reported with the exact fix |

## 1. `switch`, `state.json`, and persona selection

`~/.zzpersona/state.json`, written atomically (temporary file, then rename):

```json
{
  "version": 1,
  "default": "team/payments",
  "projects": { "/Users/you/repo/.zzpersona": "team/platform" }
}
```

A **project** is a directory with `.zzpersona/persona.yaml`, found by walking up (`findProject`,
spec 06). Entries are keyed by the **real path** of that `.zzpersona` directory, so a symlinked
checkout matches.

| Command | Does |
|---|---|
| `zzpersona switch <persona>` | In a project: this project uses `<persona>`. Outside: sets the default. `--default` sets the default from inside a project. The persona is resolved before saving |
| `zzpersona switch --clear [--default]` | Removes this project's switch, or the default |
| `zzpersona switch` | Shows the persona `zzpersona claude` would use here, and why |

`--json`: `{ "scope": "project" \| "default", "persona", "project"? }` when setting or clearing;
`{ "persona", "source", "project"? }` when showing.

**Selection** (every persona-taking command), first match wins:

1. a persona named on the command line → source `argument`
2. this project's switch → `switch`
3. this project's persona, `project/persona` → `project`
4. the default → `default`
5. otherwise error `no-persona`, listing available personas and suggesting `zzpersona switch`

`selectPersona` returns `{ ref, source, project? }`. A persona that came from `state.json` and
fails to resolve with `missing-ref` gets the hint "set by `zzpersona switch`; run
`zzpersona switch --clear` to remove it". An unparseable `state.json` is an error naming the
file. Concurrent `switch` commands: last write wins.

## 2. `init` (flags only)

Two forms, combinable in one command:

- **`zzpersona init --personas <dir>`** writes `~/.zzpersona/config.yaml` with
  `personas: <dir>`. If the config already names a different folder it refuses, naming the
  current value; `--force` replaces it. Creates `<dir>` if needed. If `<dir>` has no persona
  under `org/`, `area/` or `team/`, writes a starter `org/base.yaml` (one inline instruction, a
  `Bash(rm -rf:*)` deny rule, comments pointing to `02-persona-spec.md`). Never overwrites
  existing files. Prints a `git init` hint; does not run git.
- **`zzpersona init --extends <persona>`** writes `.zzpersona/persona.yaml` in the **current
  directory**: `metadata.name` = the directory's basename, `extends: [<full ref>]` (a bare name
  is stored as its full ref). The persona must resolve first. Refuses an existing
  `persona.yaml` unless `--force`.
- No flags: prints both forms with an example and exits 1 (`init-needs-flags` under `--json`).
- Output lists what was created or updated; `--json` is `{ "created": [paths], "updated": [paths] }`.
  Files are written atomically.

## 3. `zzpersona doctor [persona] [--fix]`

Runs the checks below in order, one line each: `ok`, `warn`, `error` or `skipped` (when a check
it depends on failed), a message, and a fix when something is wrong. Exit 1 if any check is an
`error`. `--json`: `{ "checks": [{ "id", "status", "message", "fix"? }] }`.

| id | `warn` / `error` when |
|---|---|
| `home` | home not writable (error); `ZZPERSONA_HOME` set but empty (warn) |
| `config` | `config.yaml` doesn't parse (error); no `personas:` set (warn) |
| `personas` | folder missing (error); not a git repository (warn); stray `project/`/`user/` folders (warn) |
| `state` | `state.json` doesn't parse (error); switch entries for projects that no longer exist (warn, fixable) |
| `persona` | info: the persona that would be used here and its source |
| `resolve` | it fails to resolve (error); resolver warning count shown |
| `claude` | not installed (error); older than 2.1.306, the version verified in `spikes/claude-code` (warn); managed settings force a degraded mode (warn, naming it) |
| `secrets` | any secret the persona's build needs can't be resolved; each ref with its reason, never a value (error) |
| `build` | `<home>/build` not writable (error); stale locks or orphaned version directories (warn, fixable) |

`--fix` applies only safe fixes: removes switch entries for missing projects, build locks whose
owner process is gone, and version directories no build symlink points to. Builds for deleted
projects can't be traced (the directory name is a hash); `doctor` notes that deleting
`<home>/build` is always safe, since builds are recreated on launch.

> Amended 2026-10-21 (final review): a running build writes its version directory and link,
> and creates its lock before writing the pid, so version directories, temporary links and
> locks without a pid count as leftovers only once they are ten minutes old. A lock whose pid
> names a dead process is stale at once. And `list()` keeps a `.yaml` that doesn't parse, so
> selecting it reports the parse error rather than "no persona named …".

Plain output, e.g.:

```
ok     config    /Users/you/.zzpersona/config.yaml
warn   personas  /Users/you/personas is not a git repository; run `git init` there to track changes
ok     persona   team/platform (switch for /Users/you/repo)
error  secrets   secret://vault/payments/token: provider type "hashicorp-vault" is not supported yet
```

## 4. Hardening (CLI-side deferred minors)

| Minor (from the reviews of 05/06) | Fix |
|---|---|
| Signal-killed `claude` exits 1 and shows the managed-settings hint | `runPlan` returns `128 + signal number`; `claude` shows no hint for a signal exit (code > 128) |
| Commander parse errors ignore `--json` | With `--json` anywhere in the arguments, commander errors print `{ "error": { "code": "usage", "message" } }` on stdout |
| `--` passthrough silently ignored by `resolve`/`compile` | Every command except `claude` rejects passthrough: `unexpected-passthrough` |
| Symlinked persona files invisible to `list()` | `list()` follows symlinks (as `load()` does) |
| Every `.yaml` under `org/area/team` listed as a persona | `list()` includes only files whose parsed `kind` is `Persona` |
| Empty `ZZPERSONA_HOME` treated as set | An empty value means unset (and `doctor` warns) |
| `readText` has no symlink containment | `readText` applies `copyFrom`'s real-path containment against the mount root; an escaping instruction file is refused |
| File-path-like persona arguments | A trailing `.yaml` is stripped; an unknown persona gets `did you mean <ref>?` from a case-insensitive match |
| Build directories accumulate | `doctor --fix` (section 3) |

Not fixed here: the `writeBuild` check-then-copy gap (needs a local attacker with write access
to the mount; closing it changes symlink handling inside skills), Windows, and the SDK-side
minors (spec 08).

## Testing

- `switch`: set/clear/show in and out of a project; precedence across all five sources; a
  symlinked checkout matches its entry; a stale switched persona gets the hint; atomic writes;
  corrupt `state.json`.
- `init`: both forms and combined; refusals without `--force`; starter file only into an empty
  personas folder; persona validated before writing; no-flags error.
- `doctor`: each check's `ok`/`warn`/`error` against seeded homes and fake probes; `skipped`
  propagation; `--fix` removes exactly the fixable items; `--json` shape; exit code.
- Hardening: one failing-first test per fixed minor.
- The CLI e2e (`ZZP_E2E=1`) gains: `init --personas`, `init --extends`, `switch`, then
  `doctor` exits 0, then `zzpersona claude --dry-run` uses the switched persona.

## Non-goals (this spec)

1Password, third-party adapters, `diff`, SDK-side minors (all spec 08); the mod; Windows;
colors; interactive prompts.
