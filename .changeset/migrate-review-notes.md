---
"@getdonn/cli": patch
---

`donn migrate` and `donn doctor` suggest `migrate --project` only for projects it would accept (an occupied `.donn/` is skipped), shell-quote the paths and URLs in their advice, and no longer change anything before refusing to move a relative-link home. An empty `HOME` now counts as unset.
