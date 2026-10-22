---
"@zzpersona/registry-api": minor
"@zzpersona/store-remote": minor
"@zzpersona/cli": minor
---

Registry identity (spec 20). `zzpersona login <url>` signs in through the browser (`--no-browser`
prints the link only; `--token` is the old hidden prompt, `--token-stdin` is unchanged). The
registry contract gains the sign-in routes, roles in `whoami`, and the `forbidden` problem with a
grant hint on `publish`; clients read answers tolerantly. The conformance kit gains optional hooks
(`start(options?)`, `supportsLoginTiming`, `limitedToken`, `completeLogin`, `refuseLogin`,
`signIn`) and skips the cases a registry cannot run; `signIn` gates only the `404 not-found` case:
`signIn: false` declares a registry without sign-in and runs it; unset or `true` skips it. The kit's problem
items are strict. `doctor` shows the session end date.

A registry with sign-in needs `@zzpersona/cli` 0.9.0 or later (product release 0.11.0): older
CLIs reject the new fields.
