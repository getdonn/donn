---
"@zzpersona/cli": minor
---

The daemon can run as a login service: `zzpersona daemon install` sets it up as a launchd agent
(macOS) or a systemd user unit (Linux) that starts at login and comes back after a crash;
`zzpersona daemon uninstall` removes it. `zzpersona claude` and `codex` start the daemon when it is
not running; turn that off with `daemon: { autoStart: false }` in `config.yaml` or
`ZZPERSONA_NO_DAEMON=1`. Two daemons can no longer start for one home in a race.
