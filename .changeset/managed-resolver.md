---
"@zzpersona/resolver": minor
---

Resolves the `policy` block (only org, area and team layers may set it; an equal re-set is a no-op)
and records the layer that set each `policy` and `targets.<harness>.managed` key in `provenance`.
