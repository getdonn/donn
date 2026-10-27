# @getdonn/cli

## 0.14.0

### Minor Changes

- f830bc2: `donn status --watch --json` streams status snapshots; `status --json` reports `switched`; `donn ui --page` opens an app route; the app takes `?project=`.

## 0.13.2

### Patch Changes

- 3fda3f2: `donn agent add` takes `--answer` only for a question eve has asked that agent before: an answer to an unasked key is refused as `not-asked` before eve runs, so a secret can no longer reach eve's command line (eve 0.83.2 accepts a secret from `--answer` when it was never asked). Run without the answer first, then answer what eve asks. In `donn ui`, a job's `/answer` takes only the key of the question it asked

## 0.13.1

### Patch Changes

- dc920f3: `donn agent create` no longer leaves `agents.define.<name>` in the project persona when it refuses the agent (a blocking portability entry, a non-empty folder, a failed eve pin or template fetch): the declaration is written only once nothing can refuse the agent, and a persona edited while the create runs is not overwritten
- dc920f3: `donn agent run` for an agent the daemon already runs says it is already running (`already: true`) from any shell: it no longer resolves the agent's env-provider secrets first, so a terminal without those exports no longer fails with `secret-unresolved`

## 0.13.0

### Minor Changes

- f4dbecd: `donn agent add <name> <item>` runs `eve add <item> --non-interactive` in a created agent, under its lock, and passes eve's setup questions on in eve's own shape (`key`, `message`, `kind`, `options`, `recommended`, `required`). On a terminal it asks them and continues; otherwise (and with `--json`) it exits 2 with `needs-answer`, the question and the command that continues it: answer with `--answer key=<JSON>` (repeatable; a value that is not JSON is taken as a string). A secret question (`kind: "environment"`) is never answered on a command line: donn names the variable eve reads and refuses `--answer` for it. For a vercel agent donn runs the `eve link` prerequisite itself; for others it exits 2 with `needs-prerequisite`. `donn agent templates` lists the templates `create` takes, each with the Vercel-only services its code uses, plus `eve:blank`. In `donn ui`, an `agent add` job's question is a `job.question` answered through `POST /v1/jobs/<id>/answer` (a secret question is refused there too), and answer values are hidden in the daemon log and in job views.
- f0ca1db: agent run through the daemon passes the agent's env-provider secrets from your shell; a run from donn ui refuses them with a fix naming the keychain provider
- f0ca1db: `donn ui` opens the donn app in your browser, served by a loopback bridge in the daemon: it listens on 127.0.0.1 only, signs the page in with a one-time code that expires in 60 s and a UI token, checks every request's Host and Origin, runs only an allowlist of commands, streams jobs and events, and can open a file in your editor. `--no-open` prints the URL instead and `--port` picks the port. Turn the bridge off with `daemon.ui: false` in config.yaml. The web app now ships inside `@getdonn/cli` (served from `dist/ui`), so there is nothing else to install.

### Patch Changes

- f4dbecd: `donn agent build --json` also prints what it wrote (`contents.dockerfile`, `contents.envFile`), so `donn ui` can show the Dockerfile and `env.json` without reading files: `env.json` names each secret by its ref, never its value
- f4dbecd: `donn agent deploy <name> --dry-run` says what a deploy would do (whether the agent is linked, the Vercel project, the variable names it would set, whether it is a first deploy) and does none of it: nothing is linked, set, resolved or deployed. `donn ui` shows it in its confirmation before every deploy. A deploy started from `donn ui` has no shell environment, as a run started there has none: an env-provider secret ref fails with the fix to use the keychain provider or deploy from a terminal
- f0ca1db: agent run --json no longer prints an empty exited field
- 6037234: the daemon no longer misses an edit made just after it starts watching: once its file watchers have settled it checks every persona source once more, so a change that landed while they armed is still synced to sessions and created agents
- f4dbecd: every --json error envelope carries a message: a resolver error (`missing-ref`, `cycle`, ...) gets its text form (`missing-ref: ref=team/x, from=project/persona`) beside its details, and a `secrets` error the text that lists its failures
- 6037234: `donn list --json` reports each local persona's file (`path`) and where it comes from (`source`: `local` or `registry`; a layer that resolves from the registry cache has no `path`), and the user overlay (`overlay`), so the app can open every editable layer in an editor

