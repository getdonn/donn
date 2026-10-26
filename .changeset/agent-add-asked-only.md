---
"@getdonn/cli": patch
---

`donn agent add` takes `--answer` only for a question eve has asked that agent before: an answer to an unasked key is refused as `not-asked` before eve runs, so a secret can no longer reach eve's command line (eve 0.83.2 accepts a secret from `--answer` when it was never asked). Run without the answer first, then answer what eve asks. In `donn ui`, a job's `/answer` takes only the key of the question it asked
