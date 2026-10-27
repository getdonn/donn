//! The donn menu-bar shell (spec 28 §2). It has no logic of its own: every
//! read and every action is a `donn` command. The window is created from
//! Rust (`window.rs`).

pub mod cli;
pub mod menu;
pub mod snapshot;
pub mod tray;
pub mod watch;
pub mod window;

use tauri::{AppHandle, RunEvent};

pub fn run() {
    tauri::Builder::default()
        // First, as the plugin's docs require: a second launch lands here and
        // opens or focuses the window (spec 28 §4).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::open(app, None);
        }))
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

/// Finds `donn` and follows `status --watch`; without it, the tray says so.
fn connect(app: AppHandle) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    match cli::locate(std::env::var("DONN_BIN").ok().as_deref(), &shell) {
        Ok(donn) => {
            tray::set_donn(&app, donn.clone());
            let handle = app.clone();
            watch::start(app, donn, move |s| {
                tray::rebuild(&handle, &s);
                window::on_snapshot(&handle, &s);
            });
        }
        Err(_) => tray::cli_missing(&app),
    }
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
