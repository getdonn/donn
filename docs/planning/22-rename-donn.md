# 22 — Rename to donn

> Status: design, 2026-10-23. The product is named **donn** (`00-handoff.md` → "Naming"). This
> spec renames the code from the placeholder `zzpersona` (and the docs from `hatrack`), adds
> `donn migrate` for existing installs, and ships the result as 0.13.0. The private control-plane
> repo is renamed separately. Built as a `gh stack`: layer 0 is this spec and its plan, written
> before the rename and therefore still using the old names.
> *Amended 2026-10-24:* personal and private control-plane details removed before the repository went public (spec 27).
> *Amended 2026-10-24:* the deferred minors are fixed: `doctor` finds the old home the way `migrate` does and warns about projects not migrated yet (keeping their switches under `--fix`), an empty target is no longer called "made by running donn", a target holding only what `donn init` and `donn login` wrote is named with advice, a relative-symlink old home moves as an absolute link, `migrate` exits 1 while a step is pending, and an unexpanded `ZZPERSONA_HOME=~/.zzpersona` counts as the default home.

## Intent

After this spec, neither repo says `zzpersona`, `zzp` or `hatrack` outside dated history, and a
machine that ran `zzpersona` keeps its personas, secrets, background service and Claude Code mod
by running `donn migrate` once. Nobody outside uses the product yet, so this is a clean break: no
old name is read after the rename.

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| A clean break plus a one-time `donn migrate` | Manual steps; a one-release compatibility window reading both names | No outside users; compatibility code would be removed a release later; one command moves the only real install safely |
| One scripted rename layer per repo, the script deleted in the same PR | Renaming by hand, package by package; package aliases | ~3,500 occurrences: a script applies the approved mapping exactly and is reviewable; aliases contradict the clean break |
| Both repos move into the `getdonn` GitHub org now (private); published artifacts use the new org | Renaming in place and moving later; renaming only the code | One move instead of two; packages are owner-scoped |
| Local folders keep their names | Renaming them | Tooling state keyed on those paths survives; only remotes change |

## 1. The mapping

| Today | Becomes |
|---|---|
| `@zzpersona/*`, `zzpersona` (command), `zzpersonad` | `@getdonn/*` (the CLI package is `@getdonn/cli`), `donn`, `donnd` |
| `~/.zzpersona/`, `.zzpersona/` (project), `apiVersion: zzpersona/v0` | `~/.donn/`, `.donn/`, `apiVersion: donn/v0` |
| `ZZPERSONA_*` (`HOME`, `PERSONA`, `PROJECT`, `SESSION`, `SOURCE`, `SERVICE`, `SERVICE_LABEL`, `NO_DAEMON`, `REGISTRY_TOKEN`) | `DONN_*`, same suffixes |
| `ZZP_E2E*`, `ZZP_SECRET_*`, `ZZP_MANAGED_ROOT` | `DONN_E2E*`, `DONN_SECRET_*`, `DONN_MANAGED_ROOT` |
| plugin names `zzp-<persona>`, marketplace `zzpersona`, daemon folders `zzpd-…` | `donn-<persona>`, `donn`, `donnd-…` |
| service labels `zzpersona.daemon` (launchd), `zzpersona-daemon.service` (systemd) | `dev.getdonn.daemon`, `donn-daemon.service` |
| keychain service `zzpersona-registry` | `donn-registry` |
| tokens `zzp_…`, cookie `__Host-zzp_login` | `donn_…`, `__Host-donn_login` |
| bundle digest header `zzpersona-bundle/1` | `donn-bundle/1` (every layer digest changes) |
| `managed-settings.d/50-zzpersona.json`, policy folder `zzpersona/`, manifest field `zzpersona` | `50-donn.json`, `donn/`, `donn` |
| headers `X-Zzpersona-*` | `X-Donn-*` |
| profile identifier `com.zzpersona.managed.<layer>` | `dev.getdonn.managed.<layer>` |
| download names `zzpersona-<layer>-<v>-<os>.*` | `donn-<layer>-<v>-<os>.*` |
| install-script internals `zzp_*`, `ZZP_*` | `donn_*`, `DONN_*` |
| `AGENTS.md` markers `<!-- zzpersona:begin … -->`, `<!-- zzpersona:end -->` | `<!-- donn:begin … -->`, `<!-- donn:end -->` |
| "hatrack", "Hatrack", "hatrackd" in docs | "donn", "Donn", "donnd" |
| `jbjsoftware/persona-ai` (repo URL), `persona-ai` (repo name in docs) | `getdonn/donn`, `donn` — the URLs resolve once the repo moves (§4), right after the release |

