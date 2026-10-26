//! The donn menu-bar shell (spec 28 §2). It has no logic of its own: every
//! read and every action is a `donn` command. Windows are created from Rust.

pub mod cli;
pub mod menu;
pub mod snapshot;

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
            #[cfg(not(target_os = "macos"))]
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the donn shell");
}
