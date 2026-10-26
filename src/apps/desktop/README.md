# @getdonn/desktop

donn in the menu bar: the default persona and each live session's persona at a
glance, a switcher, the created agents with run and stop, and "Open donn" for
the web app in a window. A Tauri 2 shell with no logic of its own: every read
and every action runs the installed `donn` CLI with `--json`. The design is
`docs/planning/28-desktop.md`.

This package is private and never published: you build the app from source.
macOS and Linux; Windows is not supported.

## Prerequisites

- The donn CLI, 0.14.0 or later: `npm i -g @getdonn/cli`. The app does not
  bundle it; with no CLI, or an older one, the tray shows the install command
  and Quit.
- Rust via [rustup](https://rustup.rs). The toolchain is pinned in
  `src-tauri/rust-toolchain.toml`; rustup installs it on the first build.
- The repo's dependencies: `pnpm install` at the root (it brings
  `@tauri-apps/cli`).
- macOS: the Xcode command line tools (`xcode-select --install`).
- Linux: `webkit2gtk-4.1` and `libayatana-appindicator3`, with their
  development headers. On Debian or Ubuntu:

  ```sh
  sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
    build-essential curl wget file libssl-dev librsvg2-dev
  ```

## Build

```sh
pnpm --filter @getdonn/desktop bundle
```

It runs `tauri build` and writes, under `src/apps/desktop/src-tauri/target/release/bundle/`:

| OS    | Output                                                                        |
| ----- | ----------------------------------------------------------------------------- |
| macOS | `macos/donn.app` and `dmg/donn_<version>_<arch>.dmg`, signed ad hoc           |
| Linux | `appimage/donn_<version>_<arch>.AppImage` and `deb/donn_<version>_<arch>.deb` |

The repo's `turbo build` and `test` leave the Rust side out. To work on it:
`pnpm --filter @getdonn/desktop rs:test` (`cargo test`) and `rs:check` (`cargo
fmt --check` and `cargo clippy -D warnings`).

## Install

macOS: copy `donn.app` to `/Applications` (or open the `.dmg` and drag it
there), then open it. A build from your own machine carries no quarantine
flag, so Gatekeeper does not warn. The app has no Dock icon: look for the d in
the menu bar.

Linux: run the AppImage, or `sudo apt install ./donn_<version>_<arch>.deb`.

## How it finds `donn`

An app opened from Finder or at login gets a bare `PATH`, so at start the app
asks your interactive login shell (`$SHELL -ilc`) where `donn` is and takes
that shell's `PATH` for every `donn` it runs (`donn` is a Node script and needs
`node` on it). If your shell config only sets `PATH` for some shells, make sure
an interactive login shell sees it.

`DONN_BIN` overrides the lookup, for development: the path of an executable
`donn` to run, with the app's own `PATH`. It must pass the same version check.
For example, against this checkout's CLI:

```sh
pnpm --filter @getdonn/cli build
chmod +x src/apps/cli/dist/bin.js
DONN_BIN="$PWD/src/apps/cli/dist/bin.js" \
  src/apps/desktop/src-tauri/target/release/bundle/macos/donn.app/Contents/MacOS/donn-desktop
```

When the CLI cannot be used, the reason is printed on the app's stderr (run
the binary from a terminal, as above, to see it).

## Using it

- **Quit** stops the app only. The daemon keeps running: it is a service of
  its own (`donn daemon install`, `docs/planning/16-daemon-service.md`).
- **Start at login** is off by default; toggle it in the menu. On macOS it is
  a LaunchAgent, `~/Library/LaunchAgents/dev.getdonn.desktop.plist`, that
  starts the app where it was when you turned it on, so turn it on after
  copying the app to `/Applications`. On Linux it is an XDG autostart entry.
- Opening the app again while it runs opens or focuses the window.
- A run from the tray has no shell environment, so `secret://env/...` refs
  fail as they do from the web app: use the `keychain` provider for those.

## Icons

The sources are SVG, in `src-tauri/icons/source/`. To regenerate on macOS:

```sh
cd src/apps/desktop/src-tauri/icons
sips -s format png source/app-icon.svg --out source/app-icon.png
pnpm exec tauri icon source/app-icon.png -o <scratch dir>
# copy 32x32, 64x64, 128x128, 128x128@2x, icon.png, icon.icns and icon.ico here
sips -s format png source/tray-template.svg --out tray-template.png
sips -s format png source/tray-template-badge.svg --out tray-template-badge.png
```

The `@2x` tray images are the same SVGs with `width` and `height` set to 44.
The tray icons are template images: black on transparent, which macOS tints
for a light or dark menu bar.
