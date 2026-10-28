---
"@getdonn/cli": patch
---

`donn status --watch --json` reads `state.json` again a second after it starts watching it. On macOS the watch went live late, so a switch made in its first moments printed no line until the next change.
