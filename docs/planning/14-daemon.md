# 14 — The daemon, first slice: live sessions stay current

> Status: design, 2026-10-21. Phase 2, fourth item (order agreed: agents-md, Codex, capability
> matrix, daemon). Builds on `03` §Local daemon, `10-live-switching.md` (session folders, the
> live swap) and `12-codex.md`. Built as a `gh stack`: layer 0 is this spec and its plan.
>
> 2026-10-22: the next slice, service install and auto-start, is built (spec 16,
> `16-daemon-service.md`): `zzpersona daemon install|uninstall`, `daemon start` through the service
> when installed, `zzpersona claude` / `codex` starting the daemon, and a lock that holds under a
> start race.

## Intent

Edit a persona file and every running Claude Code session on it picks the change up, without a
relaunch and without typing anything; `zzpersona status` shows what runs in each harness and
whether it is current. This is the first slice of `03`'s daemon. It also lays the foundation the
next slices need: mod transport over the socket, service install, and the tray app.

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| Slice the daemon; first slice is lifecycle, local API, session registry, watch-and-refresh | The whole of `03` §Local daemon at once | Too big for one spec; sync, drift and the marketplace need a control plane |
| A real daemon (`zzpersonad`) with a socket API | The launcher process watches its own session; a background process with files as the only interface | The next slices (mod transport, service install, tray) all need a daemon with an API; nothing is built twice |
| `zzpersona daemon run` inside the CLI package | A separate `src/apps/daemon` package now | It reuses the CLI's build and live-swap code, which is not a package yet; extract later |
| Session folders stay the source of truth; the daemon reads them | A registry held in the daemon | `status` works without the daemon, and nothing breaks if the daemon dies |
| Refresh every Claude Code session on any change, skip when the build hash is unchanged | Track which files each persona depends on | A few sessions are cheap to rebuild; no edit to an indirectly reached file is missed |
| The daemon never resolves secrets | A secrets broker in this slice | A live swap needs none (spec 10); the broker is its own slice |

## 1. Process and lifecycle

- **`zzpersona daemon run`** is the daemon, in the foreground; same binary and package as the
  CLI. `03` gets a dated note: it moves to `src/apps/daemon` once the build code is a package.
- **`zzpersona daemon start`** spawns `daemon run` detached and waits until its socket answers;
  a running daemon: "already running" (exit 0). **`daemon stop`** asks it to shut down (falls back
  to SIGTERM by pid). **`daemon status`**: running or not, pid, version, uptime, sessions watched.
  All take `--json`. Nothing auto-starts the daemon in this slice.
- **Files**, under `~/.zzpersona/daemon/` (mode 0700): `sock` (the unix socket, 0600), `token`
  (random, regenerated each start, 0600), `pid`, `daemon.lock` (one instance per home),
  `daemon.log` (capped at about 1 MB, one rotated copy). A stale pid, socket or lock from a killed
  daemon is cleaned up on start.
- **Socket path length:** macOS caps a socket path at 104 bytes. When `<home>/daemon/sock` is too
  long the socket goes to a short path under the system temp directory and its location is
  written to `~/.zzpersona/daemon/where`; clients read `where` when present.
- **Versions:** the daemon reports its version; a CLI of another version still uses it and warns
  once: `daemon runs <x>, CLI is <y>; zzpersona daemon stop && zzpersona daemon start`.
- **Secrets:** never resolved by the daemon.
- **Platforms:** macOS and Linux.

## 2. Session registry

- `~/.zzpersona/sessions/<id>/` (spec 10) stays the source of truth. The daemon reads and watches
  the directory; it never creates a session.
