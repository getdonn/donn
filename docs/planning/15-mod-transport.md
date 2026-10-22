# 15 — Mod transport: the Claude Code mod talks to the daemon

> Status: design, 2026-10-21. Phase 2, the daemon's second slice (spec 14 named it). Answers spec
> 09 open question 3. Builds on `09-mod-claude-code.md`, `10-live-switching.md` and
> `14-daemon.md`. Built as a `gh stack`: layer 0 is this spec and its plan.

## Intent

`/persona` and the band keep working when the mod may not run processes (managed policy), and get
faster when the daemon runs: the mod asks the daemon over its socket and falls back to running the
CLI, as today, when the daemon is not there.

## Spike (2026-10-21, throwaway, Claude Code 2.1.304, a scratch daemon)

A dev mod called `GET /status` with `$.http.fetch("http://zzpersona/status", { socketPath,
headers })`: 200 in 1–3 ms (a CLI call costs a Node start-up, roughly 150–300 ms); 401 without the
token; still 200 with `permissions.deny: ["WebFetch"]` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`
(the request carries no `auth`); through the fallback socket of 0.5.2 (found via `where`). Not
testable here: how a real managed policy treats `$.http` over a socket.

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| Daemon first, CLI fallback | CLI first with a daemon fallback; daemon only | The speed whenever the daemon runs, nothing broken when it does not; nothing auto-starts the daemon yet |
| One endpoint, `POST /run`, answering what the CLI prints | An endpoint per operation | The mod's parsing and messages do not change, only the transport |
| An allowlist of the mod's commands | Any CLI command | The socket must not launch harnesses, write files or stop the daemon |
| The socket path is trusted because it comes from the user's 0700 daemon folder | Checking the socket's owner from the mod | `$.fs.stat` gives no owner; `where` lives in the user's own folder and points into the private directory the daemon verified |

## 1. The daemon: `POST /run`

- **Request:** `{ argv: string[], cwd: string }`, with the bearer token as for every endpoint.
  **Response:** `200 { exitCode, stdout, stderr }`, what running `zzpersona <argv>` in `cwd` would
  print, from `createCli` run in-process with captured output and the daemon's home.
- **Allowlist** (every form with `--json`, which the request must carry):
  `switch`, `switch <persona>`, `switch <persona> --default`, `switch --clear`,
  `switch --clear --default`, `list`, `live <persona> --session <dir>`,
  `live --show --session <dir>`. Anything else: `403 not-allowed`.
- **Checks:** `cwd` absolute and an existing directory, `argv` an array of strings, else
  `400 bad-request`; the 1 MiB body cap and token check as for every endpoint.
- **Failures** of the command itself are a `200` with its exit code and output, as the CLI would
  print them; only transport problems are HTTP errors.
- A `live` run through `/run` takes the session's lock as the CLI does; the refresh's
  superseded check (0.5.2) covers the other order.

## 2. The mod

- **Locating the daemon:** the session's home is `ZZPERSONA_HOME` from the session's environment,
  else `$HOME/.zzpersona`. The socket is `<home>/daemon/where` when present, else
  `<home>/daemon/sock`; the token `<home>/daemon/token`; both read with `$.fs.read`.
- **Socket check:** the token is sent only to a path that `$.fs.stat` shows as `kind: "other"`
  and not a link.
- **`run(argv, cwd)`** replaces `runCli`:
  1. `POST http://zzpersona/run` over the socket, raced with `$.clock.after(1500)` (`$.http.fetch`
     has no timeout);
  2. on a 401, the token is read again and the request retried once;
  3. no socket or token, a refused connection, a timeout, a 5xx or a second 401: `$.process.run`
     of the CLI, exactly as today.
  Each call tries the daemon again; a daemon started mid-session is used from then on.
- **Unchanged:** the per-turn `live.json` read (a file read), the band, the nudge, `/persona`'s
  wording and every parse.
- **Both routes failing** (no daemon, and policy refuses `process.run`): `/persona` says
  `zzpersona unavailable: start the daemon (zzpersona daemon start), or allow the mod to run
  zzpersona`.

## 3. Stack and testing

| Layer | Contents |
|---|---|
| 0 `spec` | this spec and its plan |
| 1 `daemon` | `POST /run`: allowlist, in-process `createCli` with captured output, `cwd` check |
| 2 `mod` | `run()` daemon first with CLI fallback; socket and token; socket check; 1.5 s race; one retry on 401; the unavailable message |
| 3 `e2e-docs` | opt-in e2e; a real Claude Code smoke run before the final review; README; spec 09's open question 3 answered; changesets |

- **Daemon:** each allowed form answers the same `{ exitCode, stdout }` as the CLI run in that
  `cwd`; `claude`, `write`, `daemon stop` and an unknown command → 403; a relative or missing `cwd`
  → 400; no token → 401; a `live` through `/run` while a refresh runs leaves the session
  consistent.
- **Mod** (the fake host): daemon answers → no `process.run`; daemon missing, refusing, timing out
  (fake clock) or answering 500 → the CLI; a 401 then a fresh token → one retry; a socket path that
  is a link or not a socket → no token sent; both failing → the unavailable message.
- **E2e (`ZZP_E2E=1`):** the built binary's daemon serves `/run` for `switch` and `list`.
- **Smoke (herdr, before the final review):** a scratch Claude Code with the dev mod and a stub
  hook refusing `process.run`; `/persona list`, `/persona use` and the band work through the
  daemon; with the daemon stopped, the unavailable message.

## Non-goals

Auto-start and service install; the per-turn `live.json` read; Codex; Windows.

## Open questions

1. How a real managed policy treats `$.http` over a unix socket (the stub refusal of
   `process.run` is the closest test here).

## Amendments from implementation (2026-10-21)

- The 1 MiB request body cap is introduced for `POST /run`; no other endpoint reads a body.
- `daemonRequest` gained an optional JSON body (a sixth argument).
- The mod no longer feature-checks `$`. Claude Code 2.1.307's validator rejects
  `typeof $.fs?.read` ("$ is always spelled $.noun.event(...)"), so a missing API is handled by
  try/catch. This also fixes the released 0.2.2 mod not loading on 2.1.307.
- Smoke run (Claude Code 2.1.304, herdr, scratch home and daemon, the dev mod plus a throwaway mod
  whose `process.run` hook returns `{ deny }`, standing in for managed policy): the band drew;
  `/persona list` answered through the daemon (its log shows `run ["list","--json"]` and the mod's
  start-up `switch` and `live --show`); `/persona use team/web` switched live through `/run` and the
  band showed `persona team/web · live`; with the daemon stopped, `/persona list` printed the
  unavailable copy. Found: the copy shows doubled, `zzpersona: zzpersona unavailable: …`;
  fixed: no reply or status text starts with `zzpersona` (the host adds the prefix).
