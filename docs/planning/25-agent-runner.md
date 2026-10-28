# 25 — `donn agent`: create, run, build and deploy project agents

> Status: design, 2026-10-24. Track "agents and the GUI", third spec. Builds on `23` (the
> `agents` and `models` fields, the eve facts), `24` (the compile, the manifest, the portability
> report), `06` (secrets, the plan executor), `14`–`16` (the daemon) and `07` (`doctor`). The GUI
> (`26`) calls every operation here through the daemon. Built as a `gh stack` after `24`.
> *Amended 2026-10-24:* personal and private control-plane details removed before the repository went public (spec 27).
> *Amended 2026-10-25:* eve 0.83.2 facts in §2 (template sources, `eve init`), §4 (sandbox,
> checkout) and §6 (`--answer`, `--yes`); see `24`'s "Re-check 2026-10-25".
> *Amended 2026-10-25 (build of `24`):* obligations the adapter leaves to the CLI, found while
> building it and running real eve 0.83.2 (details in `24`'s build notes and
> `spikes/eve-slots/FINDINGS.md`):
> - **Skill texts.** `create` and `sync` supply `texts` for every file of each local skill
>   directory (keys `<source>/<file>`); a skill without `<source>/SKILL.md` makes the compile
>   throw `AdapterInputError`.
> - **The manifest.** `manifestFiles(files, hash)` takes the compile's whole `files` map and
>   leaves `COPY_PENDING` for each `copyFrom` entry; the CLI copies the directory, then replaces
>   the entry with one hash per copied file. `isKnownTemplate` is not exported: callers learn of
>   an unknown template from the compile's `portability-unknown` entry.
> - **Dependencies.** Besides eve, `create` adds `ai@^7.0.152` and the gateway's AI SDK package
>   (`@ai-sdk/openai-compatible@^3` or `@ai-sdk/anthropic@^4`) to the agent's `package.json`
>   (plus `@workflow/world-postgres` for `self-host`, whose connection variable is
>   `WORKFLOW_POSTGRES_URL`, falling back to `DATABASE_URL`).
> - **`pnpm add` and `install`** can exit non-zero with `ERR_PNPM_IGNORED_BUILDS` (`cbor-extract`)
>   after the install completed; treat that code as success when the dependencies are in place.
> - **Docker.** A pinned Docker `sandbox.ts` (self-host) makes `eve build` fail on a host without
>   a Docker daemon; `eve build --skip-sandbox-prewarm` avoids it.
> - **tsconfig.** A template's `tsconfig.json` may need `skipLibCheck: true` for the agent to
>   type-check with the AI SDK packages; `create` checks and says so rather than editing it.
> - **Running (unverified in production).** Session routes answer 401 under `eve start`. The e2e
>   proves the model route only under `eve dev --no-ui` with `NODE_ENV=development` (under
>   vitest's `NODE_ENV=test` the session never reached the gateway). The production path, `eve
>   build` plus a production run, which `donn agent run` and `deploy` use, is NOT verified: it is
>   an open question and a required check in this spec's spike (a turn through the gateway with
>   the configured key and headers). `donn agent run` must not inherit a test `NODE_ENV`; it sets
>   its own.
> *Amended 2026-10-25 (layer 1 spike, `spikes/eve-runner/FINDINGS.md`):* the production path
> works (`eve build`, then `eve start`; one turn reached a stub gateway with the configured key
> and headers, also from a container). What changed, each marked in place:
> - **Route auth for `local` is donn's** (§4). eve fails closed under `eve start`, and
>   `localDev()` opens only under `eve dev`; the adapter writes a donn-owned `agent/channels/eve.ts`
>   accepting a bearer `DONN_ROUTE_TOKEN` (`24` §2).
> - **`run`'s child env** (§4): `NODE_ENV=production`, without `EVE_DEV`,
>   `EVE_MOCK_AUTHORED_MODELS` or `VITEST`; `--host 127.0.0.1 --port 0`, the URL read from eve's
>   `[START] server listening at <url>` line. Under `NODE_ENV=test` eve mocks the model, which
>   explains `24`'s e2e finding.
> - **`eve init` edits the nearest ancestor pnpm workspace** and has no flag against it (§2 step
>   4); installing with `--ignore-workspace` loses the template's own pnpm settings (§2 step 5).
> - **The self-host image copies a host-built `.output/`** (§4): eve prepares the Docker sandbox's
>   template image at build time on the daemon it can reach and never in production.
> - **The self-host world defaults to eve's local world**, Postgres is opt-in (`23` §2's new
>   `world` field; decided by the maintainer).
> - **The question protocol moves to `26`** (§2 step 8, §6): only `eve add` asks questions, and no
>   template declares a setup step (decided by the maintainer).
> - Template digests (open question 1) and the GitHub Actions answer (§4: yes, with glue) are in
>   the findings.
> *Amended 2026-10-27 (kody smoke):* `eve build` gets the agent's plain env values (§5); a
> template that reads one at module load (kody's `RESEND_FROM_ADDRESS`) failed to build without
> them.

## Intent

Give every step from "this repo should have a PR reviewer" to a running agent one command, with
`--json`, so the CLI, CI scripts and the GUI share one path. donn materialises the template,
writes its own files, resolves secrets into the agent's environment, and drives the project-local
eve CLI non-interactively. Three targets are first-class: `local` (the daemon runs the agent on
this machine), `self-host` (a Node server and a container image the user operates) and `vercel`
(eve's own deploy). Nothing here is needed by a user who never creates an agent.

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| One command group, `donn agent`, each subcommand with `--json` and a daemon operation | GUI-only flows; a separate binary | CLI parity (`03`); scripts and CI need the same steps |
| donn drives the **project-local** eve, pinned in the agent's `package.json` | A global eve; `npx eve@latest` | eve is beta; an agent must build the same way next month |
| Templates are fetched from the eve repository at the tag of the pinned version | `eve init` then copy files over; templates vendored into donn | `eve init` has no template flag; vendoring would freeze templates at donn's release |
| donn never writes secret values into the user's infrastructure; it resolves them into a process, or prints them only when asked | Write `.env` files on create; push to any secret store it can reach | Secrets on disk and in third-party stores are the user's decision, as everywhere else in donn |
| eve's "needs an answer" (exit 2) becomes a question the caller answers (*2026-10-25:* built in `26`, §6) | Treat it as a failure; always pass `--yes` | The GUI renders it as a form field; `--yes` would accept defaults the user never saw |
| A GitHub Actions target is a spike, not a commitment | Promise it now; leave it out | It may be the cheapest way to run a PR reviewer with no hosting, but eve's support for a one-shot turn is unverified |

## 1. Commands

| Command | Does |
|---|---|
| `donn agent list` | Agents in the resolved project persona: name, template, target, state (`available`, `created`, `running`, `built`, `deployed`), and whether the persona changed since the last sync |
| `donn agent create <name> [--template <t>] [--target <t>] [--path <p>] [--dry-run]` | §2 (*2026-10-25:* `--answer` moved to `26`'s `donn agent add`) |
| `donn agent sync <name> [--force] [--dry-run]` | Recompiles (`24`) and rewrites donn's files, by the manifest's rules |
| `donn agent run <name> [--dev]` | `local`: §4 |
| `donn agent stop <name>` | Stops a local run |
| `donn agent build <name>` | `self-host`: §4 |
| `donn agent deploy <name> [--yes] [--dry-run]` | `vercel`: §4 (`--dry-run` added 2026-10-25 for the GUI, `26` §2) |
| `donn agent env <name> [--resolve] [--format dotenv\|json]` | The env the agent needs: names and refs, or with `--resolve` the values (§5) |
| `donn agent exec <name> -- <command>…` | Runs a command with the agent's env resolved (§5) |
| `donn agent logs <name> [--follow]` | A local run's log; with `--follow`, eve's session events as they arrive |

- All accept `--json`. A command that needs a TTY answer and has none fails with the question in
  its JSON (§6) instead of hanging.
- The project is the current directory's, as for `donn write`; `--project <dir>` overrides it.

## 2. `create`

1. **Declare if needed.** When `<name>` is not in the resolved persona's `agents.define`,
   `--template` and `--target` are required, and donn adds `agents.define.<name>` to the project
   persona (`.donn/persona.yaml`) with a comment-preserving edit (`yaml`'s Document API). This is
   the one place donn writes to a persona file; `--dry-run` shows the edit. A locked
   `agents.define` refuses, naming the layer.
2. **Resolve and report.** Resolve the persona, compile the agent (`24`), print the compile
   report and the portability report. A blocking portability entry stops here unless
   `--accept-portability` is given: the agent would be created but could not run at its target.
3. **Pin eve.** Choose the newest published eve inside the adapter's `frameworkRange` (`npm view
   eve versions`); `--eve <version>` overrides it within the range.
4. **Materialise the template** into `path`, which must not exist or must be empty:
   - `eve:<slug>`: download the eve repository's tarball at the tag for the pinned version and
     extract `apps/templates/<slug>`. Without a tag for that version, refuse
     (`template-not-at-version`, naming the nearest tagged versions).
     *Amended 2026-10-25:* the tags are `eve@<version>` (`eve@0.83.2` exists). The directory is
     the template's `repoPath` (`24` §1), which can differ from its gallery slug. Only eight
     templates are in the repository; a gallery slug without a `repoPath` (`kody-eve-template`,
     the GitHub Project Maintainer, among them) is refused (`template-not-in-repo`, naming the
     template's own repository) until `24`'s open question 3 is settled, and can be created
     meanwhile from a local clone as a path template.
   - `eve:blank`: write a minimal `package.json`, then run `eve init <path> --non-interactive`,
     which adds `agent/` to an existing package and does not run `git init`.
     *Amended 2026-10-25:* in eve 0.83 that form requires the `package.json` and no `agent/`
     files, adds the missing `eve`, `ai` and `zod` dependencies and always installs; step 5 then
     re-pins `eve` and installs again. donn always passes `<path>`: a new directory in
     non-interactive mode needs an explicit name, and donn never asks eve to create one.
   - a path template: copy it.
   - Never a nested Git repository: a `.git` in the result is removed before anything else.
   *Amended 2026-10-25 (spike):*
   - **Fetch:** `https://codeload.github.com/vercel/eve/tar.gz/refs/tags/eve@<version>`, read
     with `node:zlib` and a small ustar/pax reader in the CLI (no new dependency) that extracts
     only `<top>/apps/templates/<repoPath>/`, refuses `..`, absolute paths and any entry but a
     file or directory, and checks the pax header's commit against the tag. Tags are listed with
     `git ls-remote --tags https://github.com/vercel/eve 'refs/tags/eve@<major.minor>.*'`.
   - **Digest:** while extracting, before anything is written to `path`, donn hashes the
     template (regular files only, POSIX paths, lines `<path>\0<644|755>\0<sha256>\n` sorted
     by code unit, `sha256-<hex>` of the lines) and refuses `template-digest-mismatch` against
     the templates table. Path templates have no digest. _(2026-10-25)_ Templates are fetched at
     the tag the table's digests were computed at (`TEMPLATES_AT`), while `eve` itself is pinned
     to the newest version in the range (step 3); moving `TEMPLATES_AT` means recomputing the
     digests.
   - **`eve:blank`:** `eve init` walks up to the nearest ancestor `pnpm-workspace.yaml` and edits
     it (root `package.json` engines, workspace globs, the root lockfile). donn runs it in a
     fresh temporary staging directory with no workspace file above it and moves the result into
     `path`. _(2026-10-25)_ For `local` and `self-host`, donn drops the `agent/channels/eve.ts`
     that `eve init` scaffolds (eve's boilerplate, not an author's route auth) before compiling,
     so donn writes its own channel; `vercel` keeps eve's file.
5. **Pin and add dependencies.** Set `eve` to the exact pinned version in the agent's
   `package.json` and add the provider packages `24` needs, pinned. Install with the package
   manager the template's lockfile names, isolated from any workspace at the project root (for
   pnpm, `--ignore-workspace`). The agent directory is its own package; joining the project's
   workspace is the user's choice.
   *Amended 2026-10-25 (spike):* the package manager is the one `packageManager` names (every
   eve template uses pnpm, each with its own `pnpm-workspace.yaml`). `--ignore-workspace` makes
   pnpm drop that file's `minimumReleaseAgeExclude`, and pnpm 11+ refuses packages younger than a
   day by default, so donn instead installs in place: pnpm finds the agent's own workspace file
   first (donn writes `packages: ["."]` when a template has none). donn adds `cbor-extract: false`
   under `allowBuilds` (the build script `@workflow/*` pulls in; otherwise pnpm exits
   `ERR_PNPM_IGNORED_BUILDS` on every install) and the pinned eve to `minimumReleaseAgeExclude`,
   recording both in the manifest as edits to a template-owned file. The first install is not
   frozen: the re-pin makes the template's lockfile stale.
