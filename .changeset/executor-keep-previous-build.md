---
"@getdonn/executor": patch
---

A rebuild keeps the version it replaces (behind `<buildDir>.prev`) until the next rebuild, so a reader that resolved the build just before the swap does not lose it mid-read; `donn doctor --fix` leaves that version alone.
