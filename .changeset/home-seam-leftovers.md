---
"@getdonn/cli": patch
---

The registry refresh and the daemon use the same home-folder lookup as the rest of the CLI, and `donn migrate` tells an unset `HOME` apart from an empty one when it cannot find a home folder.
