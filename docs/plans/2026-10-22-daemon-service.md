# Daemon Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The daemon is installed as a login service (launchd / systemd --user), `zzpersona claude`
and `codex` start it when it is not running, and one daemon per home holds under a start race.

**Architecture:** A `gh stack` on `feature/service-0-spec`, one layer per task
(`gh stack add feature/service-<n>-<name>`). The lock gets a guarded takeover and a live-socket
check in `daemon/server.ts`; a new `daemon/service.ts` renders and drives the service file through
the injected probe; a new `daemon/autostart.ts` runs inside `launch()` after `beforeRun`.

**Tech Stack:** TypeScript, Node 26, vitest, zod; `launchctl`, `systemctl --user`. No new
dependencies.

**Spec:** `docs/planning/16-daemon-service.md`

## Global Constraints

- Label `zzpersona.daemon`; plist `~/Library/LaunchAgents/zzpersona.daemon.plist`; unit
  `~/.config/systemd/user/zzpersona-daemon.service` (`$XDG_CONFIG_HOME` when set). `~` is
  `env.HOME`. The test-only `ZZPERSONA_SERVICE_LABEL` replaces the label and both file names'
  stem (undocumented).
- Service command: `[<findOnPath("zzpersona", env)>, "daemon", "run"]`; the file's environment is
  exactly `PATH` (install-time), `ZZPERSONA_HOME` (only when set), `ZZPERSONA_SERVICE=1`.
- plist keys: `Label`, `ProgramArguments`, `EnvironmentVariables`, `RunAtLoad` true, `KeepAlive`
  `{ SuccessfulExit: false }`, `ProcessType` `Background`, `StandardOutPath` and
  `StandardErrorPath` the home's `daemon/daemon.log`. Unit: `[Unit] Description=zzpersona daemon`,
  `[Service] ExecStart=… daemon run`, one `Environment=` line per variable, `Restart=on-failure`,
  `[Install] WantedBy=default.target`.
- launchd: load `launchctl bootout gui/<uid>/<label>` (ignore failure) then `launchctl bootstrap
  gui/<uid> <plist>`; start `launchctl kickstart gui/<uid>/<label>`; unload `bootout`; loaded =
  `launchctl print gui/<uid>/<label>` exits 0. systemd: `systemctl --user daemon-reload`, `enable
  --now <unit>`; start `start`; unload `disable --now`; loaded = `is-enabled` exits 0.
