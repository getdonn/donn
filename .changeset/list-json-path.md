---
"@getdonn/cli": patch
---

`donn list --json` reports each local persona's file (`path`) and where it comes from (`source`: `local` or `registry`; a layer that resolves from the registry cache has no `path`), and the user overlay (`overlay`), so the app can open every editable layer in an editor