- `launched.json` gains `harness` (`claude-code | codex`), `project` (the repo root, when there is
  one), `startedAt` and `buildHash` (the launched build's hash, section 3). A file without them
  reads as `claude-code`, no project, no hash (the first refresh then always swaps).
- `zzpersona codex` registers a session folder holding only `launched.json`, removed on exit as
  for Claude Code. Codex sessions are listed, never swapped.
- A session runs while its launcher's pid is alive (`kill(pid, 0)`). The daemon removes a dead
  session's folder at once; without a daemon, `doctor --fix` still removes orphans after 24 hours.
- Per session: harness, project, launched persona, live persona (`live.json`), started, `held`,
  and a state:
  - **current** — the applied build matches what the persona files compile to now;
  - **refreshed** at a time;
  - **stale** — needs a relaunch: a Codex session whose build changed, or a change to MCP,
    permissions or settings (`held` names which);
  - **refresh-failed** — with the error; the session keeps its last good build.

## 3. Watching and refresh

- **Watched:** each personas root in the config, each running session's project `.zzpersona/`,
  `~/.zzpersona/overrides.yaml`, `~/.zzpersona/config.yaml`, and the sessions directory. Recursive
  `fs.watch`.
- **Debounce:** 300 ms after the last event.
- **Refresh:** on any change, every running Claude Code session is re-resolved and recompiled with
  its current persona (live, else launched) and its launch overlay setting. Its build hash (the
  plugin folder's files and the instructions) is compared with the applied one: `live.json`'s
  `buildHash` (new) after a swap, else `launched.json`'s; equal means no swap.
- **Apply:** the swap `zzpersona live` does, extracted from `commands/live.ts` as
  `applyLive(ctx, sessionDir, selection)` with its lock, staging and atomic `live.json` write. The
  mod picks it up on its next turn, as for `/persona use`. `held` and `stricter` are recomputed
  against the launch; a non-empty `held` that grew makes the state **stale**.
- **Failure:** a persona that no longer resolves or compiles is not swapped; the state is
  **refresh-failed** with the error until a later change compiles.
- **Codex:** never swapped; a changed build marks the session **stale**.
- **Log and events:** each refresh, skip and failure is a log line and an event; persona refs and
  paths only.

## 4. Local API and the CLI

HTTP/1.1, JSON bodies, over the unix socket (`node:http`, no new dependency).
`Authorization: Bearer <token>` on every request.

| Endpoint | Purpose |
|---|---|
| `GET /status` | `{ version, pid, startedAt, watching: string[], sessions: Session[] }` |
| `GET /events` | Server-sent events: `session.added`, `session.ended`, `session.refreshed`, `session.stale`, `session.refresh-failed`, `daemon.stopping` |
| `POST /refresh` | Re-check every session now |
| `POST /shutdown` | Finish an in-flight swap, remove `sock`, `pid` and `where`, exit |

Errors use the CLI's shape, `{ error: { code, message } }`: `401 unauthorized`, `404 not-found`.

- **`zzpersona status [--json]`:** from the daemon when it runs (a header line naming it, one line
  per session: harness, project, launched → live persona, state); otherwise the session folders
  read in-process, without states, and a note: `daemon not running: sessions are not refreshed on
  edits; zzpersona daemon start`.
- **`zzpersona daemon refresh`** calls `POST /refresh`.
- Every other command runs in-process as before; a running daemon sees their effects through the
  files.
- **`doctor`** gains `daemon`: `ok` running at the same version; `warn` on a version mismatch or a
  stale pid or socket (the fix names the cleanup); `ok` "not running (optional)".

## 5. Stack and testing

| Layer | Contents |
|---|---|
| 0 `spec` | this spec and its plan |
| 1 `sessions` | `launched.json` fields (with `buildHash` at launch); Codex sessions; `applyLive()` extracted; `buildHash`; `listSessions(home)` with pid liveness |
| 2 `daemon` | `daemon run\|start\|stop\|status`; files, lock, token; socket server, auth, `GET /status`, `POST /shutdown`; log; the short socket path |
| 3 `watch` | watcher, debounce, refresh, states, stale Codex sessions, `GET /events`, `POST /refresh`, dead-session removal |
| 4 `cli` | `zzpersona status`, `daemon refresh`, doctor's `daemon` check, the version warning |
| 5 `e2e-docs` | opt-in e2e; README, changeset, CLAUDE.md, the `03` note |

- **Sessions:** an old `launched.json` reads with defaults; Codex sessions register and are
  removed; `applyLive` keeps the existing live tests passing; the same build gives the same
  `buildHash`.
- **Daemon:** per-test temporary home and socket; start/status/stop; second start "already
  running"; stale pid, socket and lock cleaned up; 401 and 404; the long-home fallback; 0600 modes.
- **Watch:** fake sessions owned by a live child process; an instruction edit → `live.json`
  updated and `session.refreshed`; an unchanged save → no swap; a broken persona →
  `refresh-failed`, old plugin kept, cleared by the next good save; an MCP or permissions edit →
  stale; a Codex session → stale; a killed child → session removed; five quick saves → one
  refresh.
- **CLI:** `status` with and without the daemon, text and `--json`; doctor's daemon states.
- **Opt-in e2e (`ZZP_E2E=1`):** the built binary starts the daemon in a scratch home; a session
  owned by a real child process; an instruction edit; `status --json` reports it refreshed and
  `live.json` holds the new instructions. A real Claude Code smoke run in a herdr pane afterwards,
  recorded as findings.

## Non-goals

Auto-start and service install; pre-built warm builds; mod transport over the socket; the
secrets broker; sync, drift and the local marketplace; live refresh for Codex; Windows.

## Open questions

1. Whether the mod should listen to `/events` instead of checking on its next turn (with mod
   transport).
2. Whether recursive `fs.watch` on Linux holds up on large personas folders, or needs polling.

## Amendments from implementation (2026-10-21)

- **Skips:** a skip is a log line only, not an event; the event list stays the six names.
- **`launched.json` mode:** it also records `mode` when `zzpersona claude` was given `--mode`, and
  refresh and `applyLive` compile with that mode's facts.
- **Polling:** the daemon polls session pids every second (`pollMs`), so a session whose process
  died is removed without a file event.
- **Status entries** carry `at` (when it was refreshed) and `error` (the refresh-failed message).
- **`daemon stop`** waits for the daemon's lock to be released (or, on the SIGTERM fallback, for the
  pid to exit) and fails with `daemon-stop` otherwise.
- **Doctor** tells an unresponsive daemon (live pid, no answer; fix `zzpersona daemon stop`) from a
  stale one (dead pid or leftover socket; fix `zzpersona daemon start`).
- **Probe reuse:** `zzpersona status` and doctor read the status the client probed on connect rather
  than requesting it again.

### From the smoke run: the mod applies refreshes (2026-10-21)

A smoke run with real Claude Code (2.1.306) showed the daemon's refresh reached `live.json` (new
instructions, status `refreshed`) but not the model: Claude answered from the old instructions on
its next turn. Two causes, both in the mod: it read the live state only at `session.start` and
after its own `/persona use`, so a `live.json` the daemon wrote mid-session was never seen; and its
superseding section was added only while the live persona differed from the launched one, so a
refresh of the launched persona itself never reached the prompt.

