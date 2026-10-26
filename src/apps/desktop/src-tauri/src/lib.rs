//! The donn menu-bar shell (spec 28 §2). It has no logic of its own: every
//! read and every action is a `donn` command. Windows are created from Rust.

pub mod cli;
pub mod menu;
pub mod snapshot;
pub mod tray;
pub mod watch;

use tauri::{AppHandle, RunEvent};

pub fn run() {
    tauri::Builder::default()
        // First, as the plugin's docs require: a second launch lands here.
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
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
            quit_on_signals(&handle)?;
            // Locating `donn` asks a login shell (up to 5 s): not on the main thread.
            std::thread::spawn(move || connect(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the donn shell")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                watch::stop(app);
            }
        });
}

/// Finds `donn` and follows `status --watch`; without it, the tray says so.
fn connect(app: AppHandle) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    match cli::locate(std::env::var("DONN_BIN").ok().as_deref(), &shell) {
        Ok(donn) => {
            tray::set_donn(&app, donn.clone());
            let handle = app.clone();
            watch::start(app, donn, move |s| tray::rebuild(&handle, &s));
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
