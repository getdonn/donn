# 26 — The GUI: donn on the web and the desktop

> Status: design, 2026-10-24. Track "agents and the GUI", fourth spec; can start in parallel with
> `23`–`25`, since its non-agent screens need only today's daemon plus the bridge below. Revises
> the desktop decision in `00-handoff.md` (dated note there) and the desktop rows in `01` and `03`.
> Builds on `14`–`16` (the daemon, its socket and service), `15` (`POST /run`), `17` (the switch
> report), `13` (capabilities), `18`–`20` (registry and identity) and `25` (`donn agent`). Built as
> a `gh stack` of its own.
> *Amended 2026-10-24:* personal and private control-plane details removed before the repository went public (spec 27).
> *Amended 2026-10-25 (`25`'s spike, maintainer's decision):* `donn agent add <name> <item>
> [--answer key=<JSON>]…` and the question protocol (`25` §6) are built here, not in `25`, on
> eve's real wire format: question `message`, `kind` (`confirm`, `text`, `environment`,
> `select`, `multi-select`, `editable-select`), `options`, `recommended`, `required`; a secret is
> `kind: "environment"` with a `variable`; a second blocked status `prerequisite_required` (for
> example `eve link`); eve's `next.args` is the continuation; events arrive on stdout and stderr
> mixed with text. Recordings: `spikes/eve-runner/templates/fixtures/` and
> `spikes/eve-runner/runtime/recordings/`.
> *Amended 2026-10-25 (planning, maintainer's decisions):*
> - **Stack.** Vite 8 + React 19 + TypeScript; shadcn/ui on Tailwind CSS v4 (open question 2);
>   react-router for routes, TanStack Query for requests. Next.js's static export was the
>   alternative; nothing here server-renders.
> - **Desktop deferred.** Layers 1–3 (bridge, `donn ui`, the web app with every screen) are built
>   now; layer 4 (Tauri 2, tray, packaging) follows once the web app has been used and open
>   question 1 is decided. This machine has no Rust toolchain yet.
> - **Env secrets under the daemon** (left open by `25`'s final review): a terminal
>   `donn agent run` resolves `secret://env/…` refs itself and sends those values with the run
>   request over the user-only socket; a run started from the GUI has no shell, so it refuses
>   env-provider refs with the fix to use the keychain provider. Other providers resolve in the
>   daemon as before (§2, "Env secrets").
> - **Output schemas.** The CLI has no zod schemas for its `--json` output yet; a private
>   workspace package `@getdonn/cli-schemas` defines them, the CLI's tests validate real output
>   against them, and the app imports them (§4).
> - **Templates.** The builder lists templates through a new `donn agent templates --json` (the
>   adapter's table plus the `eve:blank` entry), so the app reads nothing outside the CLI.
> *Amended 2026-10-26:* layer 4 is designed in `28-desktop.md`: a menu-bar app that runs the
> installed `donn` for everything (`status --watch --json` feeds the tray). Open question 1 is
> decided there: built from source for v1; signed downloads are a later spec.

## Intent

Most people adopt a tool through a window, not a terminal. donn gets one app with two shells: a
local web app (`donn ui`) and a desktop app with a tray. It shows what the CLI knows (personas
and their layers, why a value is what it is, live sessions per harness, what each harness keeps
and drops, the registry) and does what the CLI does (switch, pull, publish, build agents). The
agent builder (`25`) is its first workflow that has no CLI equivalent a newcomer would find on
their own: pick a template, pick a persona, pick where it runs, read what will happen, create.

The GUI holds no logic of its own. Every action is a CLI operation served by the daemon, so
whatever the GUI does, `donn … --json` does too (the rule in `03`).

## The revised decision

`00-handoff.md` rejected "an Electron desktop app as a primary surface" in favour of a thin tray
client, later: "a third UI with no new user is cost without benefit". The maintainer revised it on
2026-10-24: a GUI is how a team adopts donn fully, beyond the one person who set it up, and the
agent builder gives it a workflow the CLI cannot make discoverable. What survives from the old
decision: no logic in the UI, the daemon is the only backend, Tauri over Electron.

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| One React app, two shells: the daemon serves it on loopback (`donn ui`); Tauri wraps it with a tray | Separate web and desktop codebases; Electron | One codebase; Tauri's footprint (`00`) |
| A loopback HTTP bridge in the daemon, routing to the same in-process CLI as `POST /run`, with its own allowlist | Typed endpoints written by hand; widening `/run`'s allowlist; the desktop shell only, over the unix socket | A browser cannot reach a unix socket; serving the CLI in process makes parity true by construction; `/run`'s allowlist exists so the mod cannot write files, and the mod must keep it |
| View, explain and act; edits open the user's editor | Forms for common fields; a full visual editor | The YAML stays the single source; comment-preserving round trips of every field are a large build for a v1 |
| One write exception: the agent builder adds `agents.define.<name>`, through `donn agent create` (`25` §2) | No writes at all | Otherwise the wizard stops halfway and sends the user to a YAML file |
| The private console shares components with this app only when it needs them | A shared UI kit package now | Nothing consumes it yet |

## 1. Shells

**`donn ui [--no-open] [--port <n>]`** starts the daemon if needed (as `donn claude` does, spec
16), asks it to open the bridge, and opens the browser at `http://127.0.0.1:<port>/#t=<one-time
code>`. The page exchanges the code for a session token held in memory (`sessionStorage`), and
the code stops working. No cookies.

**The desktop app** (`src/apps/desktop`, Tauri 2) starts or attaches to the daemon, reads the
bridge token from the daemon's directory on the Rust side, and loads the same app in its webview.
The tray menu shows the current persona per harness, a switcher, agents with their state, and
"Open donn". macOS and Linux first, as the daemon service is. Signing and notarisation are part
of its release work (Open questions).

## 2. The bridge

- **Where.** The daemon listens on `127.0.0.1` only, on a random free port, while a UI session is
  open (`donn ui`, or the desktop app connected); it closes the listener after ten minutes with no
  session. `daemon: { ui: false }` in donn's config disables it.
- **Authentication.** `Authorization: Bearer <ui token>` on every request, a token separate from
  the socket's `token` and rotated each time the bridge opens. Bearer tokens in a header, never
  cookies, so a cross-site page cannot make a request on the user's behalf.
- **DNS rebinding.** The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, and a
  present `Origin` must match it; anything else is `403`.
- **Routes.**

  | Route | Does |
  |---|---|
  | `GET /` and static assets | The app |
  | `POST /v1/run` | `{ argv, cwd }` → the CLI in process with `--json`; the same handler as `POST /run` (spec 15) with the UI allowlist below |
  | `POST /v1/jobs` | The same, for long operations (`agent create`, `build`, `deploy`, `pull`): returns a job id |
  | `GET /v1/events` | The daemon's server-sent events (spec 14) plus `job.progress`, `job.question`, `job.done` and the `agent.*` events of `25`; *(amended 2026-10-25, final review)* and last, before the bridge closes its streams for any reason, `ui.closing { reason: "idle" \| "daemon-stopping" }`, on which the app ends its session (it also ends after five failed reconnects) |
  | `POST /v1/jobs/<id>/answer` | Answers a `job.question` (`25` §6); *(amended 2026-10-26)* only under the key the job asked (`400 not-asked` otherwise). Answer values are `***` in the daemon log and a job's `argv`; its `stdout` and `question.continue` keep them, because the app starts the next job from that continuation (retry after a secret, continue after a prerequisite, an editable-select's second answer). A secret is never among them (`25` §6), and jobs live only in the daemon's memory (maintainer's decision) |
  | `POST /v1/open` | `{ path }` → the user's editor (`$VISUAL`, else the OS default; *amended 2026-10-25*, see below); the path must be inside a known personas root or the project |

- **The UI allowlist** (every form with `--json`): `list`, `switch` in the forms `/run` allows,
  `resolve` (with `--explain`), `compile` (*added 2026-10-25*, for the compile reports),
  `capabilities`, `diff`, `status`, `doctor`, `whoami`, `login`, `logout`, `pull`, `publish`,
  `write`, `managed build|check` and every `agent` subcommand. Never `daemon`, `mod install`,
  `managed install|uninstall` (they need `sudo`), `migrate`, `init`, `live` (it belongs to a harness
  session), or a harness launch (`claude`, `codex`).
- **Outward actions confirm in the UI.** `publish`, `agent deploy` and the env push it does are
  sent with the CLI's own confirmation flag only after a dialog that shows what the CLI would have
  prompted. The CLI is unchanged: it already prompts for these on a TTY.
  *(Amended 2026-10-25, layer 3 review:)* a deploy always confirms in the app, even when the CLI
  would not prompt (already linked, nothing new to set): the dialog comes from `donn agent deploy
  <name> --dry-run --json` (`linked`, `project`, the `names` it would set, `firstDeploy`), which
  links, sets, resolves and deploys nothing; confirming sends `deploy --yes` as a job.
- **Env secrets** *(added 2026-10-25)*. A run the bridge starts carries no caller environment:
  a `secret://env/…` ref fails `secret-unresolved` with a fix naming the keychain provider (and
  so does a deploy the bridge starts, *amended 2026-10-25*: its env push resolves no env-provider
  ref either). The
  socket's `POST /agents/run` accepts `{ env: { <ref>: <value> } }` from a terminal `donn agent
  run`, which resolves env-provider refs in its own environment first; the daemon uses those
  values for that run only and never logs or stores them.
- **`/v1/open`** *(amended 2026-10-25)*. `$VISUAL` (split on whitespace, the path last), else the
  OS opener; not `$EDITOR`: a terminal editor the daemon starts detached has no terminal. The OS
  opener must show, not run: on macOS `open -t` for a file (the default text editor, so never an
  `.app`, a `.command` or a `.webloc` launched) and `open -R` for a folder (revealed in Finder; an
  `.app` bundle is a folder); on Linux `xdg-open`, refused an executable file or a `.desktop`
  entry (`403 not-openable`, fix: set `$VISUAL`). The path is realpath'd and must lie inside the
  personas root, `<home>/personas`, a known project or a created agent's folder (`403
  outside-roots`).
- **`cwd`** must be a project the daemon knows (it has a session or a created agent there) or one
  the user picked in the app's project picker, which records it in `~/.donn/ui.json`.

## 3. Screens (v1)

1. **Projects and personas.** The project picker; the layer stack for the project's persona (org
   → area → team → project → user); the resolved persona; `explain` for any value (which layer set
   it, what it overrode, which lock protects it); "Open in editor" on every layer.
2. **Sessions and switching.** Live sessions per harness from the daemon; switch, with the
   per-harness switch report (spec 17): what each harness keeps and drops, sessions still on
   another persona, what `AGENTS.md` carries.
3. **Capabilities.** The matrix (spec 13) for installed harnesses, and each compile report for
   the current persona.
4. **Registry.** Sign in (spec 20's browser flow), who am I and my roles, pull, publish with its
   confirmation, layer versions.
5. **Agents.**
   - **List:** declared and created agents, state, target, current with the persona or not, and
     the sync failures `25` §3 records.
   - **Builder:** (a) template, from `adapter-eve`'s `templates()` with a "Vercel-only services"
     tag on each, or blank; (b) persona: the project's by default, with what the agent will
     receive (instructions, skills, MCP servers); (c) target: local, self-host or Vercel; (d)
     review: the compile report and the portability report from `donn agent create --dry-run`,
     blocking entries first, and the `agents.define` entry that will be added; (e) create, as a
     job, with eve's questions as form fields; secret questions show the variable to set instead.
     _(2026-10-25)_ `agent create` asks no eve questions (spec 25 §2 step 8 was removed); the
     questions come from `agent add`, on the agent page. The builder's last step says "Add channels
     or connections from the agent page". A dry run does not fetch the template, so a blocking
     entry from a template's own files shows only when create stops at it; the builder then
     lists it and asks for "Accept portability" before retrying with `--accept-portability`.
   - **Agent page:** run and stop (local), build (self-host: the Dockerfile and `env.json`, names
     and refs only), deploy (Vercel, with the env names it will push), logs and live session
     events, sync, open the agent directory in the editor.

## 4. Stack and testing

- `src/apps/ui`: Vite, React, TypeScript; a small typed client over `/v1/run` whose result types
  come from the CLI's `--json` output schemas (zod), so the app and the CLI cannot drift.
  *(2026-10-25)* The schemas live in the private package `@getdonn/cli-schemas` (a dev
  dependency of the CLI, whose tests parse real output with them, and a dependency of the app,
  which bundles them). The app's build is copied into the CLI's `dist/ui/` at build time, so the
  published `@getdonn/cli` serves it with no extra package.
- `src/apps/desktop`: Tauri 2; the shell only: daemon start or attach, token, tray, window.
- The bridge lives in the daemon (`src/apps/cli`, where the daemon runs today).

| Layer | Contents |
|---|---|
| 1 `bridge` | the loopback listener, the UI token and one-time code, Host/Origin checks, the UI allowlist, jobs and their events, `/v1/open`; `donn ui` |
| 2 `app` | `src/apps/ui`: shell, project picker, screens 1–4 |
| 3 `agents` | screen 5, after `25`'s layer 2 |
| 4 `desktop` | `src/apps/desktop`: Tauri shell, tray, packaging for macOS and Linux (*deferred 2026-10-25*) |

- **Bridge:** requests without the token, with a wrong `Host` or a foreign `Origin` are refused; a
  used one-time code fails; a command outside the allowlist is `403`; `/v1/open` outside a known
  root is refused; the listener closes when idle.
- **App:** Playwright against `donn ui` with a temporary home and fixture personas: each screen
  renders from real CLI output; switch shows the report; the builder against a fake eve (as in
  `25`) walks a question and creates an agent.
- **Desktop:** a smoke run before the final review: install, tray, switch, open the builder.

## Non-goals

Editing personas in forms; the private console and its organisation-wide views; Windows; mobile;
auto-update for the desktop app in v1; notifications beyond the tray's state.

## Open questions

1. **Desktop distribution.** macOS needs a Developer ID certificate and notarisation for a
   download that opens without warnings; Linux needs a package format (AppImage, `.deb`). Decide
   before layer 4; until then the desktop app is built from source.
2. **Component library.** Plain CSS with a few primitives, or a library (Radix, shadcn/ui)?
   Decide in layer 2 with the console's needs in mind.
