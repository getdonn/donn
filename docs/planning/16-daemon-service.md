# 16 — Daemon service: install as a login service, auto-start, one daemon per home

> Status: design, 2026-10-22. Phase 2, the daemon's third slice (spec 14 named it). Builds on
> `14-daemon.md` and `15-mod-transport.md`; answers `03`'s "installed as a user service …; the CLI
> auto-starts it on first use (configurable)". Built as a `gh stack`: layer 0 is this spec and its
> plan.

## Intent

The daemon runs whenever it is useful without the user starting it: a login service keeps it up
(and brings it back after a crash), and `zzpersona claude` / `codex` start it when it is not
running. With three ways to start a daemon at once, the lock that keeps one daemon per home must
hold under a race.

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| A login service **and** CLI auto-start, auto-start on by default | Service only; auto-start only; auto-start off by default | `03`'s lifecycle; without auto-start most users never get live refresh, without the service nothing restarts a crashed daemon |
| The service runs the absolute path of the `zzpersona` PATH finds | The running `node` and `dist/bin.js` | The `zzpersona` launcher picks its own Node: a Node upgrade or a CLI update does not break the service; pinning a Node binary and a checkout would |
| Auto-start only in `zzpersona claude` and `codex` | Every command | Those are the commands whose sessions the daemon watches; `switch`, `list`, `doctor` must stay side-effect free |
| A guarded takeover of a stale lock | Write then verify; `flock` | Plain files, no timing assumption; Node has no `flock` without a native dependency |
| Never restart a daemon of another version automatically | Auto-restart on mismatch | Two installed CLIs of different versions would keep restarting each other's daemon |

## 1. Commands and service files

All take `--json`.

