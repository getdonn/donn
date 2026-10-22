---
"@zzpersona/cli": patch
---

Hardening after 0.8.0. The daemon: doctor and `daemon stop` tell a reused pid from a daemon; a
failed service reinstall keeps the working one; `daemon uninstall` unloads a job whose file was
removed; the version-mismatch hint says `daemon install` under the service; the lock survives a
stopping daemon, a crashed takeover and homes without hard links. `switch`: sessions in symlinked
checkouts are counted, a hung adapter times out after 5 s, the `agents-md` line says what
`AGENTS.md` carries.
