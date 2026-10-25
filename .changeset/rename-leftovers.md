---
"@getdonn/cli": patch
---

`donn migrate` and `donn doctor` agree on where the old home is and what is in `~/.donn` (an empty folder, or only what `donn init` and `donn login` wrote), `doctor` warns about projects not migrated yet and keeps their switches under `--fix`, and a relative-symlink old home moves intact. `migrate` exits 1 while a step is pending, and `ZZPERSONA_HOME=~/.zzpersona` (unexpanded) counts as the default old home.