- **`zzpersona daemon install`**: finds `zzpersona` on PATH (absolute), else refuses
  (`cli-not-on-path`, with the README's install hint); stops a daemon running outside the service;
  writes the service file; loads it; waits until the socket answers. Run again, it rewrites the file
  and restarts the daemon: the fix after a CLI update or a PATH change.
- **`zzpersona daemon uninstall`**: unloads the service and removes its file; the daemon is left
  stopped. Not installed: "not installed" (exit 0).
- **`daemon start`** with the service installed starts it through the service manager; otherwise
  the detached spawn of spec 14.
- **`daemon stop`** unchanged: `POST /shutdown`, a clean exit (code 0). Both service files restart
  only after a failure, so a stop holds until the next start, login or launch.
- **`daemon status`** adds `service: installed (<file>)` or `not installed`, and whether the
  running daemon is the service's.
- **Windows:** `install` and `uninstall` fail with `service-unsupported` ("not supported on Windows
  yet").

**macOS**: `~/Library/LaunchAgents/zzpersona.daemon.plist`: `Label` `zzpersona.daemon`;
`ProgramArguments` `[<abs zzpersona>, daemon, run]`; `RunAtLoad`; `KeepAlive` `{ SuccessfulExit:
false }`; `ProcessType` `Background`; stdout and stderr appended to `daemon.log`. Loaded with
`launchctl bootout gui/<uid>/zzpersona.daemon` (when loaded) then `launchctl bootstrap gui/<uid>
<plist>`; started with `launchctl kickstart gui/<uid>/zzpersona.daemon`; unloaded with `bootout`.

**Linux**: `~/.config/systemd/user/zzpersona-daemon.service` (`$XDG_CONFIG_HOME` when set):
`ExecStart=<abs zzpersona> daemon run`; `Restart=on-failure`; `WantedBy=default.target`. Loaded
with `systemctl --user daemon-reload` then `enable --now`; started with `start`; unloaded with
`disable --now`. It runs while the user is logged in; lingering is not enabled.

**Environment in the file:** `PATH` as at install (launchd's default PATH is
`/usr/bin:/bin:/usr/sbin:/sbin`, and the daemon's refreshes detect `claude` and `codex`);
`ZZPERSONA_HOME` only when set; `ZZPERSONA_SERVICE=1`, which marks the daemon as the service's.
Nothing else: no tokens, no secrets.

**Under the service, "already running" is success:** a `daemon run` with `ZZPERSONA_SERVICE=1`
that finds another live daemon exits 0, so the service manager does not restart it in a loop.

**Doctor**: the `daemon` check adds: the service file's `zzpersona` no longer exists (fix
`zzpersona daemon install`); installed but not loaded (fix `zzpersona daemon install`); a version
mismatch's fix is `zzpersona daemon install` when the service is installed, else
`zzpersona daemon stop && zzpersona daemon start`.

The names `zzpersona.daemon` / `zzpersona-daemon` change with the product name.

## 2. Auto-start

- **Where:** `zzpersona claude` and `codex`, after the build is written and before the harness
  launches. Skipped for `--dry-run` and `--json`, when `config.yaml` has `daemon: { autoStart:
  false }`, and when `ZZPERSONA_NO_DAEMON=1`.
- **How:** `GET /status`; a daemon that answers is used as it is. Otherwise it starts as
  `daemon start` would (the service manager when installed, else detached) and waits up to 1 s for
  the socket; the launch goes ahead either way. A daemon up later finds the session from its
  registry: `launched.json` is already written.
- **Failure** is one line on stderr, `zzpersona: daemon not started (<reason>); live refresh is off
  for this session`; exit codes and `--json` output are unchanged.
- **Config:** an optional `daemon: { autoStart: boolean }` in `config.yaml`, default true,
  validated by the config schema.
- **Versions:** a running daemon of another version is used with spec 14's warning, never
  restarted.

## 3. One daemon per home: the lock

Today a stale lock can be taken twice: starters A and B both read a dead owner; A removes the lock
and creates its own; B, acting on what it read, removes A's lock and creates its own. Two daemons
then fight over `sock` and `token`.

- **Guarded takeover:** replacing a stale `daemon.lock` needs `daemon.lock.takeover`, created
  exclusively (`wx`). Its holder reads `daemon.lock` again and replaces it only if it still names
  the same dead pid; then it removes the takeover file. A starter that cannot take it, or finds a
  live owner, fails with `daemon-running` ("already running").
- **A crashed takeover:** a takeover file older than 10 s is removed.
- **The socket:** after taking the lock, the daemon binds the socket; when the bind fails with
  `EADDRINUSE` and the socket answers `GET /status`, it exits as "already running" instead of
  removing a live daemon's socket.

## 4. Stack and testing

`daemon/service.ts` holds a `ServiceManager` (`path`, `render(command, env)` as pure text,
`install`, `uninstall`, `start`, `loaded`) with `launchd` and `systemd` implementations that run
`launchctl` / `systemctl` through the injected probe.

| Layer | Contents |
|---|---|
| 0 `spec` | this spec and its plan |
| 1 `lock` | the guarded takeover, the socket bind check, race tests |
| 2 `service` | `service.ts`; `daemon install`/`uninstall`; `start` through the manager; `status`; doctor; "already running" exits 0 under the service |
| 3 `autostart` | `daemon.autoStart` in the config; `ZZPERSONA_NO_DAEMON`; the hook in `claude` and `codex` |
| 4 `e2e-docs` | opt-in e2e; the smoke run; README; CLAUDE.md; dated notes in `03` and `14`; changeset |

- **Lock:** twenty starters at once on a stale lock, exactly one wins; a stale takeover file; a
  live socket whose lock was removed by hand is left alone.
- **Service:** the plist and the unit file against golden files in `test/golden/`; the command
  sequence for install, reinstall, uninstall and start on each platform (a fake runner); refusing
  without `zzpersona` on PATH; Windows refused; status and doctor findings.
- **Auto-start:** skipped for `--dry-run`, `--json`, the config switch and the variable; a running
  daemon left alone; a failed start still launches; the service manager used when installed.
- **E2e (`ZZP_E2E_SERVICE=1`, macOS, separate from `ZZP_E2E`: it touches the user's launchd):** a
  scratch home, a scratch label (`zzpersona.daemon.e2e-<random>`, a test-only override) and a plist
  in a temp folder; install → the socket answers; `kill -9` → launchd brings it back; `daemon stop`
  → it stays stopped; uninstall; cleanup always `bootout`s. Linux: unit tests only.
- **Smoke (herdr, before the final review, with the user's OK):** install the real service;
  `daemon status` shows it; `zzpersona claude` in `examples/demo-app` is watched; `kill -9` the
  daemon → it returns and still watches the session.

## Non-goals

Windows; lingering on Linux; the tray app; updating the CLI; restarting a daemon of another
version.

## Open questions

1. Whether `zzpersona mod install` should offer `daemon install` (one setup step instead of two).
