# 28 — The desktop app: donn in the menu bar

> Status: design, 2026-10-26. Spec 26 built layers 1–3 of the GUI (the loopback bridge, `donn ui`,
> the web app) and deferred layer 4, the desktop shell, until the web app had been used and its
> open question 1 (distribution) was decided. This spec designs layer 4 and decides that question:
> **built from source for v1**; signed and notarised downloads are a later spec. It adds two flags
> and one field to the CLI and a menu-bar app, `src/apps/desktop` (Tauri 2), that has no logic of
> its own: every read and every action is a `donn` command.
> *2026-10-26: built.* `src/apps/desktop` (Tauri 2), `donn status --watch --json`,
> `donn ui --page` and the app's `?project=`; smoked on macOS, see "Amendments from the build".

## Intent

A user who has donn installed builds the desktop app once and gets donn in the menu bar: the
default persona and each live session's persona at a glance, a switcher, the created agents with
their state and a run/stop, and "Open donn" for the full app in a window. The shell never does
something the CLI cannot: it runs the installed `donn` with `--json` and shows what comes back.
Success is the smoke run in §6 passing on the maintainer's Mac.

## Facts this design rests on

From the Tauri docs (v2.tauri.app, read 2026-10-26) and the registries:

- Tauri is at 2.12 (`tauri` 2.12.5 on crates.io; `@tauri-apps/cli` and `@tauri-apps/api` 2.12.4 on
  npm); Rust stable is 1.99.1. `tauri-plugin-autostart` needs Rust 1.90+.
- "By default the API is only accessible to bundled code shipped with the Tauri App": a webview
  that loads a remote URL has no IPC unless a capability lists that URL under `remote.urls`.
- The tray needs the `tray-icon` feature. Menus are built in Rust (`Menu::with_items`,
  `MenuItem::with_id`) and handled in `TrayIconBuilder::on_menu_event`. The menu opens on left and
  right click by default. On Linux tray click events are not emitted; the menu still opens.
- `tauri-plugin-autostart` (`MacosLauncher::LaunchAgent`) exposes `enable`, `disable` and
  `is_enabled` from Rust through `app.autolaunch()`.
- To confirm in layer 2 (not read in the docs yet): `set_activation_policy(Accessory)` for no Dock
  icon, `WebviewWindowBuilder::on_navigation`, `tauri-plugin-single-instance`,
  `tauri-plugin-dialog` from Rust, `tauri-plugin-opener` for external links, ad-hoc signing
  (`signingIdentity: "-"`).

*Confirmed 2026-10-26 (layer 2):* against v2.tauri.app, docs.rs and the crates' sources (`tauri`
2.12.5, `tauri-build` 2.7.4, `tauri-plugin-single-instance` 2.5.4, `tauri-plugin-dialog` 2.8.3,
`tauri-plugin-opener` 2.7.2, `tauri-plugin-autostart` 2.7.0; the plugins need Rust 1.90+).

- Confirmed: `App::set_activation_policy(tauri::ActivationPolicy::Accessory)`, macOS only
  (`#[cfg(target_os = "macos")]`), in `setup`; `AppHandle::set_activation_policy` returns a
  `Result`. It is missing from docs.rs, which builds on Linux.
- Confirmed: `WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))` (http or https only)
  and `.on_navigation(|url: &Url| -> bool)`; `false` cancels. A navigation from Rust
  (`Webview::navigate`, `reload`) also goes through the handler, so it must accept a new bridge
  port after a daemon restart (read the port from shared state, not a captured copy). Links with
  `target=_blank` are new-window requests: `on_new_window` (return `NewWindowResponse::Deny`).
- Confirmed: `tauri_plugin_single_instance::init(|app: &AppHandle, args: Vec<String>, cwd:
  String| …)`, registered first; no capability needed. Linux uses D-Bus, macOS a Unix socket.
