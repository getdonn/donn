---
"@getdonn/cli": minor
"@getdonn/cli-schemas": minor
---

`donn agent vendor <folder|git-url>` copies an eve template into `.donn/templates/<name>` and records where it came from in `.donn/templates/sources.json` (source, ref, commit, digest), so a template that lives outside the persona folder, such as a local clone or a git repository, can be used by a project and shared with its teammates. Running it again refreshes the copy and reports what changed, and `--force` replaces a copy that was edited by hand. `donn agent create --template <folder|git-url>` now vendors on the way and declares `template: ./templates/<name>` (`--template-name` picks the name, `--dry-run` writes nothing). `donn agent templates` lists the vendored templates, and `--json` gains `vendored` (`name`, `template`, `source`, `ref?`, `commit?`), empty outside a project; it also takes `--project <dir>`. New errors: `vendor-source-not-found`, `vendor-not-eve-template`, `vendor-source-inside`, `vendor-name-taken`, `vendor-local-edits`, `vendor-fetch-failed`, `git-not-installed`, `invalid-template-name` and `invalid-vendor-record`.
