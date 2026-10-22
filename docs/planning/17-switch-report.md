# 17 — `switch` reports per harness

> Status: design, 2026-10-22. Phase 2's last roadmap item ("`switch --harness all` with
> per-harness results", `04`). Answers `03` open question 2. Builds on `07-cli-daily-use.md` (the
> switch), `11-agents-md.md`, `12-codex.md`, `13-capability-matrix.md` and `14-daemon.md`. Built as
> a `gh stack`: layer 0 is this spec and its plan.

## Intent

A switch already applies to every harness: `state.json` holds one choice, and `zzpersona claude`,
`zzpersona codex` and the daemon read it. What is missing is seeing what the choice means in each
one. After saving a choice, `switch` compiles it for each installed harness and says, per harness,
what it keeps and drops, which running sessions still run another persona, and what the committed
`AGENTS.md` carries.

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| One choice for every harness; the report is per harness | A choice per harness in `state.json` | The gap is visibility, not flexibility; a per-harness choice adds a layer to selection, the mod's band and the nudge |
| The report on every `switch <persona>` and `switch --clear` | Only with `--harness all` | Most users would never see what each harness drops |
| Compiled in-process, the daemon asked only for sessions | A daemon endpoint with a CLI fallback | One code path; works the same with or without the daemon |
| A harness that fails is reported, the choice stays saved, exit 0 | All-or-nothing; exit 1 on any harness error | The choice is valid (it is resolved before saving); the report is about future launches (`03` open question 2, lean "per-harness; report") |

## 1. Behaviour

- **Order:** the choice is resolved and saved as today, then the report runs. Nothing in the
  report undoes or blocks the switch.
- **Which harnesses:** `claude-code` and `codex` when detection finds them installed; third-party
  adapters from `config.yaml` when installed; `agents-md` only in a project whose `AGENTS.md` has a
  zzpersona block. `--harness <id>` limits the report to that harness; an id no adapter has is
  `unknown-harness`, as for `compile`.
- **`switch --clear`** reports for the persona that applies after clearing. **`switch`** with no
  argument (show) is unchanged and reports nothing.
- **Per harness, one line:**
  - `ok`, or `drops <summary>`: the compile report's dropped and degraded entries grouped by field
    (`hooks (2)`, `knowledge as text`), or `error <message>` when compiling fails;
  - when the daemon runs: the harness's sessions in this project whose persona (the swapped-in
    one, else the launched one) is not the new choice, and the fix: `/persona use <p>` for
    `claude-code`, relaunch for `codex`;
  - **`agents-md`:** the block is rendered from the shared `project/persona`, not from the choice.
    When the choice is not `project/persona`: `AGENTS.md carries project/persona (shared); <p>
    applies to zzpersona launches only`. When the block is out of date with `project/persona`,
    `— zzpersona write`.
- **Exit code:** 0 once the choice is saved, whatever the report says.
- **`--json`:** the existing object gains `harnesses: [{ id, status, dropped, sessions?, message?,
  fix? }]`, `status` one of `ok`, `drops`, `error`, `shared`; `sessions` is `{ count, fix }`.

Example:

```
this project uses team/web
claude-code  ok · 1 session here still runs project/persona: /persona use team/web
codex        drops hooks (2), knowledge as text
agents-md    AGENTS.md carries project/persona (shared); team/web applies to zzpersona launches only
```

## 2. Code

- **`switch-report.ts`:** `harnessReport(io, ctx, selection, only?: string): Promise<HarnessResult[]>`.
  Per harness: detect, skip one not installed, `prepareBuild` with a new `quiet` option (resolve
  warnings print once, from the switch, not per harness); nothing is written.
- **agents-md:** the check `zzpersona write --check` runs (`applyOverlay` in check mode, the build
  of `project/persona`).
- **Sessions:** `connectDaemon` (never starts one) and its status's `sessions`, filtered by harness
  and project; no daemon, no `sessions` field.