- Confirmed: `app.dialog().message(text).kind(MessageDialogKind::Error).title(…)` with `.show(|ok|
  …)` or `.blocking_show()` (not on the main thread) via `tauri_plugin_dialog::DialogExt`; Rust
  calls need no permission (permissions gate the webview's commands).
- Confirmed: `app.opener().open_url(url, None::<&str>)` via `tauri_plugin_opener::OpenerExt`.
  The plugin injects a link-click script by default; the shell builds it with
  `Builder::new().open_js_links_on_click(false)`.
- Confirmed: `bundle.macOS.signingIdentity: "-"` (or `APPLE_SIGNING_IDENTITY=-`) signs ad hoc.
- Confirmed: a capability without `remote` is compiled with `"local": true` and grants nothing to
  a remote URL ("By default the API is only accessible to bundled code"); after a navigation to a
  remote URL only a capability whose `remote` matches applies.
- New: `tauri::generate_context!()` fails without `src-tauri/icons/icon.png`; layer 2 commits a
  placeholder, layer 3 the real icons (`bundle.icon`).

From this repo (2026-10-26):

- This Mac has no Rust toolchain.
- The daemon's socket API has `POST /ui/open` (port and a one-time code); `donn ui --no-open
  --json` prints `{ url, port }` with `url` = `http://127.0.0.1:<port>/#t=<code>`. The code works
  once and expires in 60 s. The bridge serves `index.html` for app routes, and the app reads `#t=`
  on any path.
- The app uses a browser router; the agent page (`/agents/a/:name`) takes its project from the
  project picker (`sessionStorage`), so a link to it needs the project too.
- `donn status --json` prints the daemon's status (sessions with `harness`, `launched`, `live`,
  `state`, `project`), the created agents and the managed-settings state. The daemon's events
  (`GET /events`, followed by `connectDaemon(...).follow`) are `session.added|ended|refreshed|
  stale|refresh-failed`, `agent.created|synced|sync-failed|started|stopped|failed` and
  `daemon.stopping`.
- `donn switch` is per project, with a default outside projects (`--default`, `--clear`); its
  state is `~/.donn/state.json` (`default`, `projects`). A switch from a terminal emits no daemon
  event.

## Decisions (and the alternatives rejected)