Registry tokens issued before the rename keep the `zzp_` text and stop being recognised.

## 2. The rename script

`scripts/rename-donn.mjs`, committed in the rename layer and removed in the same PR. It acts on
`git ls-files` only (never `vendor/`, `node_modules/` or ignored files) and has `--check`, which
only reports leftovers and exits non-zero when any exist.

1. **Paths.** Each tracked path containing `zzpersona` or `zzp` is renamed with `git mv` using
   the text rules below (e.g. `test/golden/service/zzpersona-daemon.service` →
   `donn-daemon.service`, `zzp-<persona>/` golden folders → `donn-<persona>/`).
2. **Text,** in this order so a longer form is never half-replaced:
   1. `@zzpersona/` → `@getdonn/`
   2. `com.zzpersona.` → `dev.getdonn.`; `zzpersona.daemon` → `dev.getdonn.daemon`
   3. `zzpersona-daemon` → `donn-daemon`; `zzpersonad` → `donnd`
   4. `zzpersona/v0` → `donn/v0`; `zzpersona-bundle/` → `donn-bundle/`; `zzpersona-registry` → `donn-registry`
   5. `X-Zzpersona-` → `X-Donn-`; `Zzpersona` → `Donn`
   6. `ZZPERSONA_` → `DONN_`; `ZZP_` → `DONN_`
   7. `__Host-zzp_` → `__Host-donn_`; `zzp_` → `donn_`; `zzpd-` → `donnd-`; `zzp-` → `donn-`
   8. `zzpersona` → `donn`
   9. docs only: `hatrackd` → `donnd`, `Hatrack` → `Donn`, `hatrack` → `donn`
3. **Length-sensitive lines.** `zzp_` (4) becomes `donn_` (5): the script prints every changed
   line that is a regular expression or a length check (token formats such as `/^zzp_[0-9a-f]{48}$/`,
   minimum lengths), and each gets a hand review in the PR.
4. **Untouched:** `CHANGELOG.md` files; every dated amendment or history block in `docs/planning/`;
   `00-handoff.md`'s naming history; this spec (it needs both names); `docs/plans/`
   (implementation plans are records of what was done); `spikes/` (throwaway findings); git history.
   Each other planning doc gains one dated note: `2026-10-23: renamed zzpersona/hatrack → donn`.
5. **Verification:** `--check` reports zero leftovers outside the untouched set; golden and
   corpus files are regenerated with each package's update command and spot-checked; the full
   pipeline passes; the opt-in end-to-end tests run once (real Claude Code; managed settings in
   Docker; the background service only after asking, since it installs a real login item).

## 3. `donn migrate`

Supports `--json`; prints its plan and asks unless `--yes`; every step is idempotent, so a re-run
or a run after an interruption completes without redoing or failing on finished steps; ends with
`donn doctor`.

**`donn migrate`** (user level):

1. Stop and remove the old background service (`zzpersona.daemon` / `zzpersona-daemon.service`),
   as `daemon uninstall` does for the old label.
2. Move `~/.zzpersona` to `~/.donn` (or `DONN_HOME`); refuse if the target exists and is not empty.
3. Drop regenerable state: `build/`, `sessions/` and daemon sockets. Keep personas,
   `config.yaml`, `overrides.yaml`, `state.json` and the registry cache.
4. Rewrite `apiVersion: zzpersona/v0` → `donn/v0` in every persona file under the home and under
   the personas folder `config.yaml` names, changing only that line; update `config.yaml` paths
   that pointed into `~/.zzpersona`.
5. Move each keychain item under `zzpersona-registry` to `donn-registry` (copy, then delete the
   old one). User-chosen keychain services behind `secret://keychain/…` are not touched.
6. Remove the old Claude Code mod (the `zzpersona` marketplace and plugin, through `claude plugin`
   as `mod uninstall` does) and install the `donn` one.
7. Install and start the new background service if the old one was installed.

**`donn migrate --project [dir]`** (default: the current project): `.zzpersona/` → `.donn/` (with
`git mv` when tracked), the project persona's `apiVersion`, and the `AGENTS.md` markers. Never
commits; prints what changed.

