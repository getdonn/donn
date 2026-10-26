---
"@getdonn/cli": patch
---

every --json error envelope carries a message: a resolver error (`missing-ref`, `cycle`, ...) gets its text form (`missing-ref: ref=team/x, from=project/persona`) beside its details, and a `secrets` error the text that lists its failures