| Decided | Rejected | Why |
|---|---|---|
| The shell runs the installed `donn` for everything (`ui`, `status --watch`, `list`, `switch`, `agent run\|stop`, `daemon start`) | The webview drives the tray over Tauri IPC; Rust speaks the daemon's socket API | No protocol code in Rust and no Tauri code in the web app; the tray works with no window and with `daemon.ui: false`; parity with the CLI by construction |
| `donn status --watch --json`: a snapshot per line, on start, on daemon events and on `state.json` changes | The tray polls `status --json`; a new `donn events` command | One stream with the whole state is all a tray needs; a terminal switch shows up without a daemon change |
| Built from source in v1, ad-hoc signed; no CI artifacts | Signed and notarised in `release.yml` (Apple Developer ID); unsigned downloads | No Apple account yet; a local build carries no quarantine flag; downloads come with a later spec |
| A menu-bar app: no Dock icon, closing the window destroys it | A regular app with a tray; a tray off by default | The tray is the product; the window is "Open donn" |
| Start at login is opt-in, from the tray | Always; never in v1 | The daemon service (spec 16) already starts at login; the shell is a choice |
| Errors from tray actions in a native dialog (the CLI's `message` and `fix`) | Notifications | `26`'s non-goals: no notifications beyond the tray's state |

## 1. CLI additions

**`donn status --watch --json`.** `--watch` without `--json` is a usage error (it is for
programs). It prints compact JSON, one object per line:

- the same object `status --json` prints, plus `switched: { default?: <ref>, projects: { <project
  root>: <ref> } }` from `state.json` (`status --json` gains `switched` too);
- a first line at once; a new line after each daemon event and each change to `state.json`,
  debounced 250 ms, and only when the object differs from the last line printed;
- with no daemon running: a line with `daemon: false` (the registry's sessions, as `status` prints
  today), then a check every 5 s, and a full line when the daemon is up; it never starts the
  daemon;
- on `daemon.stopping` a final line with `daemon: false`, then the 5 s checks resume (so the tray
  follows a daemon restart); it exits on SIGTERM, SIGINT or a closed stdout (`EPIPE`), with 0.

**`donn ui --page <path>`.** Puts an app route before the sign-in fragment:
`http://127.0.0.1:<port><path>#t=<code>`. `<path>` must start with one `/` (not `//`) and carry
no `#`; otherwise a usage error. Default `/`.

**The app takes `?project=<path>`.** On load, a `project` search parameter picks that project (as
the picker does) and is removed from the address; the bridge still refuses a `cwd` it does not
know (`26` §2). "Open in donn" for an agent opens `/agents/a/<name>?project=<root>`.

`@getdonn/cli-schemas`' status schema gains `switched`; a changeset bumps `@getdonn/cli` (minor)
and `@getdonn/ui` rides along in the CLI's `dist/ui`.

## 2. The shell

`src/apps/desktop`, package `@getdonn/desktop` (`"private": true`, never published): Tauri 2.12
with the `tray-icon` feature and the autostart, single-instance, dialog and opener plugins. Its
`frontendDist` is one static page ("Connecting to donn…"); the window loads the bridge's URL.

- **`cli.rs`.** Finds `donn`: `$DONN_BIN` if set, else `$SHELL -lc 'command -v donn'` once at
  start (an app opened from Finder gets a bare `PATH`). Runs it with `std::process::Command`,
  never through a shell, adds `--json`, and parses stdout; a non-zero exit becomes the CLI's
  `{ error: { code, message, fix? } }`.
- **Version.** At start `donn --version` must be at least the release that ships §1 (the minimum
  is a constant in the shell). Too old or not found: the tray shows one disabled line ("donn CLI
  not found" / "donn CLI 0.x is too old for this app") and the install or update command, and
  nothing else but Quit.
- **`watch.rs`.** Keeps one `donn status --watch --json` child; reads lines; keeps the latest
  snapshot; restarts the child with backoff (1 s, doubling to 30 s) if it exits.
- **`tray.rs`.** Rebuilds the menu from each snapshot plus the personas (`donn list --json`, run
  in the home for the default and in each project's root for that project, again when a snapshot
  changes the set of projects or a session reports `session.refreshed`). `menu_model(snapshot,
  personas) -> Vec<MenuEntry>` is a pure function; the Tauri menu is built from its result.
- **`window.rs`.** Opens the window from `donn ui --no-open --json [--page …]`.

## 3. The tray

```
donn 0.13.2 · daemon running              (disabled; "daemon not running" + Start daemon when down)
Default persona: team/payments        ▸   ✓ the current; personas…; ─; Clear
─────────────
persona-ai · team/payments            ▸   a project with a live session; its harnesses below;
  claude, codex                            submenu: that project's personas; ─; Clear
─────────────
Agents
  smoke · running                     ▸   Stop · Open in donn
  kody · stopped                      ▸   Run · Open in donn
─────────────
Open donn                            ⌘O
Start at login                        ✓
Quit
```

- Projects listed are those with a running session; a project's line shows its switched persona,
  or the default when it has none. Agents are every created agent, with the state the snapshot
  gives.
- **Actions.** Default: `donn switch <ref> --default --json` (Clear: `--clear --default`) in the
  home. A project: `donn switch <ref> --json` (Clear: `--clear`) with that project's root as
  `cwd`. Agents: `donn agent run|stop <name> --json` in the agent's project. Start daemon: `donn
  daemon start --json`. On success nothing pops up: the next snapshot updates the tray (the full
  switch report is in the window, `17`). On failure a native dialog shows `message` and `fix`. A
  run from the tray has no shell environment, so `secret://env/…` refs fail as they do from the
  GUI (`26` §2, "Env secrets"), with the keychain fix.
- **Icon.** A monochrome template icon (on Linux a white one, see the amendments); its tooltip
  names the default persona. It gains a dot when a session is `stale` or failed to refresh, or an
  agent failed: the only state signal.
- Not in the tray: creating, building, deploying or publishing; editing. Those are in the window.

## 4. The window and the lifecycle

- **Open.** "Open donn" (and ⌘O while the menu is open) runs `donn ui --no-open --json` and loads
  `url` in the one window; "Open in donn" adds `--page`. A window already open is focused and, for
  "Open in donn", reloaded with the new URL. Every open is a fresh sign-in; the code is spent at
  once.
- **Close.** Closing destroys the window (the webview is freed); the bridge closes itself after
  ten minutes with no session (`26` §2). A second launch of the app opens or focuses the window
  (single instance).
- **Daemon stops.** The app shows its "ended" page (`ui.closing`); when a later snapshot shows the
  daemon up and the window is open, the shell reloads it with a fresh `donn ui` URL. The web app
  has no Tauri code.
- **Security.** No capability grants IPC to the bridge's URL, so the page cannot call the shell.
  The webview navigates only within `http://127.0.0.1:<port>`; any other link opens in the default
  browser (opener plugin). The shell never holds the session token: only the one-time code passes
  through its URL.
- **Quit** stops the shell; the daemon keeps running (it is a service, `16`).
- **macOS:** accessory activation policy (no Dock icon, no ⌘-Tab). **Linux:** AppIndicator; the
  menu opens on any click. Windows is a non-goal (`26`).
- **Start at login:** the autostart plugin (a LaunchAgent on macOS, an XDG autostart entry on
  Linux), off by default, toggled from the tray.

## 5. Build and distribution

- **Toolchain.** Rust 1.99, pinned in `src/apps/desktop/src-tauri/rust-toolchain.toml`;
  `@tauri-apps/cli` 2.12.4 as a dev dependency. Linux builds need `webkit2gtk-4.1` and
  `libayatana-appindicator3` (the package README lists them).
- **From source.** `pnpm --filter @getdonn/desktop bundle` runs `tauri build`: an ad-hoc-signed
  `donn.app` and `.dmg` on macOS, an AppImage and `.deb` on Linux. Install by copying the app to
  `/Applications`; a local build has no quarantine flag, so Gatekeeper does not warn.
- **Not in the release.** No `release.yml` change, no npm package, no GitHub Release asset. The
  default `turbo build` and `test` leave the Rust side out (the package's `build` and `test`
  scripts are no-ops; `bundle`, `rs:test` and `rs:check` are its own).
- **CI.** A `desktop` job on macOS and Ubuntu, when `src/apps/desktop/**`, `src/apps/cli/**` or
  the workflow changes: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` and
  `tauri build --no-bundle`.

## 6. Stack and testing

| Layer | Branch | Contents |
|---|---|---|
| 1 `cli` | `feature/desktop-1-cli` | `status --watch`, `switched`, `ui --page`, the app's `?project=`, the schema, the changeset |
| 2 `shell` | `feature/desktop-2-shell` | `src/apps/desktop`: `cli.rs`, `watch.rs`, `tray.rs`, `window.rs`, the Rust tests, the CI job |
| 3 `package` | `feature/desktop-3-package` | autostart, single instance, icons, the version check, the README and build docs; the "built" notes in `26`, `28` and `CLAUDE.md` |

- **CLI (vitest):** `--watch` without `--json` is a usage error; the first line; a new line after
  an event and after a `state.json` write; debounce and no repeat of an unchanged object; the no-
  daemon line and the switch to a full line when the daemon starts; `daemon.stopping` and a
  restart; exit on a closed stdout. `switched` in `status --json`. `--page` accepted and refused
  forms. Each `--watch` line parses with the status schema.
- **App (Playwright):** sign-in from a non-root page; `?project=` picks the project and leaves the
  address; the agent page opens from `/agents/a/<name>?project=<root>`.
- **Shell (cargo test):** `menu_model` from snapshot fixtures (no daemon, sessions in two projects,
  agents in each state, a stale session); the error shape to dialog text; the version check; the
  `command -v` output parse; the navigation allowlist. The fixtures are written by a CLI test from
  real `status --json` output, so the Rust tests cannot drift from the CLI.
- **Smoke before the final review** (the maintainer clicks; the session checks `donn status`, the
  daemon log and screenshots): build and install; the tray shows the daemon, the default persona
  and a live session; a switch from the tray, and `donn status` agrees; a switch from a terminal
  shows in the tray; run and stop an agent; "Open in donn" on an agent's page; stop and start the
  daemon with the window open; quit, relaunch, toggle start at login.

## Non-goals

Signed or notarised builds, CI artifacts and auto-update; Windows; notifications; creating,
deploying or editing from the tray; a bundled `donn` inside the app; any logic the CLI does not
have.

## Open questions

1. **Signed downloads.** A later spec: a Developer ID certificate, notarisation in `release.yml`,
   artifacts on the GitHub Release, and then the updater. Decide when the app has users beyond the
   maintainer.

*Amended 2026-10-27 (polish):* questions 2 to 6 (project lines, the Login Items name, fish, an
outdated daemon, sessions outside a project) are closed by the polish pass; see the amendments.

## Amendments from the build (2026-10-26)

- The lookup runs `$SHELL -ilc 'command -v donn; printf "PATH=%s\n" "$PATH"'`, an interactive
  login shell and not `-lc`, because `pnpm setup` writes PATH only to `~/.zshrc`. The app keeps
  that PATH and sets it on every `donn` it runs: an app opened from Finder has a bare PATH, and
  the npm or pnpm shim needs `node`. `DONN_BIN` keeps the app's own PATH. The lookup and
  `--version` are each bounded at 5 s.
- A CLI that does not answer `--version` (it fails, hangs or prints no version) gets its own tray
  line: "donn CLI did not answer --version — run donn doctor in a terminal". A broken CLI is not a
  missing one.
- "Open donn" with the window already open only focuses it and does not sign in again. "Open in
  donn" and a new window always sign in afresh. A stale sign-in result is dropped.
- Links: a `127.0.0.1` URL that is not the current bridge opens in the default browser (a local
  agent's URL), unless its fragment carries a one-time code (`#t=`, a stale sign-in): that one
  goes nowhere. A refused `donn ui` answer is reported without its URL.
- With the daemon down, agents in the tray have no Run or Stop, only "Open in donn" (its
  `donn ui` starts the daemon): without a daemon, `donn agent run` holds the agent in the CLI's
  foreground until a signal. A tray `donn list` is bounded at 10 s; a timeout lists nothing.
- The tray icon is a template image on macOS only. Linux panels do not tint it, so Linux gets a
  white variant (`icons/tray-light*.png`).
- `bundle.targets` is `app`, `dmg`, `appimage` and `deb` (`"all"` also built an `.rpm`).
- macOS: a second launch from Finder arrives as Reopen and opens the window, like the
  single-instance callback.
- `donn status --json` reports `switched.error` when `state.json` cannot be read, and still
  exits 0.

*Amended 2026-10-27 (polish):* the polish pass closed open questions 2 to 6. Shell only, no CLI
change.

- **Project lines** show what runs. A project's line reads `<folder> · <persona>`, where the
  persona is what its sessions run: `live`, else `launched`. Sessions on different personas list
  each one, distinct and sorted, joined with `, `. The submenu still ticks the project's switch.
  It opens with a disabled `switched: <ref>` or `switched: default`, so a next launch that
  differs from what runs shows. This replaces "its switched persona, or the default" in §3.
- **An outdated daemon.** The shell keeps the `donn --version` it reads at start. When the
  snapshot's `version` (the daemon's) is older than it, a disabled line goes under the header:
  `daemon <x> is older than the CLI <y> — donn daemon install`. The icon gets its dot. A
  prerelease counts lower than its release. Two prereleases of one release count as equal, and
  an unreadable version on either side shows nothing.
- **Sessions outside a project** (no `project`) share one disabled line, `no project ·
  <persona(s)>`, with the same live-else-launched rule and their harnesses beneath. It sits right
  after the default persona submenu, which is their switch, so it has no submenu.
- **fish.** The login shell is now asked `command -v donn; /usr/bin/env | /usr/bin/grep
  '^PATH='`, still a fixed string. fish joins `"$PATH"` with spaces, but the exported PATH is
  colon-joined in every shell. The app still takes the last `PATH=` line.
- **Login Items name.** tauri-plugin-autostart 2.7.0 (auto-launch 0.6.0) writes
  `AssociatedBundleIdentifiers` as an empty array and has no setting for it. After `enable()` the
  shell rewrites that array in `~/Library/LaunchAgents/dev.getdonn.desktop.plist` to
  `["dev.getdonn.desktop"]`. It edits the plugin's XML with a pure, tested function, writes the
  file aside and renames it. A plist of another shape is left alone, and a failure goes only to
  stderr, since start at login works without it. A plist written by an earlier build is fixed
  the next time start at login is turned on. Whether Login Items then names an ad-hoc-signed
  app is for the next smoke run.
- **The persona lists** (`donn list`) also run again when `switched.default` changes, when the
  daemon comes back (down to up), and every 60 s while the app runs. Each run is still bounded at
  10 s. The existing triggers stay: the sessions' projects or states change. The 60 s timer
  redraws the menu only when the lists changed it, and draws are serialised on the last
  snapshot.
- Fixtures: `no-project.json` (a session with no project beside one in a project) and
  `live.json` (a session whose live persona differs from the one it launched), written by the
  CLI test like the others.

### Smoke run

Run with the maintainer on macOS (arm64), 2026-10-26, on the bundle from `3b674d1`.

1. Finder launch from `/Applications` against the real home and the global CLI 0.13.2: the tray
   showed "donn CLI 0.13.2 is too old for this app — npm i -g @getdonn/cli@latest" and Quit. The
   template icon rendered correctly in the dark menu bar. The login-shell lookup, the PATH
   carry-over and the version gate work from Finder.
2. Against a temporary home (a throwaway local CLI 0.14.0 and the e2e fake eve): the menu matched
   section 3. It showed the header, the default submenu, three projects with harness lines
   (`api (a)` and `api (b)` told apart), `bot · created`, Open donn, Start at login and Quit. The
   dot badge showed for a stale and a refresh-failed session.
3. A tray switch of the default and of a project: `donn status` and `state.json` agreed. A switch
   from a terminal showed in the tray. A project with no switch showed the default.
4. Tray Run and Stop of an agent: the daemon log showed running, then stopped 11 s later. "Open in
   donn" opened the agent page in the right project, signed in.
5. With the daemon stopped and the window open: the page ended and the tray showed `daemon not
   running` and Start daemon. Start daemon reloaded the window, signed in by itself, on a new
   bridge port.
6. Start at login on: `~/Library/LaunchAgents/dev.getdonn.desktop.plist` (`RunAtLoad`), with no
   clash with the daemon's `dev.getdonn.daemon.plist`. Off: the file is removed.
7. Quit stops the app and its watch child, also when the terminal that started it closes. The
   daemon keeps running. A second launch exits and opens the window in the running instance.
