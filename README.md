# donn

A persona compiler and control plane for AI coding harnesses. A **persona** is a declarative,
composable bundle (instructions, skills, MCP servers, permissions, hooks, knowledge pointers,
secret refs) that inherits through org → area → team → project → user layers and compiles to each
harness's native config. Claude Code is the first harness.

Personal project; planning lives in `docs/planning/` (start with `00-handoff.md`).

## Install

Requires Node 24 or later and, for the Claude Code pieces, Claude Code itself.

```sh
npm i -g @getdonn/cli
donn doctor                              # checks the setup, says what to fix
```

`donn` must be a real executable on `PATH`, not a shell alias: the Claude Code mod and
`donn claude` start programs without a shell.

Upgrading from zzpersona? Run `donn migrate` right after installing donn, before any other donn
command (see [Upgrading from zzpersona](#upgrading-from-zzpersona)).

## Examples

`examples/` has a demo project with org, team and project personas to try everything on; see
[`examples/README.md`](examples/README.md).

## First use

```sh
donn init --personas ~/personas          # a personas folder with a starter org/base
cd <a repo> && donn init --extends org/base   # give the repo a project persona
donn claude                              # launch Claude Code with the persona

donn mod install                         # the Claude Code mod: band, nudge, /persona
```

Inside a `donn claude` session: `/persona`, `/persona list`, `/persona use <persona>` (this
session only) and `/persona switch <persona>` (remembered for the folder, and applied now).

## Switching

`donn switch <persona>` chooses the persona for this repo (outside a repo, or with
`--default`, your default); every harness uses it from its next launch. After saving, it says what
the choice means in each installed harness:

```
team/web is now used for ~/src/web
claude-code  ok · approximates knowledge (1) · 1 session here still runs project/persona: /persona use team/web
codex        drops skills (1) · approximates knowledge (1), permissions (5)
agents-md    AGENTS.md carries project/persona (shared); team/web applies to donn launches only
```

Sessions are counted when the daemon runs. `AGENTS.md` always carries the repo's shared project
persona, so other tools that read it do not follow your switch. `--harness <id>` reports one
harness; `switch --clear` reports for the persona that applies after clearing; `--json` adds a
`harnesses` list. A harness that cannot compile the persona is reported as `error`; the switch is
still saved. An unknown `--harness` id is refused before anything is saved.

Every command takes `--json`. `donn --help` lists them.

## Shared `AGENTS.md`

Tools that read a repo's `AGENTS.md` (Codex, Copilot CLI, and Claude Code when there is no
`CLAUDE.md`) can get the project persona too, through a generated block you commit:

```sh
donn write              # render project/persona into a marked block of <repo>/AGENTS.md
donn write --check      # in CI: exit 1 when the block is out of date
donn write --remove     # take the block out again
```

Everything outside the block is left as you wrote it. The block carries instructions, knowledge
pointers and tool rules as guidance; the report lists what an `AGENTS.md` cannot carry (skills, MCP
servers, hooks, enforced permissions).

## Codex

`donn codex` launches Codex CLI with a persona, the way `donn claude` launches Claude
Code. Nothing is written to `~/.codex`: everything goes on the command line as `-c` overrides.

```sh
donn codex                     # the project persona (or your switch or default)
donn codex team/payments -- exec "fix the failing test"   # arguments after -- go to codex
donn compile --harness codex   # see the build and the report without launching
```

Carried over: instructions (as developer instructions, on top of Codex's own), knowledge pointers,
MCP servers, with secrets resolved into the launch environment and forwarded by name, and
MCP tool allow rules (`mcp__<server>__<tool>` runs without asking; `mcp__<server>__*` approves the whole server). Codex runs with
`-s workspace-write -a on-request` unless the persona sets `targets.codex.sandbox`, `.approval`
or `.model` (set them there: Codex refuses `-s`, `-a` or `-m` a second time after `--`).
Other permission rules are guidance in the instructions, not enforced. Skills and
hooks do not carry over: Codex has no per-launch skill folder, and it does not run hooks it has
not been told to trust. The report lists each one. (`codex exec` is non-interactive, so Codex
runs it with approval `never`; the sandbox still applies.)

## Keeping sessions current

```sh
donn daemon start    # a background process, per DONN_HOME
donn status          # the sessions it knows of, and whether each is current
donn ui              # the app in your browser, served by the daemon (--no-open, --port)
donn daemon stop
```

With the daemon running, edit a persona and your running Claude Code sessions pick it up on their
next turn. MCP servers, permissions and settings still need a relaunch. Codex sessions cannot be
updated in place: they show as stale.

With the daemon running, `/persona` in the Claude Code mod goes through it too: faster, and it works
where policy stops the mod from running programs. Without the daemon the mod runs `donn` as
before.

To keep the daemon running without starting it yourself, install it as a login service (a launchd
agent on macOS, a systemd user unit on Linux; it restarts after a crash):

```sh
donn daemon install     # run again after a CLI update or a PATH change
donn daemon uninstall
```

The daemon writes to `daemon.log` in the home's `daemon/` folder; on Linux the service's output
goes to the journal instead (`journalctl --user -u donn-daemon`).

`donn claude` and `donn codex` also start the daemon when it is not running (through the
service when it is installed), waiting at most a second; the launch goes ahead either way. So
`donn daemon stop` lasts until the next `donn claude` or `codex` (or, with the service,
the next login). To turn that off, set `daemon: { autoStart: false }` in `config.yaml` (in
`~/.donn`, or `DONN_HOME`), or `DONN_NO_DAEMON=1` for one run.

## Registry

A team lead can publish a layer (`org/*`, `area/*` or `team/*`) to a registry; everyone else pulls it
and resolves against exactly what was published, offline once pulled.

```sh
donn login https://registry.example.com   # sign in through your browser
donn publish team/web --dry-run           # what would change; nothing is stored
donn publish team/web                     # published team/web @2
donn pull                                 # team/web 1 → 2
```

Pulled layers sit in a read-only cache under `~/.donn/cache/registry/`. A published layer wins
over a same-name file in your personas folder, with `team/web: using published @2; local copy
differs` once per command; `--local` on `resolve`, `compile` and `diff` leaves the cache out, for
authoring. `claude`, `codex` and `switch` pull first when the cache is older than `registry.maxAge`
(15 minutes), within a second; if the registry is down, or you are not logged in or the token is
refused, they say so and use the cache. `publish` refuses a stale base (`donn pull`, then
publish again) and a change that breaks a published layer below it (`--force` publishes anyway).
The token goes in the OS keychain (`DONN_REGISTRY_TOKEN` overrides it for CI) and never in
output. `resolve --json` and `switch --json` list the published versions used as `builtFrom`.
`donn logout` removes the token; the contract is `docs/planning/18-registry-contract.md`.

### Signing in

`donn login <url>` signs you in through the registry's own identity provider. The terminal
prints `Open <link> and confirm the code ABCD-EFGH` and opens the link in your browser; the page
shows the same code, you sign in there and confirm, and the terminal finishes with `logged in to
<url> as <you> (session until <date>)`. Ctrl-C cancels. The code is your check that the browser and
the terminal are the same sign-in: if they differ, close the page. `--no-browser` only prints the
link (so does `CI`), for a remote shell. The link must have the registry's own protocol and
origin, or the CLI refuses it; it never opens anything else.

For a registry with no sign-in, or for CI, `--token` asks for a token at a hidden prompt and
`--token-stdin` reads it from stdin (`DONN_REGISTRY_TOKEN` still overrides the stored one).
Sessions end: `whoami` and `doctor` show the date, and you sign in again after it.

`donn whoami` lists your roles, e.g. `roles: publish team/web, lock org`. Who may publish or
lock which layer is set on the registry, not in your persona files. When a `publish` is refused
with `forbidden`, the hint names the grant to ask a registry admin for.

A registry with sign-in needs `@getdonn/cli` 0.9.0 or later, which is this release (product
0.11.0): older CLIs reject the new fields in its answers. A 401 on `POST /v1/auth/logins` is read as no
sign-in (registries from before identity), so the CLI points you to `--token-stdin`.

## Managed policy

Locks in an `org/`, `area/` or `team/` layer can be enforced machine-wide by Claude Code, so a
developer cannot undo them from their own settings. `donn` compiles the locks of a layer and
its ancestors to the files Claude Code reads from its administrator-owned policy folder
(`/Library/Application Support/ClaudeCode/` on macOS, `/etc/claude-code/` on Linux,
`C:\Program Files\ClaudeCode\` on Windows).

```sh
donn managed build --layer org/acme --os linux   # ./donn-managed/ and a report
sudo donn managed install ./donn-managed         # shows the plan, asks (or --yes)
donn managed check                               # current, stale, edited, missing, ...
sudo donn managed uninstall                      # removes exactly the files it installed
```

`build` compiles from the local store (published layers from the pull cache); `--from-registry`
downloads the bundle from a registry that builds them (`GET /v1/managed/bundle`), checking every
path and digest before it writes. `--os` defaults to this machine's, so an admin can build for
another. `install` verifies the bundle, refuses an unsafe folder (a symlink, or when root a folder
others can write), writes atomically and never touches `managed-settings.json`, other drop-ins or
a `managed-mcp.json` it did not install. `uninstall` removes the files the installed manifest
lists, plus any at donn's own paths that an interrupted install or an adoption counted as
owned.

**Enforced:** locked permission rules, hooks (the script is copied into the bundle), `http`/`sse`
MCP servers on `https://` (or any locked server with `policy.mcp: exclusive`), locked instruction
text (as `claudeMd`, guidance rather than system prompt), the `policy` block, and an allow-listed
set of `targets.claude-code.managed` keys. **Advisory only:** `mcp.gateway`, `skills`,
`knowledge`, `secrets.providers`, and a locked `gateway://` server (a server `policy.mcp:
exclusive` would stop sessions loading); they are enforced at publish and resolve, and the report
says so.

**Refused** (the build fails and writes nothing): a locked value that holds a `secret://`
reference (`managed-secret`; managed files are readable by every user), a locked stdio server or
one with `env` or headers without `policy.mcp: exclusive` (`managed-mcp-needs-exclusive`), an
unknown `targets.claude-code.managed` key (`managed-unknown-key`), and a passthrough key that
would replace a compiled value, sit under a compiled `managedMcpServers.<name>`, or widen a lock
or `policy` key set by a layer above it, such as a team adding `permissions.allow` rules under an
org's allow lock (`managed-passthrough-conflict`). Adding `deny` and `ask` rules is always allowed.

`managed build --out` refuses a policy folder, or a folder holding anything but a bundle. Our
drop-in is read after `managed-settings.json` and earlier drop-ins, so its single values replace
theirs; `install` lists each as `replaces <key> from <file>` and `check` notes it. After
installing, `install` runs `check` and says so when the policy is not in effect (`ignored`,
`overridden`). Under `policy.bypassPermissions: disabled`, `claude --dangerously-skip-permissions`
is dropped, not refused: interactive sessions say "Bypass permissions mode was disabled by
settings".

Claude Code uses only the highest-ranked managed source. If your organisation also delivers
settings through MDM or the claude.ai console, set `managedSourcesBehavior: "merge"` there, or the
files are ignored; `check` reports `ignored` when it sees a higher source without it. The manifest
records `minClaudeCode`, the oldest Claude Code that understands every key in the bundle.
`check` never goes to the network: with a registry configured, `stale` compares with the layers
last pulled (run `donn pull` first for the latest).
`check` run under `sudo`, or by an MDM, reads root's `~/.claude/remote-settings.json`, not the
developer's. `doctor` and `status` show the result. The design is
`docs/planning/21-managed-settings.md`.

## Agents

A project persona can declare agents (`agents.define.<name>`: a template, a target, optionally a
path, a world and env) that run on the persona: its instructions, skills, MCP connections and
model routing through the org's gateway. donn materialises the template, writes its own files
beside it and drives the agent's own eve (pinned in its `package.json`) without prompts. eve is
the first agent framework.

```sh
donn agent create pr-bot --template eve:blank --target local   # declares it if the persona does not
donn agent list                  # state: available, created, running, built, deployed; current or stale
donn agent sync pr-bot           # recompile the persona into donn's files (--dry-run, --force)
donn agent run pr-bot            # eve build + eve start, through the daemon when it runs (--dev: eve dev)
donn agent logs pr-bot --follow  # the daemon run's log
donn agent stop pr-bot
donn agent env pr-bot            # names and secret refs; --resolve prints values, --format dotenv|json
donn agent exec pr-bot -- <cmd>  # a command in the agent's folder with its env resolved
donn agent build pr-bot          # self-host: eve build, deploy/donn/Dockerfile and env.json
donn agent deploy pr-bot         # vercel: eve link, env push after confirming, eve deploy
donn agent add pr-bot channel/github   # eve add, its questions asked (or --answer key=<JSON>)
donn agent templates             # the templates create takes, with their Vercel-only services
```

Every subcommand takes `--json` and `--project <dir>`.

**`create`.** The template is `eve:<slug>` (fetched from the eve repository at the tag the adapter
was verified against, its commit and digest checked), `eve:blank` (`eve init`), or a path to a
local folder. `create` prints the compile and portability reports and stops on a blocking entry
(a service the template needs that the target does not have) unless `--accept-portability`. It
edits `agent/agent.ts` once to spread `donn`; after that `agent.ts` is yours, and donn's files
(under `agent/lib/donn/`, plus `agent/channels/eve.ts` when the template has no route auth) are
recorded in `.donn/agent.json`. `sync` rewrites them and stops on one you edited
(`owned-file-edited`; `--force` overwrites). With the daemon running, a persona edit syncs every
created agent it reaches and restarts a running one; without it, `build` and `deploy` refuse an
agent whose donn files are older than its persona (`agent-stale`: `donn agent sync` first), and a
foreground `run` warns. Secret values never go in the agent's
files: `create`, `sync` and `build` write `secret://` refs and env names only.

**`add`.** `donn agent add <name> <item>` runs the agent's own `eve add <item> --non-interactive`.
eve's setup questions are asked on a terminal; elsewhere (and with `--json`) `add` exits 2 with
the question and the command that continues it, `--answer key=<JSON>` added. A secret question is
never answered on a command line: donn names the variable eve reads, to set before running it
again. eve's `eve link` prerequisite is run for a vercel agent and shown as a step for the others.

**`local`** is for trying and developing an agent. `run` builds it and starts `eve start` on
`127.0.0.1` with a free port, `NODE_ENV=production`, secrets resolved into its environment and a
route token generated per run: send it as `Authorization: Bearer <token>` (`run --json` and
`GET /agents` on the daemon give it). Sessions open eve's Docker sandbox, so Docker must be
running. Without the daemon, `run` stays in the foreground until Ctrl-C. Through the daemon,
`run` resolves `secret://env/…` refs in your shell and sends them with the request (kept in the
daemon's memory for that run and its restarts, never logged); other providers resolve in the
daemon. A run started from `donn ui` has no shell, so it refuses `secret://env/…` refs: use the
keychain provider. A changed export does not reach a running agent: `donn agent stop`, then `run`.

eve names a sandbox container per session (`eve-sbx-…`). When the server shuts down it stops
them and keeps them, to start one again when its session resumes, and it removes one when its
session ends. `stop` reports how many are still running (none, normally) and how many stopped
ones are kept; `docker ps -a --filter name=eve-sbx-` lists them, and `docker rm <name>` removes
one whose session you no longer need. A self-host container stopped with `docker stop` shuts down
the same way; one removed with `docker rm -f` (SIGKILL) leaves its sandboxes running on the
host's Docker.

**`self-host`** produces what your infrastructure runs; donn does not operate it. `build` runs
`eve build` on this host, against the Docker daemon the agent will run on (eve prepares the
sandbox template image there, at build time), and writes `deploy/donn/Dockerfile` and
`deploy/donn/env.json`. Two images to ship:

- the agent's: `docker build -f deploy/donn/Dockerfile -t <name> .` in the agent folder;
- the sandbox template image `build` names (also `sandboxImage` in `env.json`), which must reach
  the run-time Docker daemon under the same tag (`docker save | docker load`, or a registry).

`env.json` lists each variable with its source (a `secret://` ref, a plain value, or set at run
time, such as `DONN_ROUTE_TOKEN`) and why it is needed, never a secret's value, plus what the
container needs: the Docker socket mount (`/var/run/docker.sock`, for the sandbox), a volume on
`/agent/.eve`, and the proxy rule (forward both `/eve/` and `/.well-known/workflow/`). By default
the agent uses eve's local Workflow world: state in that volume, one replica. `world: postgres`
on the agent selects `@workflow/world-postgres`; the image creates its schema before the server
starts, and `WORKFLOW_POSTGRES_URL` (or `DATABASE_URL`) must be set. Run the image with `docker
run --init` (or tini as its entrypoint), so SIGTERM reaches the server:

```sh
docker run --init -p 3000:3000 -v /var/run/docker.sock:/var/run/docker.sock \
  -v pr-bot-eve:/agent/.eve -e DONN_ROUTE_TOKEN -e DONN_SECRET_1 pr-bot
```

The values come from your own secret store (names and refs from `env.json`), or from `donn agent
env <name> --resolve`. A third path, documented here and not generated: when a secret provider the
persona names (Vault, say) is reachable from the container, the image can resolve at start itself.
Install `@getdonn/cli` in it, include the project's `.donn/`, the personas it extends and the
agent folder, and make the entrypoint `donn agent exec <name> -- node .output/server/index.mjs`.
`exec` resolves the persona's secrets only: it does not supply `DONN_ROUTE_TOKEN` (or
`WORKFLOW_POSTGRES_URL`), which you still pass to the container yourself. The route token is a
starting point: put Basic, JWT or OIDC in front before exposing the routes.

**`vercel`** uses eve's deploy. `create` adds the Vercel CLI as a pinned dev dependency.
`deploy` links the folder when it is not linked, lists the variable names it will set in Vercel
production (never values) and asks (always on a first deploy; `--yes` for scripts), sets each with
the value on stdin, then runs `eve deploy`. A variable Vercel already has is kept. `run` refuses a
`vercel` agent (its routes take Vercel's OIDC); `run --dev` works.

**`exec`** forwards SIGTERM, SIGINT and SIGHUP to its child, but the child gets no stdin or
terminal and its output is passed on line by line: it is meant for entrypoints and scripts, not
for interactive programs. A secret that does not resolve stops `run`, `exec` and `deploy`, naming
the variable and its ref.

`donn status` adds a line per created agent, and `donn doctor` checks each one: the pinned eve
inside the range this donn compiles for, Docker reachable (`local`, `self-host`), the gateway
answering, `agent.ts` still spreading `donn`, donn's files present, the Vercel CLI (`vercel`),
and agents the persona no longer declares. The design is `docs/planning/25-agent-runner.md`.

## Upgrading from zzpersona

donn was called zzpersona until 2026-10-23. On a machine that ran zzpersona, run `donn migrate`
once. It prints its plan, asks (or `--yes`), and every step is safe to repeat, so a re-run after
an interruption finishes the job. In order, it:

1. stops and removes the old background service;
2. removes the old Claude Code mod (before the home moves, because Claude Code reads the old mod
   from the old home);
3. moves `~/.zzpersona` to `~/.donn` (or `DONN_HOME`);
4. drops state that is made again (`build/`, `sessions/`, daemon sockets);
5. rewrites `apiVersion: zzpersona/v0` to `donn/v0` in your persona files, and updates the paths
   in `config.yaml`;
6. points the `switch` choices in `state.json` at each project's `.donn/` folder;
7. moves the registry login (the keychain item) to its new name;
8. installs the new mod, then installs and starts the new background service if the old one was
   installed.

It runs `donn doctor` at the end, unless every step was already done (this holds for
`--project` too). Exit codes: 0 when the migration succeeded, even if `doctor`
reports findings (read them). It exits 1 when a step is left pending (for example a locked
keychain): the output and the `--json` `pending` list name it, and a re-run finishes it. Declining
the prompt exits 1, and so does a refusal or a failed step (any non-zero).

It refuses, before changing anything, when:

- `donn` is not on `PATH`, but only if the old background service was installed (the new one
  has to be started);
- `claude` is not on `PATH`, but only while the old mod is installed or being swapped;
- the mod has not been built;
- `ZZPERSONA_HOME` points at another home (in your environment or the old service file);
- `DONN_HOME` sits inside the old home;
- the target (`~/.donn`) already exists and is not empty. When it holds only what donn makes
  itself (donn ran before the migration: its daemon, sessions, builds, the donn mod), it says so
  and what to remove; it never removes it for you. When it holds only what `donn init` and
  `donn login` wrote (a `config.yaml` with `personas` and/or `registry`, a `registry-token`),
  the refusal names those files and their values, and so does `donn doctor`: remove `~/.donn`,
  run `donn migrate` (it moves the old home's settings), then `donn login <url>` again if you had
  signed in. A
  `ZZPERSONA_HOME=~/.zzpersona` that was never expanded (a launchd plist, an env file) counts as
  the default old home.

`donn doctor` reports an old home that has not been migrated before anything else. It also lists
projects whose switch is saved but whose `.zzpersona/` is still there ("not migrated yet"), with
the `donn migrate --project` command for each; `--fix` never removes their switches. Beyond the
steps above, `migrate` reports what it leaves to you, and has two other forms:

- Projects with a saved `switch` whose `.zzpersona/` is still there are listed, each with its
  `donn migrate --project <dir>` command; the switch applies again once the project has moved.
- Values in persona files, `overrides.yaml` or `config.yaml` that still name `~/.zzpersona` (an
  instruction `file:`, a hook's `run:`, a skill's `source`) are listed by file and field, not
  changed.
- `donn migrate --project [dir]` moves a project's `.zzpersona/` to `.donn/` (with `git mv` when
  tracked), its persona's `apiVersion`, and the `AGENTS.md` markers. It never commits. Lines
  in `.gitignore` that name `.zzpersona` are reported, not changed.
- An old machine-wide managed policy is reported, not changed. `sudo donn migrate --managed`
  removes exactly the files the old policy installed; then `donn managed build` and
  `sudo donn managed install donn-managed` put it back under the new name.
- Any set `ZZPERSONA_*` or `ZZP_*` environment variables are named in the output; rename them in your
  shell profile.
- The old CLI is not removed for you. Remove it when `migrate` says so:
  `npm uninstall --global @zzpersona/cli` (or `pnpm remove --global @zzpersona/cli`).
  `pnpm remove --global` can leave a dangling `zzpersona` shim in pnpm's global bin folder (the
  one `pnpm bin --global` prints: `~/Library/pnpm/bin` with pnpm 12 on macOS, `~/Library/pnpm`
  with older pnpm, `~/.local/share/pnpm` on Linux). Deleting that file is safe.

## What each harness can carry

`donn capabilities` shows, per harness, which persona fields are carried natively,
approximated, advisory or not at all, and why. The same matrix is published in
[`docs/capabilities.md`](docs/capabilities.md).

## Two Claude Code installs?

`donn claude` runs the `claude` that `PATH` finds, which may not be the one your shell's
`claude` alias runs. `donn doctor` names the binary it checked.

## Contributing

Working on donn itself: run it from a checkout. This needs pnpm (it downloads the Node version
the repo develops on).

```sh
pnpm install
pnpm build

# Put `donn` on PATH. pnpm 12 keeps global binaries in ~/Library/pnpm/bin (macOS);
# `pnpm setup` adds that to your shell config. If it reports an existing pnpm section from an
# older pnpm, run `pnpm setup --force`. Then open a new shell.
pnpm setup
pnpm add --global "link:$PWD/src/apps/cli"   # a link: later builds take effect without reinstalling
```

```sh
pnpm turbo run build check-types lint test
pnpm format:check
DONN_E2E=1 pnpm --filter @getdonn/cli exec vitest run src/e2e.test.ts   # real claude, opt-in
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the DCO, the gitflow and the release checklist.
Conventions are in `CLAUDE.md`.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