**Reported, not changed:** set `ZZPERSONA_*` / `ZZP_*` environment variables (named, for the user's
shell profile); an installed managed policy under the system folder's `zzpersona/` — the output
gives the steps: `sudo donn migrate --managed` removes exactly the files the old
`zzpersona/manifest.json` lists (and `managed-settings.d/50-zzpersona.json` if listed), with
`managed uninstall`'s safety rules, then `donn managed build` and `sudo donn managed install`.

**Tests:** temp homes with fakes for the keychain, `launchctl`, `systemctl` and `claude`; a full
migration; re-runs and recovery after an interruption at each step; an existing target; project
migration with markers and `git mv`; the managed notice and `--managed` against a temp root. No
test touches the real home, keychain, LaunchAgents or system folders.

*Amended 2026-10-23 (implementation review):* step 6 is split in two. The old mod's removal
(`mod-remove`) runs right after step 1 and before the home moves, because Claude Code reads the
old plugin from `~/.zzpersona/mod` and its marketplace points there: unregistering it once that
folder is gone relies on Claude tolerating a missing folder. It counts as done only when
`claude plugin list --json` and `claude plugin marketplace list --json` no longer show the old
names, so a failure stays pending with Claude's message. Installing the donn mod (`mod-install`)
stays at step 6. The order is now: stop the old service, remove the old mod, move the home, drop
regenerable state, rewrite `apiVersion`, move the keychain token, install the new mod, install the
new service. Every step is also checked again just before it runs, so the printed plan is an
estimate. Before anything changes, `donn migrate` refuses when `ZZPERSONA_HOME` names another home
(in the environment or the old service file), when the mod is not built, when `claude` is not on
PATH while the old mod is installed (naming the shell's alias and the `export PATH=…` fix, as
`donn claude` does), when `claude plugin list --json` does not have the expected shape, or when
`donn` is not on PATH for the new service. claude is asked only when an old mod folder (or a
mod swap in progress) exists.

*Amended 2026-10-23 (final review):* a `state` step after the `apiVersion` rewrite points
`state.json` switches keyed by a project's old folder at `<project>/.donn` (a switch already there
for the same project wins); `--project` leaves `state.json` alone, since either order ends with a
matching key. The output lists projects with a switch whose old folder is still there (with their
`donn migrate --project` command) and values in the home's YAML files and the personas folder that
still name the old home (file and field; not changed). When the target holds only what donn makes
itself (the daemon's folder, `sessions/`, `build/`, an empty `personas/`, a `mod/` whose
marketplace is `donn`, a `state.json` with no default or switch, an empty `config.yaml`,
`state.lock`, `.DS_Store`), the refusal names donn running before the migration as the cause and
what to remove, without the `DONN_HOME` hint; it never removes it. `donn doctor` reports an old home
first, as an error, when the new one is missing or donn-made. `mod-remove` with no claude to ask is
pending, and its run fails (`mod-uninstall`) rather than counting as done; `service-start` is done
only when the new service is loaded, not just written.

## 4. GitHub and release

- Release **0.13.0** from `develop` (all packages minor under their new names; still
  `"private": true`; no npm publish).
- Then, after asking, transfer `jbjsoftware/persona-ai` to the `getdonn` org as `donn` (private);
  settings, protection, tags, issues and PRs carry over and old URLs redirect. Point the local
  clone's `origin` at the new URL.

## 5. Stack and testing

| Layer | Contents |
|---|---|
| 0 `spec` | this spec and its plan (old names) |
| 1 `rename` | the script, its run and removal; regenerated goldens and corpora; `--check` clean |
| 2 `migrate` | `donn migrate`, `--project`, `--managed`; tests |
| 3 `docs` | README, CLAUDE.md, `00-handoff.md` "rename landed" note, dated notes, changesets |

Smoke before the final review: `donn claude` in a herdr pane with a temp home and the dev mod
(`--plugin-dir`): the band, `/persona`, and the mod reaching the renamed daemon. The real
`donn migrate` on the developer's Mac runs after both releases, watched, with permission.

## Non-goals

Publishing to npm; making the repos public; deleting the `jbjsoftware` GHCR packages; a trademark
search; the open-source follow-ups from the control plane's managed bundles (`managed-unrepresentable` in
`PROBLEM_CODES`, the manifest's "delivered by another channel" field) — a later small spec.

## Open questions

None.