6. **Edit `agent.ts`** once (`24` §2) and write donn's files and the manifest.
7. **Ignore what must not be committed:** `.env*`, `.output/`, `.vercel/`, `node_modules/` and
   (*2026-10-25*) `.eve/`, eve's build and local-world state, in
   the agent's `.gitignore` (added to the template's, never replacing it).
8. **Run eve's own setup** for the template, if it has any, with `eve add … --non-interactive`
   and the questions handled as in §6.
   *Removed 2026-10-25 (spike, maintainer's decision):* no template at eve 0.83.2 declares a
   setup step (eve's registry has channels, connections, tools and the like, not templates), so
   there is nothing to run. Adding eve registry items, with the question protocol, moves to `26`
   (`donn agent add`).

A failure after step 4 leaves the directory for inspection and says so; `donn agent create
--force` removes a partial directory that has a manifest marking it incomplete, and nothing else.

## 3. `sync` and the daemon

- `donn agent sync <name>` recompiles and rewrites donn's files (`24` §4).
- **The daemon keeps created agents current.** It watches the persona sources of every project
  with a created agent, as it watches them for live sessions (spec 14), and syncs on a change.
  A sync that stops (`owned-file-edited`) becomes an `agent.sync-failed` event and a `donn
  status` line; it is never forced. A running local agent is restarted after a sync.
- An agent whose template, target or path changed in the persona is not synced: `donn agent
  list` marks it `recreate needed`, because those decide files donn does not own.
- *Amended 2026-10-25 (final review):* without the daemon nothing syncs on an edit, so `build`
  and `deploy` compare the compile with the manifest's files under the agent's lock and refuse a
  stale agent (`agent-stale`, fix `donn agent sync <name>`) rather than ship old donn files; a
  foreground `run` warns and runs.

## 4. Targets

**`local`** is for trying an agent and developing it, not for serving webhooks: GitHub cannot
reach `localhost`.

- `donn agent run <name>` builds (`eve build`) and starts (`eve start --port <free port>`) the
  agent as a child of the daemon, with its env resolved (§5). The local Workflow world and a
  Docker sandbox apply. `donn status` and `GET /agents` list it with its port; its log is
  `~/.donn/agents/<project-hash>/<name>.log`, capped and rotated as the daemon's own.
- `--dev` runs `eve dev` in the foreground instead, with eve's terminal UI, for authoring. It
  does not go through the daemon.
- *Amended 2026-10-25 (spike):* the child's env is the resolved env (§5) plus
  `NODE_ENV=production` and a `DONN_ROUTE_TOKEN` the daemon generates per run and keeps in memory
  (the GUI, `logs` and `GET /agents` callers on the socket use it); `EVE_DEV`,
  `EVE_MOCK_AUTHORED_MODELS`, `VITEST` and `NODE_ENV=test` never reach it, because eve then
  mocks the model or turns on development behaviour in a dozen modules. The command is `eve start
  --host 127.0.0.1 --port 0` (eve's default host is `0.0.0.0`); the URL comes from its `[START]
  server listening at <url>` line. Route auth: eve fails closed under `eve start` and its
  `localDev()` opens only under `eve dev`, so the adapter writes a donn-owned
  `agent/channels/eve.ts` for `local` and `self-host` when the template has none (a bearer check
  of `DONN_ROUTE_TOKEN`, read per request, then `localDev()`; `24` §2). A template with its own
  `channels/eve.ts` gets the lines to add by hand in the portability report. `stop` signals the
  server process, not the `pnpm exec` parent (which leaves `eve-sbx-*` sandbox containers
  running), and reports any of the agent's sandbox containers still up afterwards.
- Without the daemon, `run` starts the agent in the foreground and stops it on exit.

**`self-host`** produces what the user's infrastructure runs; donn does not operate it.

- `donn agent build <name>` runs `eve build` (writing `.output/`) and writes, as donn-owned files,
  `deploy/donn/Dockerfile` (a Node 26 image running the built server, the start command checked
  against eve's self-hosting guide in layer 1) and `deploy/donn/env.json`, the env manifest: each
  name with its source (`secret://` ref or plain value) and why it is needed (persona secret,
  gateway key, template variable, Workflow world database, route auth).
- The image needs a Docker daemon for the sandbox at run time (a mounted socket or a
  Docker-in-Docker sidecar); the report says so, and `24` selects the Docker sandbox explicitly
  because the build cannot detect one.
  *Amended 2026-10-25:* eve 0.83's default sandbox does detect Docker, but at build time, and
  records the result in the build; `24`'s `sandbox.ts` pins Docker so an image built on a host
  without a daemon still runs on Docker. The GitHub channel's checkout is Vercel-only, so a
  self-hosted PR reviewer sees the diff but not the repository's files (`24` §5).
- *Amended 2026-10-25 (spike):* `RUN eve build` inside a Dockerfile cannot work for an agent that
  opens its sandbox: eve prepares the Docker sandbox's template image during `eve build`, on the
  daemon it reaches, and never in production (`--skip-sandbox-prewarm` builds, then every
  sandboxed session fails). So `donn agent build` runs `eve build` on the host, against the
  Docker daemon the agent will run on, and the generated `Dockerfile` copies the built `.output/`
  plus the `docker` CLI binary (eve's Docker sandbox shells out to it) and runs `node
  .output/server/index.mjs`. The deliverable is two images: the agent's, and the sandbox template
  image named in `.output/.eve/compile/sandbox-prepared-artifacts.json`, which must reach the
  run-time daemon under the same tag; the report names it. `env.json` adds the socket mount
  (`/var/run/docker.sock`) and the proxy rule (forward `/eve/` and `/.well-known/workflow/`).
- *Amended 2026-10-25 (maintainer's decision):* the world is eve's local world by default (state
  under `.eve/`, one replica, a volume on `/agent/.eve`); `world: postgres` (`23` §2) selects
  `@workflow/world-postgres`, whose schema the image's entrypoint creates (`bootstrap`, from the
  package) before the server starts, with `WORKFLOW_POSTGRES_URL` in `env.json`.
- Route auth is the user's: the portability report names Basic, JWT or OIDC. Once the identity work
  (spec 20 and the control plane) has an issuer the agent can trust, a later spec can generate it.

**`vercel`** uses eve's deploy.

- `donn agent deploy <name>` runs `eve link --non-interactive --project <name>` when the
  directory is not linked, then `eve deploy --non-interactive --yes`.
  *Amended 2026-10-25 (spike):* both need the Vercel CLI (`eve link` exits 1 with "Vercel CLI not
  found" otherwise); `create --target vercel` adds `vercel` as a pinned dev dependency of the
  agent, and `doctor` checks it.
- Before the first deploy, and whenever the env manifest gains a name, it lists the variable
  names (never values) it will set with `vercel env add <name> production`, value on stdin, and
  asks to confirm; `--yes` confirms for scripts. This is outward-facing, so it is never implicit.

**`github-actions`** (spike, not built): run one agent turn in a workflow job triggered by
`pull_request`, with the runner as the sandbox and the repository already checked out, so a PR
reviewer needs no hosting at all. The spike answers: can eve run a single turn from the command
line against a GitHub event payload and exit, with the GitHub channel's checkout and reply logic
or an equivalent? If yes, a later spec adds the target and a generated workflow file; if no, the
finding goes to `FINDINGS.md` and nothing is promised.
*Answered 2026-10-25 (spike): yes, with glue.* `eve remote invoke --url <local> "<prompt>"` runs
one turn against a running agent and exits with JSON (proved under `eve dev`). The glue: build
and start the agent in the job, with a just-bash sandbox mounting the runner's checkout read-only
(Docker cannot run the GitHub channel's checkout), invoke, then post with `gh pr comment`; the
GitHub channel's credentials accept an installation token, so `GITHUB_TOKEN` fits. Not proved: a
real Actions run. A later spec adds the target; nothing in layers 2–4 depends on it.

## 5. Secrets

The agent's env has three sources: the compile's `secretEnv` (persona secrets, gateway key and
headers), the agent's `env` (plain values and secret refs), and what the target adds (the
Workflow world's database variable for `self-host`).

- **`local`:** the daemon resolves refs through the secret providers (spec 08) just before it
  starts the agent, and passes them as the child's env. Nothing is written to disk.
  *Amended 2026-10-25 (final review):* it resolves them in its own environment; a daemon
  installed as a service (spec 16) has none of the user's shell exports, so an unresolved
  `secret://env/…` ref's `fix` names that cause (use the keychain provider, or run with the
  daemon stopped). A note in `14` records the change to its "never resolves secrets" row.
  *Amended 2026-10-25 (`26` §2, "Env secrets"):* a terminal `donn agent run` resolves the
  agent's env-provider refs in its own shell and sends them in `POST /agents/run`'s `env`; the
  daemon uses them for that run and its restarts after a sync, in memory only, and resolves every
  other ref itself. A run started from `donn ui` sends none, so an env-provider ref fails with a
  fix naming the keychain provider. A changed export does not restart a running agent: `donn
  agent stop`, then `run`.
- **`self-host`:** two supported paths, both shown in `env.json`:
  - the container resolves at start: the image's entrypoint is `donn agent exec <name> -- <start
    command>`, which works when a secret provider the persona names (for example Vault) is
    reachable from the container;
  - the user loads values into their own secret store, reading names and refs from `env.json`.
- **`vercel`:** values pushed with `vercel env add` after confirmation (§4).
- `donn agent env <name> --resolve` prints values, for the user to pipe where they choose. Without
  `--resolve` it prints names and refs only.
- A ref that cannot be resolved stops `run`, `exec` and `deploy`, naming the variable and the ref.
- *Amended 2026-10-27 (kody smoke):* `eve build` evaluates the agent's modules, and a template
  may read an env value at load (kody's `agent/instructions.ts` reads `RESEND_FROM_ADDRESS`).
  `run` (in the foreground and in the daemon) and `build` therefore run `eve build` with the
  agent's **plain** values, the entries `donn agent env` lists with `source: "plain"`; never a
  secret's value, never `DONN_ROUTE_TOKEN` or another run-time entry. A secret a module reads at
  load still fails the build: make it plain, or read it per request. `create` runs no `eve
  build` (only `eve init` for `eve:blank` and the install), so nothing changes there.

## 6. Driving the eve CLI

- Always the agent's own eve: the template's package manager's `exec` (`pnpm exec eve`, `npm
  exec eve`) in the agent directory, with `--non-interactive` where eve offers it.
- NDJSON events are parsed; progress events pass to `--json` callers and the GUI as they arrive.
- *Amended 2026-10-25 (spike, maintainer's decision):* only `eve add` and eve's registry commands
  emit NDJSON or exit 2; `build`, `start`, `init`, `link` and `deploy` print text and exit 0 or 1.
  Spec 25 therefore streams their output lines as progress and reports exit 1 with the last
  lines; the question protocol below, mapped onto eve's real wire format (`message`, `kind`,
  `options`, `recommended`, `required`, `environment` + `variable` for a secret, a second
  blocked status `prerequisite_required`, eve's `next.args` as the continuation, events on both
  stdout and stderr), moves to `26` with `donn agent add`. The recordings are in
  `spikes/eve-runner/`.
- **Exit 2** (setup needs an answer) becomes a question:

  ```json
  { "status": "needs-answer",
    "question": { "key": "github.app", "prompt": "…", "choices": ["…"], "secret": false },
    "continue": "donn agent create pr-reviewer --answer github.app=<value>" }
  ```

  On a TTY the CLI asks and continues; with `--json` it returns the question; the GUI shows a
  form field. donn's `--answer key=value` passes through to eve's `--answer`. A question eve marks
  as secret is never answered on a command line: donn names the env variable or secret ref to set
  instead, as eve's own rule requires.
  *Amended 2026-10-25:* eve's form is `--answer 'key=<JSON>'`, repeatable, so donn JSON-encodes
  a value that is not already JSON (a bare string becomes `"…"`). eve's `--yes` accepts its
  recommended answers; donn does not pass it to `eve add`, keeping the decision above that
  defaults are never accepted unseen.
  *Amended 2026-10-26 (real-eve check, maintainer's decision):* eve 0.83.2 takes an `--answer`
  for a secret question before its own environment rule, and donn can only tell a secret from a
  plain question once eve has asked it. So `--answer` is taken only for a key eve has asked that
  agent for that item before (recorded beside the agent's state; refused otherwise as
  `not-asked`, before eve runs), and the bridge's `/answer` only for the job's own question.
  Pre-answering a first run from a script is no longer possible; after one run it is.
- **Exit 1** shows eve's last event as is, with the command that failed.
- A prerequisite eve reports (`eve link`) is run by donn only for `vercel` targets; otherwise it
  is shown as a step for the user.

## 7. Daemon and `doctor`

- Daemon operations (spec 14's socket and the bridge in `26`): `GET /agents`, and the
  subcommands of §1 through the same in-process CLI the bridge uses. Events: `agent.created`,
  `agent.synced`, `agent.sync-failed`, `agent.started`, `agent.stopped`, `agent.failed`.
- `donn status` adds a line per created agent: target, state, and whether it is current with the
  persona.
- `donn doctor` adds, per created agent: the pinned eve inside the adapter's range; Docker
  reachable for `local` and `self-host`; the gateway's `baseURL` answering; `agent.ts` still
  spreading `donn` (`24` §2); the manifest's files present. Without created agents it adds
  nothing.

## 8. Stack and testing

| Layer | Contents |
|---|---|
| 1 `spikes` | `spikes/eve-runner/FINDINGS.md`: template tarballs at a tag, `eve init` into an existing package, `eve build`/`start` with a stub gateway, the self-host start command and Docker sandbox in a container, whether the GitHub channel skips its checkout on Docker (added 2026-10-25, `24` §5), the GitHub Actions one-shot question |
| 2 `create` | `list`, `create` (declare, report, pin, materialise, install, edit, write), `sync`; the persona edit; the question protocol (*2026-10-25:* moved to `26`) |
| 3 `run` | `run`, `stop`, `logs`, `env`, `exec`; daemon runs, events, `status`, restart on sync |
| 4 `ship` | `build` (Dockerfile, `env.json`), `deploy` (link, env push with confirmation); `doctor` lines; docs; changesets |

- **Unit:** each step of `create` against a temp project and a fake eve (a script that prints
  recorded NDJSON and exits 0, 1 or 2); the persona edit keeps comments; a nested `.git` is
  removed; a partial create is recoverable; `sync` with an edited owned file stops.
- **Questions:** exit 2 → TTY prompt, `--json` question, `--answer` continuation; a secret
  question is refused with the variable to set. *(Moved to `26` on 2026-10-25.)*
- **Secrets:** no value on disk after `run`; `env` without `--resolve` prints no value; an
  unresolvable ref stops each command with its name.
- **Real eve (`DONN_E2E=1`):** create from `eve:blank` and one GitHub template at the pinned
  version; `run` with a stub gateway; one HTTP-channel turn through the daemon-run agent; `build`
  and run the image in Docker with the stub gateway.
- **Smoke before the final review:** a PR reviewer on a scratch repository, self-hosted on the
  developer's machine behind a tunnel, reviewing one real pull request through a LiteLLM gateway.

## Non-goals

Operating the user's infrastructure (Kubernetes manifests, Helm, Terraform); the GitHub Actions
target beyond its spike; generating route auth; pushing secrets to stores other than Vercel's;
Windows (the daemon service is macOS and Linux today).

## Open questions

1. **Template provenance.** Tarballs come from the eve repository on GitHub at a tag. Should donn
   verify them beyond HTTPS (a checksum table per version in the adapter)? Lean: yes, the table
   that already lists each template's services can carry its digest.
   *Settled 2026-10-25:* yes. The adapter's templates table records a sha256 digest of each
   template directory at the pinned eve tag, and `create` refuses a mismatch
   (`template-digest-mismatch`). Moving the pin means recomputing the digests.
2. *Settled 2026-10-25 (`24`'s open question 3, as it touches this spec):* the PR reviewer the
   e2e and the smoke target, `kody-eve-template`, is outside eve's repository; spec 25 creates it
   from a local clone as a path template and does not fetch out-of-repo slugs. A donn-maintained
   PR-reviewer template is a later spec.
3. *Decided 2026-10-25:* the layer 1 spike runs before the implementation plan is written, so
   layers 2–4 are planned from its findings rather than from the unverified production path.

- 2026-10-25 (final review of 24, deferred here): a path template's Vercel services are unknown, so consider reporting `portability-unknown` for it as for an unknown slug; a template's own `experimental` or `modelContextWindowTokens` in `agent.ts` is replaced by the `...donn` spread (an advisory needs `agent.ts` knowledge); a `requiredEnv` output field would let `donn agent env` and `doctor` list the env a compile needs without parsing `env.ts`.