The fix, in `@zzpersona/mod-claude-code`:

- A `prompt.submit` hook reads `<session>/live.json` with `$.fs.read` (no CLI call: it runs every
  turn, and policy can refuse `process.run`). When its `appliedAt` is newer than the state the mod
  holds, the mod adopts it and calls `$.ui.invalidate("prompt.section")` and
  `$.ui.invalidate("ui.render")` before letting the prompt through. A missing, unparseable or
  ill-shaped file (any field the mod uses missing or of the wrong type) is ignored.
- The superseding section is present whenever a live state exists. For the launched persona it
  reads `The instructions for this session's persona <p> were updated. Disregard the section headed
  "## zzpersona persona: <launched>"; the instructions below replace it.` The band still shows
  `· live` only when the persona differs.

Verified (second smoke run, Claude Code 2.1.306, the dev mod loaded with `--plugin-dir` beside the
installed one; one band drew): Claude answered `SMOKE-ALPHA`; the persona's instruction was edited
to `SMOKE-BRAVO`; `zzpersona status` showed `refreshed` within a second; on the very next turn of
the same session Claude answered `SMOKE-BRAVO`. The refresh applies to the turn the prompt starts.

### From the final review (2026-10-21)

- **Fallback socket location** (replaces "a short path under the system temp directory" in §1): a
  long home's socket goes in a folder of the user's own, `$XDG_RUNTIME_DIR` when set, else
  `<tmpdir>/zzpd-<uid>` (created 0700), as `zzpd-<hash>.sock`. On Linux `/tmp` is shared, so a bare
  predictable name there could be taken by another user first. The daemon refuses to start
  (`daemon-socket-dir`) unless the folder is a real directory, not a symlink, owned by the user,
  mode 0700. Clients `lstat` the socket and treat one that is not a socket owned by the user as no
  daemon: the token is never sent to it. `where` still names the socket.
- **Token file:** removed when the daemon stops and when a start fails, with `pid` and `where`.
- **`daemon start`** runs the detached daemon with the home as its working directory.
- **A refresh never undoes a switch:** the daemon's swap re-reads `live.json` under the session's
  lock; when the persona or `appliedAt` changed since the refresh read the session (a `/persona use`
  or `zzpersona live` landed meanwhile), nothing is swapped and the refresh is logged as a skip
  (`skip <session> <persona>: superseded`), leaving the session's state as it was.

### From a test run on the examples (2026-10-21)

A test matrix on `examples/demo-app` with Haiku found that a refresh of the *launched* persona was
ambiguous to the model: the superseding section's instructions began with the same
`## zzpersona persona: <id>` heading as the launch section, and the section sits above the launch
section in the prompt, so "disregard the section headed …" matched both and Haiku kept the launch
text (Opus had resolved it in the smoke run). Fixed in the mod: the superseding instructions are
re-headed `## zzpersona persona: <id> (updated <appliedAt>)`, the note names the launch heading
exactly, "wherever it appears", and says earlier answers may be outdated. The band also shows
`relaunch for <held>` when a same-persona refresh holds MCP, permissions or settings. Re-tested on
Haiku with the dev mod: a conflicting edit, a second edit, and a switch away and back all answered
the new codeword on the first try.