## 0.12.0

### Minor Changes

- 1bd509f: `donn agent`: create, run, build and deploy eve agents built on the project persona (docs/planning/25-agent-runner.md). Every subcommand takes `--json` and `--project <dir>`.
  
  `donn agent create <name>` declares the agent in the project persona when `--template` and `--target` are given (a comment-preserving edit; `--dry-run` shows it), compiles it and prints the compile and portability reports (a blocking entry stops it unless `--accept-portability`), pins the newest eve in the adapter's range (`--eve` overrides it inside the range), and materialises the template: `eve:<slug>` from the eve repository's tarball at its tag, with the archive's commit checked against the tag and the template's digest against the adapter's table (`template-commit-mismatch`, `template-digest-mismatch`); `eve:blank` through `eve init` in a staging folder; or a path template, copied. It then pins eve and the AI SDK packages the generated files import (plus `@workflow/world-postgres` for `world: postgres` and a pinned `vercel` dev dependency for `vercel`), gives the agent its own pnpm workspace settings, installs in place, edits `agent.ts` once to spread `donn`, writes donn's files and the ownership manifest (`.donn/agent.json`), and adds `.env*`, `.output/`, `.vercel/`, `node_modules/` and `.eve/` to its `.gitignore`. A path template is copied without `.git`, `node_modules`, `.output/`, `.eve/`, `.donn/`, `.vercel/` or env files (`.env`, `.env.*`; `.env.example` is kept). A failure after the template is in place leaves the folder for inspection; `--force` replaces an incomplete create and nothing else. Created agents are recorded in `~/.donn/agents/index.json`.
  
  `donn agent list` shows each declared agent's template, target and state (`available`, `created`, `running` with its URL, `built`, `deployed`), whether donn's files match the persona, and `recreate needed (<field>)` when its template, target, path or world changed. `donn agent sync <name> [--dry-run] [--force]` recompiles the persona into donn's files and never touches `agent.ts`; an owned file edited by hand stops it with `owned-file-edited` unless `--force`.
  
  `donn agent env <name> [--resolve] [--format dotenv|json]` lists the environment an agent needs: persona and gateway secrets (names and refs; values only with `--resolve`), plain values, and what is set at run time (the route token, the Workflow database). `donn agent exec <name> -- <command>` runs a command in the agent's folder with that environment resolved and forwards SIGTERM, SIGINT and SIGHUP to it; the child gets no stdin or terminal and its output is passed on line by line, so it is meant for entrypoints and scripts. A secret that does not resolve stops `run`, `exec` and `deploy`, naming the variable and the ref. Through the daemon, secrets resolve in the daemon's own environment, which under `donn daemon install` has none of the shell's exports: a `secret://env/…` ref that does not resolve there says so in its `fix` (use the keychain provider, or run with the daemon stopped). The child env is always `NODE_ENV=production`, without `VITEST`, `EVE_DEV` or `EVE_MOCK_AUTHORED_MODELS`, whatever the persona's env says.
  
  `donn agent run <name>` builds a `local` or `self-host` agent (`eve build`) and starts it (`eve start --host 127.0.0.1 --port 0`, its env resolved, a new route token per run, sent as `Authorization: Bearer`) through the daemon when one runs, else in the foreground until Ctrl-C; `--dev` runs `eve dev` with its terminal UI instead, never through the daemon (the only way to run a `vercel` agent here: its routes take Vercel's OIDC). `donn agent stop <name>` stops the agent's process group and reports the `eve-sbx-*` sandbox containers still running and the stopped ones eve keeps to resume their sessions (`leftovers` and `exited` in `--json`); `donn agent logs <name> [--follow]` prints or tails the daemon run's log (`~/.donn/agents/<project hash>/<name>.log`), which never holds the token or a secret value.
  
  The daemon serves `GET /agents` and `POST /agents/run|stop`, emits `agent.created`, `agent.synced`, `agent.sync-failed`, `agent.started`, `agent.stopped` and `agent.failed` (never a token or env value), stops its agents when it closes, and runs `agent list|sync|run|stop|create|build|env` (not `env --resolve`) from `POST /run`. It keeps created agents current: on a change to a project's `.donn/`, a shared layer, the overlay, config or a registry pull it syncs the agents that change reaches (never forced, one sync of an agent at a time, under a per-agent lock shared with the terminal), and restarts a running agent whose files or env inputs changed. A sync or start that stops reports the error's own code (`invalid-persona`, `secret-unresolved`, ...), in `agent.sync-failed`, `agent.failed` and the `POST /agents/run` answer. `donn status` adds a line per created agent: `agent  <name>  <target>  <state>  current|stale`, with `recreate needed (<field>)` or `sync-failed: <code>`.
  
  `donn agent build <name> [--force]` builds a `self-host` agent: `eve build` on this host, against the Docker daemon the agent will run on (it prepares the sandbox template image there), then the donn-owned `deploy/donn/Dockerfile` (`node:26-slim`, the `docker` CLI, the built `.output/`, `VOLUME /agent/.eve`) and `deploy/donn/env.json` (each env name with its source and why, never a secret's value, plus the sandbox image, the socket mount, the volume and the proxy rule for `/eve/` and `/.well-known/workflow/`). It names the two images to ship: the agent's and the sandbox template image. With `world: postgres` the image creates the Workflow schema (`bootstrap`) before the server starts. A deploy file edited by hand stops the next build unless `--force`. `build` and `deploy` refuse an agent whose donn files are older than its persona with `agent-stale` (fix: `donn agent sync <name>`), so stale files are never shipped; a foreground `run` prints a warning and runs. Other targets are refused (`target-not-buildable`), and a Docker that does not answer is `docker-unreachable`.
  
  `donn agent deploy <name> [--yes]` deploys a `vercel` agent: `eve link --non-interactive --project <name>` when the folder is not linked, then, after listing the variable names it will set (never values) and asking (always on a first deploy; `--yes` for scripts), `vercel env add <name> production` with each value on stdin, and `eve deploy --non-interactive --yes`, printing the deployment URL. A variable Vercel already has is kept, never overwritten, and a variable whose value changed after it was pushed is not updated. `--json` without `--yes`, or no terminal, fails with `confirmation-required` and the names, before any secret is resolved. Without the Vercel CLI in the agent it is `vercel-cli-missing` (fix: add it as the agent's dev dependency), and other targets are refused (`target-not-deployable`).
  
  `donn doctor` adds lines per created agent: `agent:<name>:eve` (the pinned eve inside the adapter's range), `agent:<name>:docker` (`local` and `self-host`), `agent:<name>:gateway` (the gateway's `baseURL` answers; a warning when not), `agent:<name>:agent-ts` (it still spreads `donn`), `agent:<name>:files` (the manifest's files and build's are present) and `agent:<name>:vercel` (the Vercel CLI runs in a `vercel` agent), or `agent:<name>:orphan` for an agent its persona no longer declares. Without created agents it adds nothing. A check id longer than the column now keeps a space before its message.

### Patch Changes

- Updated dependencies [c4fd06d]
- Updated dependencies [c4fd06d]
- Updated dependencies [1bd509f]
  - @getdonn/adapter-sdk@0.6.0
  - @getdonn/adapter-eve@0.2.0
  - @getdonn/spec@0.5.0
  - @getdonn/resolver@0.7.0
  - @getdonn/adapter-agents-md@0.4.1
  - @getdonn/adapter-claude-code@0.4.1
  - @getdonn/adapter-codex@0.4.1
  - @getdonn/executor@0.3.4
  - @getdonn/registry-api@0.7.1
  - @getdonn/secrets@0.3.3
  - @getdonn/store-local@0.2.3
  - @getdonn/store-remote@0.5.3

## 0.11.4

### Patch Changes

- 0a8ed7a: `@getdonn/adapter-sdk` gains the `AgentAdapter` contract, its conformance kit and `PortabilityService`. `@getdonn/adapter-eve` is new: it compiles a persona into the files of an eve agent (instructions, skills, MCP connections and model routing through a gateway), with an ownership manifest and a portability report per template.
  
  `docs/capabilities.md` and `donn capabilities --markdown` list the agent adapters beside the harnesses.
- 30c7d52: The registry refresh and the daemon use the same home-folder lookup as the rest of the CLI, and `donn migrate` tells an unset `HOME` apart from an empty one when it cannot find a home folder.
- 4e51f5d: Personas can declare `models` (gateway routing, lockable) and `agents`; every harness adapter reports `models` (not yet supported). See docs/planning/23-models-and-agents.md.
  
  A layer that uses a path agent template now publishes that template folder with it (missing or escaping folders are refused). Header names in `models.gateway.headers` and in MCP url-server `headers` must be valid HTTP header names.
- Updated dependencies [0a8ed7a]
- Updated dependencies [4e51f5d]
  - @getdonn/adapter-sdk@0.5.0
  - @getdonn/adapter-eve@0.1.0
  - @getdonn/spec@0.4.0
  - @getdonn/resolver@0.6.0
  - @getdonn/adapter-claude-code@0.4.0
  - @getdonn/adapter-codex@0.4.0
  - @getdonn/adapter-agents-md@0.4.0
  - @getdonn/registry-api@0.7.0
  - @getdonn/executor@0.3.3
  - @getdonn/secrets@0.3.2
  - @getdonn/store-local@0.2.2
  - @getdonn/store-remote@0.5.2

## 0.11.3

### Patch Changes

- ba5d3fc: `donn migrate` and `donn doctor` suggest `migrate --project` only for projects it would accept (an occupied `.donn/` is skipped), shell-quote the paths and URLs in their advice (with absolute paths), and no longer change anything before refusing to move a relative-link home. An empty `HOME` now falls back everywhere (config `~/`, plugins, the login service, shell hints) to the system's record of the home folder, and `donn migrate` refuses when no absolute home can be found.

## 0.11.2

### Patch Changes

- 975c9f2: `donn migrate` and `donn doctor` agree on where the old home is and what is in `~/.donn` (an empty folder, or only what `donn init` and `donn login` wrote), `doctor` warns about projects not migrated yet and keeps their switches under `--fix`, and a relative-symlink old home moves intact. `migrate` exits 1 while a step is pending, and `ZZPERSONA_HOME=~/.zzpersona` (unexpanded) counts as the default old home.
- Updated dependencies [70b04a0]
  - @getdonn/executor@0.3.2

## 0.11.1

### Patch Changes

- 14c7f82: First npm release.
- Updated dependencies [14c7f82]
  - @getdonn/spec@0.3.1
  - @getdonn/resolver@0.5.1
  - @getdonn/adapter-sdk@0.4.1
  - @getdonn/adapter-claude-code@0.3.1
  - @getdonn/adapter-codex@0.3.1
  - @getdonn/adapter-agents-md@0.3.1
  - @getdonn/store-local@0.2.1
  - @getdonn/store-remote@0.5.1
  - @getdonn/secrets@0.3.1
  - @getdonn/executor@0.3.1
  - @getdonn/registry-api@0.6.1
  - @getdonn/mod-claude-code@0.4.1

## 0.11.0

### Minor Changes

- 035af67: Renamed from zzpersona to donn. Run `donn migrate` once on a machine that ran zzpersona.

### Patch Changes

- Updated dependencies [035af67]
  - @getdonn/adapter-agents-md@0.3.0
  - @getdonn/adapter-claude-code@0.3.0
  - @getdonn/adapter-codex@0.3.0
  - @getdonn/adapter-sdk@0.4.0
  - @getdonn/executor@0.3.0
  - @getdonn/mod-claude-code@0.4.0
  - @getdonn/registry-api@0.6.0
  - @getdonn/resolver@0.5.0
  - @getdonn/secrets@0.3.0
  - @getdonn/spec@0.3.0
  - @getdonn/store-local@0.2.0
  - @getdonn/store-remote@0.5.0

## 0.10.0

### Minor Changes

- d221b8b: `zzpersona managed build|install|uninstall|check` for machine-wide Claude Code policy, with
  `build --from-registry` (checks every path and digest the registry sends before writing), a
  `managed:` line in `status` and a `doctor` check. See the README's "Managed policy" section.
  
  **Breaking for third-party adapters:** `FIXED_CAPABILITY_FIELDS` gained `policy`.

### Patch Changes

- Updated dependencies [d221b8b]
- Updated dependencies [d221b8b]
- Updated dependencies [d221b8b]
- Updated dependencies [d221b8b]
- Updated dependencies [d221b8b]
- Updated dependencies [d221b8b]
- Updated dependencies [d221b8b]
  - @zzpersona/adapter-claude-code@0.2.0
  - @zzpersona/adapter-sdk@0.3.0
  - @zzpersona/adapter-codex@0.2.0
  - @zzpersona/adapter-agents-md@0.2.0
  - @zzpersona/registry-api@0.5.0
  - @zzpersona/resolver@0.4.0
  - @zzpersona/spec@0.2.0
  - @zzpersona/store-remote@0.4.0
  - @zzpersona/executor@0.2.2
  - @zzpersona/store-local@0.1.2
  - @zzpersona/secrets@0.2.1

## 0.9.1

### Patch Changes

- a7c3615: `zzpersona login` shows the sign-in code as `XXXX-XXXX`, the way the confirm page shows it, so the two can be compared at a glance.

## 0.9.0

### Minor Changes

- 202b37e: Registry identity (spec 20). `zzpersona login <url>` signs in through the browser (`--no-browser`
  prints the link only; `--token` is the old hidden prompt, `--token-stdin` is unchanged). The
  registry contract gains the sign-in routes, roles in `whoami`, and the `forbidden` problem with a
  grant hint on `publish`; clients read answers tolerantly. The conformance kit gains optional hooks
  (`start(options?)`, `supportsLoginTiming`, `limitedToken`, `completeLogin`, `refuseLogin`,
  `signIn`) and skips the cases a registry cannot run; `signIn` gates only the `404 not-found` case:
  `signIn: false` declares a registry without sign-in and runs it; unset or `true` skips it. The kit's problem
  items are strict. `doctor` shows the session end date.
  
  A registry with sign-in needs `@zzpersona/cli` 0.9.0 or later (product release 0.11.0): older
  CLIs reject the new fields.

### Patch Changes

- Updated dependencies [202b37e]
  - @zzpersona/registry-api@0.4.0
  - @zzpersona/store-remote@0.3.0

## 0.8.1

### Patch Changes

- Updated dependencies [eed515f]
  - @zzpersona/registry-api@0.3.0
  - @zzpersona/store-remote@0.2.1

## 0.8.0

### Minor Changes

- 9ca114a: A registry for shared layers. `zzpersona login|logout|whoami|pull|publish` publish `org/*`,
  `area/*` and `team/*` layers as bundles and pull them into a read-only cache that resolves offline;
  a published layer wins over a same-name local file with a warning, and `--local` leaves the cache
  out. New `@zzpersona/registry-api` (the contract, a mock server and a conformance kit) and
  `@zzpersona/store-remote` (the client). The resolver's `PersonaSource` gains `dir`; the keychain
  provider can write and delete, and macOS exit 44 now means a missing secret.

### Patch Changes

- Updated dependencies [9ca114a]
  - @zzpersona/resolver@0.3.0
  - @zzpersona/secrets@0.2.0
  - @zzpersona/registry-api@0.2.0
  - @zzpersona/store-remote@0.2.0
  - @zzpersona/store-local@0.1.1
  - @zzpersona/executor@0.2.1

## 0.7.1

### Patch Changes

- 6eee336: Hardening after 0.8.0. The daemon: doctor and `daemon stop` tell a reused pid from a daemon; a
  failed service reinstall keeps the working one; `daemon uninstall` unloads a job whose file was
  removed; the version-mismatch hint says `daemon install` under the service; the lock survives a
  stopping daemon, a crashed takeover and homes without hard links. `switch`: sessions in symlinked
  checkouts are counted, a hung adapter times out after 5 s, the `agents-md` line says what
  `AGENTS.md` carries.

## 0.7.0

### Minor Changes

- 2b19309: `zzpersona switch` says what the choice means in each installed harness: what it drops or
  approximates, which sessions here still run another persona (and how to move them), and that the
  committed `AGENTS.md` keeps the shared project persona. `--harness <id>` reports one harness; the
  `--json` result gains `harnesses`.

## 0.6.0

### Minor Changes

- 6e8de14: The daemon can run as a login service: `zzpersona daemon install` sets it up as a launchd agent
  (macOS) or a systemd user unit (Linux) that starts at login and comes back after a crash;
  `zzpersona daemon uninstall` removes it. `zzpersona claude` and `codex` start the daemon when it is
  not running; turn that off with `daemon: { autoStart: false }` in `config.yaml` or
  `ZZPERSONA_NO_DAEMON=1`. Two daemons can no longer start for one home in a race.

## 0.5.1

### Patch Changes

- 79fae53: Explain a harness only the shell finds: `zzpersona claude` (and `codex`) and `doctor` say when
  claude is a shell alias PATH lacks, or when the shell predates a PATH change, and doctor warns when
  the shell's claude alias runs a different claude than zzpersona does. The mod's nudge for a plain
  `claude` session mentions `zzpersona claude -- --continue`.
- Updated dependencies [79fae53]
  - @zzpersona/mod-claude-code@0.3.1

## 0.5.0

### Minor Changes

- e6b91b9: The Claude Code mod's `/persona` goes through the daemon when it runs. The daemon serves the mod's
  commands (`POST /run`), so `/persona` is faster and works where policy stops the mod from running
  programs; without the daemon the mod runs `zzpersona` as before. The mod's replies no longer
  repeat the `zzpersona:` prefix Claude Code already shows.

### Patch Changes

- Updated dependencies [e6b91b9]
  - @zzpersona/mod-claude-code@0.3.0

## 0.4.3

### Patch Changes

- Updated dependencies
  - @zzpersona/mod-claude-code@0.2.3

## 0.4.2

### Patch Changes

- ea9583b: Real-use hardening. `zzpersona --version` (and `-V`, `--json`) prints the CLI version.
  `zzpersona` run from a deleted folder says so instead of crashing. doctor's `personas` check
  accepts a personas folder inside a larger git repository. The daemon re-checks after backing off
  for a switch you made mid-refresh, and lets go of a dead session whose folder cannot be removed
  instead of recompiling every second. The CLI retries once when the daemon refuses its token (a
  restart in between) and reports a refused token as `daemon-unauthorized`, not "not running";
  `daemon stop` then stops it by pid and doctor warns. The mod skips its per-turn check on a Claude
  Code without the file system API instead of failing the hook.
- Updated dependencies [ea9583b]
  - @zzpersona/mod-claude-code@0.2.2

## 0.4.1

### Patch Changes

- Updated dependencies [bf600f2]
  - @zzpersona/mod-claude-code@0.2.1

## 0.4.0

### Minor Changes

- 2ff9978: The daemon, first slice. `zzpersona daemon start|stop|status|refresh` runs a background process per
  home with a socket API and a session registry; it watches persona sources and refreshes live Claude
  Code sessions on their next turn when a persona is edited (Codex sessions show as stale).
  `zzpersona status` lists the sessions the daemon knows of, and `doctor` gains a `daemon` check that
  tells an unresponsive daemon from a stale one.

### Patch Changes

- Updated dependencies [02319f1]
  - @zzpersona/mod-claude-code@0.2.0

## 0.3.0

### Minor Changes

- 07ec8c0: The `agents-md` adapter. `zzpersona write [--check | --remove]` renders the repo's project persona
  (without the user overlay, switches or default) into a marked block of `<repo>/AGENTS.md`, leaving
  everything outside the block byte for byte; `--check` fails in CI when the block is stale. The
  block carries instructions, knowledge pointers and tool rules as guidance, and the report lists
  what an `AGENTS.md` cannot carry. The SDK's overlay steps gain an optional `block`, the executor
  `applyOverlay`, and the conformance kit a `noBinary` option for file-format adapters.
- 9114c9e: The capability matrix. `zzpersona capabilities [--harness <id>] [--detect] [--markdown] [--json]`
  shows what each harness carries (native, approximated, advisory, none) and why, and
  `docs/capabilities.md` publishes it, kept current by a test (`pnpm docs:capabilities`).
  
  **Breaking for third-party adapters:** the conformance kit's new `complete-matrix` check requires
  a matrix to declare every field (`capabilityFields(id)`) and a `note` on every field that is not
  native. `requiredEntries` now returns each entry's `reason`, taken from the note; capability
  entries gain an optional `caveat`. agents-md now reports dropped secrets as secrets.
- 1cb2c84: The Codex adapter. `zzpersona codex [persona] [-- <codex args>]` launches Codex CLI with the
  persona's instructions (`developer_instructions`), MCP servers (secrets resolved into the launch
  environment and forwarded by name), MCP tool approvals and `-s workspace-write -a on-request`
  defaults, all as `-c` overrides; nothing is written to `~/.codex`. `targets.codex` sets the
  sandbox, approval and model. Skills and hooks are reported dropped. `compile --harness codex`
  dry-runs the build, and `doctor` gains an optional `codex` check.

### Patch Changes

- Updated dependencies [07ec8c0]
- Updated dependencies [9114c9e]
- Updated dependencies [1cb2c84]
  - @zzpersona/adapter-sdk@0.2.0
  - @zzpersona/executor@0.2.0
  - @zzpersona/adapter-agents-md@0.1.0
  - @zzpersona/adapter-claude-code@0.1.2
  - @zzpersona/adapter-codex@0.1.0

## 0.2.1

### Patch Changes

- dfe271d: Setup and polish from first real use. A root README with install steps (putting `zzpersona` on
  PATH with pnpm 12). `zzpersona doctor` gains a `cli` check (is `zzpersona` on PATH, as the mod needs)
  and names the `claude` binary it checked; `zzpersona mod install` warns when `zzpersona` is not on
  PATH. The nudge suggests `/persona use` in sessions that can switch live; `/persona switch X
  --default` says how to relaunch with X; doctor's `--fix` says what it removed; `init --personas`
  keeps the comments in `config.yaml`.
- Updated dependencies [dfe271d]
  - @zzpersona/mod-claude-code@0.1.1

## 0.2.0

### Minor Changes

- 621e1d8: Live in-session switching for Claude Code. `zzpersona claude` launches with a per-session folder of
  plugins (removed on exit; `doctor --fix` cleans up orphans) and `zzpersona live <persona> --session
  <dir>` swaps the persona plugin inside it, so skills, hooks and agents change mid-session; it
  reports which MCP servers and permissions stay as launched and whether the new persona denies
  more. The mod adds `/persona use <persona>` (this session only), `/persona switch` now also applies
  live, and the new persona's instructions supersede the launch instructions through the system
  prompt, surviving compaction. `system-prompt.md` now starts with `## zzpersona persona: <ref>`.
- 05b004e: The Claude Code mod. `@zzpersona/mod-claude-code` shows the active persona above the prompt, nudges
  when the current folder selects a different one (or when a plain `claude` session runs in a folder
  that has one), and adds `/persona [list | switch <persona> [--default] | clear [--default]]`. It
  calls the CLI for every answer and says "zzpersona unavailable" with the reason when it cannot.
  `zzpersona mod install|uninstall` registers it with Claude Code through a local folder
  marketplace, and `doctor` checks it is installed and current. `zzpersona list` lists every persona,
  `zzpersona claude` tells the session which persona it runs (`ZZPERSONA_PERSONA`,
  `ZZPERSONA_SOURCE`, `ZZPERSONA_PROJECT`), and persona plugin names map `/` to `--` so nested and
  hyphenated refs never collide.

### Patch Changes

- Updated dependencies [621e1d8]
- Updated dependencies [05b004e]
  - @zzpersona/mod-claude-code@0.1.0
  - @zzpersona/adapter-claude-code@0.1.1
  - @zzpersona/executor@0.1.1

## 0.1.0

### Minor Changes

- 9c617cc: The Phase 1 core loop. `@zzpersona/store-local` mounts a personas folder, the project's
  `.zzpersona/` and `~/.zzpersona/` onto the resolver's single root by layer. `@zzpersona/secrets`
  resolves `secret://` refs (env backend) all-or-nothing. `@zzpersona/executor` provides the real
  probe, atomic builds with per-mount real-path containment, and `runPlan`. `@zzpersona/cli` adds
  `zzpersona resolve`, `compile` and `claude`, each with `--json`.
- 40b2ace: Daily use. `zzpersona switch` chooses a persona per project or a default (`~/.zzpersona/state.json`),
  with one selection rule for every command (argument → switch → project → default). `zzpersona init`
  sets up a machine (`--personas`) or a project (`--extends`), flags only. `zzpersona doctor` checks
  the whole setup and `--fix` removes orphaned switches and build leftovers. Hardening: signal exit
  codes, `--json` usage errors, passthrough only for `claude`, an empty `ZZPERSONA_HOME` means unset,
  `.yaml` and "did you mean" in persona arguments; the store lists only real (and symlinked) personas
  and refuses instruction files that resolve outside their location.
- 9d21335: Reach. Third-party adapters and secret providers load from `adapters:` and `secretProviders:` in
  `config.yaml` (packages from `~/.zzpersona/adapters`, or paths), only when a command needs one;
  `compile --harness <id>` works with any loaded adapter and `doctor` checks every listed plugin.
  `@zzpersona/secrets` gains `SecretContext`, `defineSecretProvider` and a built-in `keychain`
  provider (macOS `security`, Linux `secret-tool`), with `doctor` printing the command that stores a
  missing item. `zzpersona diff [a] <b>` shows what changes between two personas, with provenance.
  Hardening: class-based adapters keep their methods, an SDK-owned `Platform` type, conformance
  reports a missing `chdir`, `strictMcp` must be a boolean, later managed-settings drop-ins win, no
  empty objects in settings.json, concurrent switches no longer lose entries, `switch` and `init`
  edge cases, error envelopes always carry a message, and project files may link elsewhere in their
  repo.

### Patch Changes

- Updated dependencies [3ff16cd]
- Updated dependencies [9c617cc]
- Updated dependencies [40b2ace]
- Updated dependencies [9d21335]
  - @zzpersona/adapter-sdk@0.1.0
  - @zzpersona/adapter-claude-code@0.1.0
  - @zzpersona/store-local@0.1.0
  - @zzpersona/secrets@0.1.0
  - @zzpersona/executor@0.1.0
  - @zzpersona/resolver@0.2.0