- Error codes: `cli-not-on-path` (with `CLI_ON_PATH_FIX`), `service-unsupported` ("not supported on
  Windows yet"), `service` (a launchctl/systemctl failure, its stderr in the message),
  `daemon-running` ("already running").
- Auto-start: skipped for `--dry-run`, `--json`, `daemon.autoStart: false`, `ZZPERSONA_NO_DAEMON=1`;
  waits at most 1000 ms; failure line verbatim: `zzpersona: daemon not started (<reason>); live
  refresh is off for this session` on stderr; never changes the exit code.
- Takeover file `daemon.lock.takeover`, stale after 10 s (mtime).
- Every layer passes `pnpm turbo run build check-types lint test` and `pnpm format:check`; commits
  end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Unit tests never run real
  `launchctl`/`systemctl` and never touch the real `~/.zzpersona`, `~/.claude` or
  `~/Library/LaunchAgents`.

## Review Focus

1. A plist or unit value with characters that need escaping (a PATH or home with `&`, `<`, a space,
   `%`, a quote) → a file the service manager reads as written → Task 2 test "escapes values".
2. `daemon install` when the old service file points to a `zzpersona` that no longer exists and the
   daemon is not running → install still succeeds (bootout failure ignored) → Task 2 test
   "reinstalls over a broken service".
3. Auto-start against a daemon that refuses the token (`daemon-unauthorized`) → the launch goes
   ahead with the failure line, no throw → Task 3 test "a refusing daemon does not stop a launch".
4. A service `daemon run` that loses the race → exit 0 so launchd/systemd do not loop; a manual
   `daemon run` that loses → exit 1 → Task 2 test "already running exits 0 under the service".
5. Takeover when the lock file is empty or unreadable (a crash between `open` and `write`) → treated
   as stale, taken over once → Task 1 test "an empty lock is stale".

---

### Task 1: The lock (`feature/service-1-lock`)

**Files:** Modify `src/apps/cli/src/daemon/server.ts` (`acquireLock`, the listen block). Test
`src/apps/cli/src/daemon-lock.test.ts` (new).

**Interfaces (produces):** `export async function acquireLock(lock: string, now?: () => number):
Promise<void>` (exported for tests; throws `CliError("daemon-running")`). Paths unchanged.

- [ ] **Step 1: Failing tests** in `daemon-lock.test.ts` (temp dir):
  `it("one of twenty starters wins a stale lock")` — write `daemon.lock` with a dead pid (spawn
  `true`, wait for exit, use its pid); `Promise.allSettled` of 20 `acquireLock`; exactly 1
  fulfilled, 19 rejected with code `daemon-running`, the lock holds `process.pid`.
  `it("an empty lock is stale")` — empty file → acquired.
  `it("a live owner keeps the lock")` → rejects, file unchanged.
  `it("removes a takeover file older than 10 s")` — stale lock plus a takeover file with mtime 11 s
  ago → acquired, takeover file gone; with mtime 1 s ago → rejects `daemon-running`.
  `it("leaves a live socket alone")` — start a daemon in a temp home (`startDaemon`), remove its
  `daemon.lock` by hand, `startDaemon` again → rejects `daemon-running`; the first daemon's
  `GET /status` still answers.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/cli exec vitest run src/daemon-lock.test.ts` —
  Expected: FAIL.
- [ ] **Step 3: Implement.** `acquireLock`: `open(lock, "wx")` wins; on `EEXIST` read the owner;
  live → `daemon-running`; dead or empty → take `<lock>.takeover` with `wx` (on `EEXIST`: remove it
  if its mtime is over 10 s old and retry once, else `daemon-running`); holding it, read the lock
  again and replace it (rm, `open wx`, write pid) only if it holds the same text as first read, else
  `daemon-running`; always remove the takeover file. In `startDaemon`, before `rm(paths.sock)`:
  connect to the socket (a plain `net.connect`, 200 ms); accepted → close, throw `daemon-running`
  (the existing catch removes the lock).
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` — Expected: PASS.
- [ ] **Step 5: Commit** `fix(cli): one daemon per home under a start race`.

### Task 2: The service (`feature/service-2-service`)

**Files:** Create `src/apps/cli/src/daemon/service.ts`, `src/apps/cli/src/daemon-service.test.ts`,
golden files `src/apps/cli/test/golden/service/zzpersona.daemon.plist` and
`.../zzpersona-daemon.service`. Modify `commands/daemon.ts` (install, uninstall, start, run,
status), `cli.ts` (commands; `CliIo.service?: ServiceManager`), `daemon/server.ts` and
`daemon/client.ts` (`DaemonStatus.service: boolean`, from the daemon's `ZZPERSONA_SERVICE`),
`doctor/checks.ts` (the `daemon` check), `.prettierignore` if the golden folder is not covered.

**Interfaces (produces):**
```ts
// daemon/service.ts
export interface ServiceSpec { command: string[]; env: Record<string, string>; log: string }
export interface ServiceManager {
  kind: "launchd" | "systemd";
  label: string;
  path: string;                       // the service file
  render(spec: ServiceSpec): string;  // pure
  install(spec: ServiceSpec): Promise<void>;   // write + (re)load
  uninstall(): Promise<void>;
  start(): Promise<void>;
  loaded(): Promise<boolean>;
}
/** The platform's manager, or undefined on Windows. */
export function serviceManager(io: Pick<CliIo, "env" | "probe">): ServiceManager | undefined;
/** The installed file's command path, or undefined when no file. */
export async function installedCommand(manager: ServiceManager): Promise<string | undefined>;
```
`io.service` overrides `serviceManager(io)` in tests.

- [ ] **Step 1: Failing tests** in `daemon-service.test.ts` (fake probe recording calls; temp
  `HOME`):
  `it("renders the plist")` / `it("renders the unit")` — fixed spec (command
  `/u/bin/zzpersona`, `PATH=/u/bin:/usr/bin`, `ZZPERSONA_HOME=/h`, `ZZPERSONA_SERVICE=1`) equal the
  golden files byte for byte.
  `it("escapes values")` — `PATH` `/a b&<c>:%x"y` round-trips: plist XML-escaped; unit value
  quoted with `%` doubled (`%%`).
  `it("installs, reinstalls and uninstalls through launchctl")` — exact call lists per Global
  Constraints, uid from `process.getuid()`; file written then removed.
  `it("… through systemctl")` likewise, file under `$XDG_CONFIG_HOME` when set.
  `it("reinstalls over a broken service")` — bootout exits 1 → install still succeeds.
  `it("daemon install refuses without zzpersona on PATH")` → `cli-not-on-path`.
  `it("daemon install stops a detached daemon first, then waits for the socket")` (in-process
  daemon via `spawnDaemon`, fake manager whose `install` starts one).
  `it("daemon start uses the service when installed")` — manager `start` called, no spawn.
  `it("Windows is refused")` → `service-unsupported`.
  `it("already running exits 0 under the service")` — `daemon run` with a live daemon:
  `ZZPERSONA_SERVICE=1` → 0, without → 1.
  `it("status and doctor report the service")` — status text `service: installed (<path>)`, JSON
  `service: { installed, path, managed }` (`managed`: the running daemon is the service's); doctor warns when the file's command is gone, and when
  installed but not loaded, fix `zzpersona daemon install`; a version mismatch's fix is
  `zzpersona daemon install` when installed.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/cli exec vitest run src/daemon-service.test.ts` —
  Expected: FAIL.
- [ ] **Step 3: Implement.** Plist written as XML text by hand (no plist dependency). `install`:
  mkdir the folder, write the file 0644, unload (ignore failure), load; a nonzero load →
  `CliError("service", …)`. `daemon install`: `findOnPath`, stop a running daemon (reuse
  `daemonStop`'s logic without its output), `install`, wait for the socket as `daemonStart` does.
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): zzpersona daemon install|uninstall (launchd, systemd)`.

### Task 3: Auto-start (`feature/service-3-autostart`)

**Files:** Create `src/apps/cli/src/daemon/autostart.ts`, `src/apps/cli/src/autostart.test.ts`.
Modify `config.ts` (`daemon: z.strictObject({ autoStart: z.boolean().optional() }).optional()`),
`launch.ts` (call after `beforeRun`, before `runPlan`; not reached for `--json`/`--dry-run`).

**Interfaces:** consumes `serviceManager`/`io.service`, `connectDaemon`, `io.spawnDaemon`.
Produces `export async function ensureDaemon(io: CliIo, home: string, config: Config):
Promise<void>` — never throws.

- [ ] **Step 1: Failing tests** (`zz(["claude"], …)` with `recorder()` as `claude.test.ts`):
  `it("starts the daemon before the launch")` — `spawnDaemon` called once, before `runPlan`;
  `it("leaves a running daemon alone")`; `it("is skipped for --dry-run, --json, autoStart: false
  and ZZPERSONA_NO_DAEMON=1")` — no spawn; `it("uses the service when installed")`;
  `it("a failed start still launches")` — `spawnDaemon` rejects → `runPlan` called, exit code
  unchanged, stderr has the failure line verbatim; `it("a refusing daemon does not stop a
  launch")` — `connectDaemon` throws `daemon-unauthorized` (inject via a token file of the wrong
  value) → launch goes ahead with the failure line; `it("waits no more than 1 s")` — a spawn that
  never brings a socket up → `runPlan` called within 1.5 s; `it("codex starts it too")`.
  Config: `it("rejects an unknown daemon key")` in the config tests.
- [ ] **Step 2: Run** `pnpm --filter @zzpersona/cli exec vitest run src/autostart.test.ts` —
  Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm turbo run build check-types lint test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): zzpersona claude and codex start the daemon`.

### Task 4: E2e, smoke and docs (`feature/service-4-e2e-docs`)

**Files:** Create `src/apps/cli/src/service.e2e.test.ts`. Modify `README.md` (daemon section:
`daemon install`, auto-start, `autoStart: false`), `CLAUDE.md` (reading list item 16; status line),
`docs/planning/03-architecture.md` and `14-daemon.md` (dated notes), `16-daemon-service.md`
(amendments, smoke result). Create `.changeset/daemon-service.md` (minor `@zzpersona/cli`).

- [ ] **Step 1: E2e** (skipped unless `ZZP_E2E_SERVICE=1` and macOS): the built binary on a temp
  PATH as `zzpersona`; temp `HOME` and `ZZPERSONA_HOME`; `ZZPERSONA_SERVICE_LABEL=
  zzpersona.daemon.e2e-<random>`. `daemon install` → `daemon status --json` running and
  `service.installed`; `kill -9` the pid → within 15 s a new pid answers; `daemon stop` → still
  stopped after 3 s; `daemon uninstall` → `launchctl print` fails. `afterAll` always `bootout`s.
- [ ] **Step 2: Run** `ZZP_E2E_SERVICE=1 pnpm --filter @zzpersona/cli exec vitest run
  src/service.e2e.test.ts` — Expected: PASS.
- [ ] **Step 3: Smoke (controller, herdr, before the final review, after asking the user):** the
  real `zzpersona daemon install`; `daemon status` shows the service; `zzpersona claude` in
  `examples/demo-app` is watched; `kill -9` the daemon → it returns and `zzpersona status` still
  lists the session. Record in spec 16's amendments.
- [ ] **Step 4: Docs; run** the full pipeline and `pnpm format:check` — Expected: PASS.
- [ ] **Step 5: Commit** `test: daemon service e2e; docs`.
