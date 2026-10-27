//! The donn menu-bar shell (spec 28 §2). It has no logic of its own: every
//! read and every action is a `donn` command. The window is created from
//! Rust (`window.rs`).

pub mod cli;
pub mod menu;
pub mod snapshot;
pub mod tray;
pub mod watch;
pub mod window;

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, RunEvent, Wry};

use crate::cli::CliProblem;

/// The bundle identifier (`tauri.conf.json`), also the LaunchAgent's name.
pub(crate) const APP_ID: &str = "dev.getdonn.desktop";

pub fn run() {
    tauri::Builder::default()
        // First, as the plugin's docs require: a second launch lands here and
        // opens or focuses the window (spec 28 §4).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::open(app, None);
        }))
        // Start at login, off until toggled from the tray (spec 28 §4).
        .plugin(autostart())
        .plugin(tauri_plugin_dialog::init())
        // Links are opened from Rust; no script is injected into the bridge's
        // pages, which have no IPC anyway (spec 28 §4).
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .setup(|app| {
            // A menu-bar app: no Dock icon, no ⌘-Tab (spec 28 §4).
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle = app.handle().clone();
            tray::install(&handle)?;
            window::install(&handle);
            quit_on_signals(&handle)?;
            // Locating `donn` asks a login shell (up to 5 s): not on the main thread.
            std::thread::spawn(move || connect(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the donn shell")
        .run(|app, event| match event {
            // Closing the window leaves the tray running; `app.exit(0)` (Quit,
            // signals) carries a code and still exits (spec 28 §4).
            RunEvent::ExitRequested {
                code: None, api, ..
            } => api.prevent_exit(),
            RunEvent::Exit => watch::stop(app),
            // macOS: opening the running app again (Finder, `open -a`) is a
            // reopen, not a second instance (spec 28 §4).
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => window::open(app, None),
            _ => {}
        });
}

/// Finds `donn`, checks its version and follows `status --watch`; a missing
/// or old CLI is all the tray shows, and nothing is watched (spec 28 §2).
fn connect(app: AppHandle) {
    match usable_cli() {
        Ok((donn, version)) => {
            tray::set_donn(&app, donn.clone(), version);
            let handle = app.clone();
            watch::start(app, donn, move |s| {
                tray::rebuild(&handle, &s);
                window::on_snapshot(&handle, &s);
            });
        }
        Err(problem) => tray::cli_problem(&app, &problem),
    }
}

/// The located CLI and its version when `donn --version` is at least
/// `MIN_CLI`. Why it is not goes to stderr (the menu has only the fix).
fn usable_cli() -> Result<(cli::Donn, String), CliProblem> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let donn = cli::locate(std::env::var("DONN_BIN").ok().as_deref(), &shell).map_err(|e| {
        eprintln!("donn: CLI not found: {e}");
        CliProblem::NotFound
    })?;
    let version = donn.version().map_err(|e| {
        eprintln!("donn: CLI not usable: {e}");
        CliProblem::Broken
    })?;
    let bin = donn.bin().display();
    match cli::version_problem(&version) {
        Some(CliProblem::Broken) => {
            eprintln!("donn: CLI not usable: {bin} --version printed {version:?}");
            Err(CliProblem::Broken)
        }
        Some(problem) => {
            eprintln!("donn: CLI {version} at {bin} is older than the app needs");
            Err(problem)
        }
        None => Ok((donn, version)),
    }
}

/// The autostart plugin: a LaunchAgent on macOS (`~/Library/LaunchAgents/
/// dev.getdonn.desktop.plist`), an XDG autostart entry on Linux.
fn autostart() -> TauriPlugin<Wry> {
    let builder = tauri_plugin_autostart::Builder::new();
    #[cfg(target_os = "macos")]
    let builder = builder
        .macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent)
        .app_name(APP_ID);
    builder.build()
}

/// SIGTERM, SIGINT and SIGHUP exit through the event loop, so `RunEvent::Exit`
/// stops the watch child too (spec 28 §4: Quit leaves no `donn` behind).
fn quit_on_signals(app: &AppHandle) -> std::io::Result<()> {
    use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
    let mut signals = signal_hook::iterator::Signals::new([SIGTERM, SIGINT, SIGHUP])?;
    let app = app.clone();
    std::thread::spawn(move || {
        if signals.forever().next().is_some() {
            app.exit(0);
        }
    });
    Ok(())
}