- **Third-party adapters** through `findAdapter`, as `compile`.
- **Inside the daemon:** a `switch` run through `POST /run` asks the daemon for its sessions over its
  own socket; the server answers requests concurrently, and a test pins that it does.

## 3. Stack and testing

| Layer | Contents |
|---|---|
| 0 `spec` | this spec and its plan |
| 1 `report` | `switch-report.ts`; `prepareBuild`'s `quiet`; `switch`'s lines, `--json` `harnesses`, `--harness`, `unknown-harness` |
| 2 `docs` | README; CLAUDE.md; `03` open question 2 answered (dated); the `04` item marked built; changeset (minor `@zzpersona/cli`) |

- `ok` and `drops` lines with grouped fields; a harness not installed skipped; a third-party adapter
  that throws is `error`, the choice saved, exit 0.
- `--harness codex` reports Codex only; `--harness nope` is `unknown-harness`.
- `agents-md` only with a block; the `shared` line when the choice is not `project/persona`; the
  `zzpersona write` hint when the block is out of date.
- An in-process daemon with a `claude-code` and a `codex` session in this project on the old
  persona: counts and fixes; no daemon, no `sessions`.
- Resolve warnings printed once; `--clear` reports for the persona that now applies; the `--json`
  shape; `switch X --json` through `/run` answers.
- **Check, before the final review:** the built CLI in `examples/demo-app` against the real
  `claude`, `codex` (when installed) and the user's daemon with the demo-app session open.

## Non-goals

A choice per harness; showing the report in `/persona switch`; writing `AGENTS.md` automatically.

## Open questions

None.

## Amendments from implementation (2026-10-22)

- **`sessions`** in `--json` is `{ count, persona, fix }`: `persona` names what the sessions still
  run (the first, then "and others"), which the line shows too.
- **`prepareBuild`** takes the caller's `detection` as well as `quiet`, so the report detects each
  harness once.
- **`switch --clear` with nothing to clear** prints "nothing to clear" and no report.
- **Wording (final review):** a line says `drops <fields>` only for dropped entries and adds
  `· approximates <fields>` for approximated and advisory ones (`ok · approximates knowledge (1)`);
  `--json` has `dropped` and `approximated` lists. The earlier `drops knowledge (1 approximated)`
  reported a loss that did not happen.
- **Before saving:** an unknown `--harness` id is refused and nothing is saved.
- **A config adapter that cannot load** is one `plugins  error …` line; the built-ins still report
  and the exit code stays 0.
- **`switch X --default` inside a project** shows no `agents-md` line and counts no sessions: X does
  not apply there. **`agents-md` is listed last.**
- **Check run** (the user's Mac, `examples/demo-app`, real `claude` 2.1.308 and `codex`, the
  service daemon with the demo-app session open): `switch team/web` printed (in the wording before
  the final review) one line each for `claude-code`, with `1 session here still runs
  project/persona: /persona use team/web`, and `codex`; `switch --clear` reported both again for `project/persona`, with no session line.
  The demo app has no `AGENTS.md` block, so no `agents-md` line.

## Hardening (0.8.1) (2026-10-22)

- **Sessions match by real path.** A session counts when its project and the repo resolve to the
  same real path (`realpath`, the raw path if that fails), so a symlinked checkout or `/tmp` vs
  `/private/tmp` no longer hides it.
- **A harness has 5 s.** Each harness's detect and build is limited to 5 s; one that never settles
  is `error timed out after 5s` and the others still report. The limit is `limits.harnessMs` in
  `switch-report.ts`, so a test can shorten it.
- **Less repeated work.** Sessions come from the status `connectDaemon` already probed, not a second
  request; harnesses are detected and built in parallel (the report order, `agents-md` last, is
  unchanged); `switch --clear` reuses its context with the new state, so a stray-layer warning
  prints once.
- **`agents-md` wording.** The line reads `carries project/persona`, not `ok`, because `ok` read
  like "keeps everything". The JSON `status` stays `ok`. When `project/persona` extends a user
  layer, `zzpersona write` refuses it (`user-layer-in-shared-file`), so the line no longer suggests
  `— zzpersona write`.
