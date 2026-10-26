---
"@getdonn/cli": patch
---

`donn agent deploy <name> --dry-run` says what a deploy would do (whether the agent is linked, the Vercel project, the variable names it would set, whether it is a first deploy) and does none of it: nothing is linked, set, resolved or deployed. `donn ui` shows it in its confirmation before every deploy. A deploy started from `donn ui` has no shell environment, as a run started there has none: an env-provider secret ref fails with the fix to use the keychain provider or deploy from a terminal
