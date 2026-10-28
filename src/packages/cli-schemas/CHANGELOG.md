# @getdonn/cli-schemas

## 0.2.0

### Minor Changes

- 920d5ec: `donn agent vendor <folder|git-url>` copies an eve template into `.donn/templates/<name>` and records where it came from in `.donn/templates/sources.json` (source, ref, commit, digest), so a template that lives outside the persona folder, such as a local clone or a git repository, can be used by a project and shared with its teammates. Running it again refreshes the copy and reports what changed, and `--force` replaces a copy that was edited by hand. `donn agent create --template <folder|git-url>` now vendors on the way and declares `template: ./templates/<name>` (`--template-name` picks the name, `--dry-run` writes nothing). `donn agent templates` lists the vendored templates, and `--json` gains `vendored` (`name`, `template`, `source`, `ref?`, `commit?`), empty outside a project; it also takes `--project <dir>`. New errors: `vendor-source-not-found`, `vendor-not-eve-template`, `vendor-source-inside`, `vendor-name-taken`, `vendor-local-edits`, `vendor-fetch-failed`, `git-not-installed`, `invalid-template-name` and `invalid-vendor-record`.

## 0.1.0

### Minor Changes

- d61adc5: A `local` agent now keeps one port per machine, stored on its entry in `~/.donn/agents/index.json`, so a tunnel or a webhook can point at it and still work after a restart or a sync. `donn agent run <name> --port <n>` picks the port (1024 to 65535; checked free before it is stored), and the daemon, the foreground run and `--dev` all reuse it. `donn agent list --json` and `donn status --json` now show the stored `port` of each agent, running or not. A local run now reads `~/.donn/agents/index.json`, and stops with `invalid-agents-index` (and its fix) when that file is corrupt.
