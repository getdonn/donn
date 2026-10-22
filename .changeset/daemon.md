---
"@zzpersona/cli": minor
---

The daemon, first slice. `zzpersona daemon start|stop|status|refresh` runs a background process per
home with a socket API and a session registry; it watches persona sources and refreshes live Claude
Code sessions on their next turn when a persona is edited (Codex sessions show as stale).
`zzpersona status` lists the sessions the daemon knows of, and `doctor` gains a `daemon` check that
tells an unresponsive daemon from a stale one.
