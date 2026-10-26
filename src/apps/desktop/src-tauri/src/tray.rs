//! The tray (spec 28 §3): the Tauri menu drawn from `menu_model`, the icon and
//! its tooltip, and the menu's actions, each a `donn` call off the main thread.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::cli::{CliFailure, Donn};
use crate::menu::{self, Action, Entry, action_args, action_for, badge, menu_model};
use crate::snapshot::{Personas, Snapshot};
use crate::window;

const TRAY: &str = "donn";

/// The tray's state: the CLI once located, what is drawn, the persona lists.
#[derive(Default)]
struct Tray {
    donn: Mutex<Option<Donn>>,
    shown: Mutex<Shown>,
    lists: Mutex<Lists>,
}

/// The menu and icon as last drawn; menu events resolve ids against `entries`.
#[derive(Default)]
struct Shown {
    entries: Vec<Entry>,
    badge: bool,
}

/// `donn list` for the default and per session project, and what they were for.
#[derive(Default)]
struct Lists {
    key: Option<ListKey>,
    default: Personas,
    projects: BTreeMap<String, Personas>,
}

/// Adds the tray with `donn · connecting…` and Quit until a snapshot arrives.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    app.manage(Tray::default());
    let mut tray = TrayIconBuilder::with_id(TRAY)
        .tooltip("donn")
        .icon_as_template(true)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()));
    if let Some(icon) = icon(app, false) {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    show(app, notice("donn · connecting…"), false, "donn".into());
    Ok(())
}

/// The CLI was found: actions and lists run it.
pub fn set_donn(app: &AppHandle, donn: Donn) {
    *app.state::<Tray>().donn.lock().unwrap() = Some(donn);
}

/// The located CLI, once `set_donn` has run.
pub fn donn(app: &AppHandle) -> Option<Donn> {
    app.try_state::<Tray>()?.donn.lock().unwrap().clone()
}

/// No CLI: one disabled line and Quit.
pub fn cli_missing(app: &AppHandle) {
    show(app, notice("donn CLI not found"), false, "donn".into());
}

/// Draws a snapshot. Runs on the watch thread: the lists may run `donn list`.
pub fn rebuild(app: &AppHandle, s: &Snapshot) {
    let state = app.state::<Tray>();
    let Some(donn) = state.donn.lock().unwrap().clone() else {
        return;
    };
    let (default, projects) = lists(&state.lists, &donn, s);
    let entries = menu_model(s, &default, &projects, canon, false);
    show(app, entries, badge(s), tooltip(s));
}

/// The persona lists, run again only when the sessions' projects or states change.
fn lists(
    lists: &Mutex<Lists>,
    donn: &Donn,
    s: &Snapshot,
) -> (Personas, BTreeMap<String, Personas>) {
    let key = list_key(s);
    let mut l = lists.lock().unwrap();
    if l.key.as_ref() != Some(&key) {
        l.default = list(donn, &home());
        let projects: BTreeSet<&str> = s
            .sessions
            .iter()
            .filter_map(|x| x.project.as_deref())
            .collect();
        l.projects = projects
            .into_iter()
            .map(|p| (p.to_owned(), list(donn, &menu::root(p))))
            .collect();
        l.key = Some(key);
    }
    (l.default.clone(), l.projects.clone())
}

/// `donn list` in `cwd`; a failure lists nothing (the menu says `no personas`).
fn list(donn: &Donn, cwd: &Path) -> Personas {
    donn.run(&["list"], cwd)
        .ok()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// Draws on the main thread, where menu events are also handled.
fn show(app: &AppHandle, entries: Vec<Entry>, badge: bool, tooltip: String) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = handle.state::<Tray>();
        let mut shown = state.shown.lock().unwrap();
        let Some(tray) = handle.tray_by_id(TRAY) else {
            return;
        };
        if shown.badge != badge {
            let _ = tray.set_icon_with_as_template(icon(&handle, badge), true);
        }
        *shown = Shown { entries, badge };
        let _ = tray.set_tooltip(Some(tooltip));
        draw(&handle, &shown.entries);
    });
}

/// Sets the tray's menu from the model.
fn draw(app: &AppHandle, entries: &[Entry]) {
    if let Ok(menu) = build(app, entries)
        && let Some(tray) = app.tray_by_id(TRAY)
    {
        let _ = tray.set_menu(Some(menu));
    }
}

/// The tray icon with the dot or without. Both are the app icon until the
/// template icons land (spec 28 §5); only the two images change then.
fn icon(app: &AppHandle, badge: bool) -> Option<Image<'static>> {
    let plain = app.default_window_icon()?.clone().to_owned();
    let dotted = plain.clone();
    Some(if badge { dotted } else { plain })
}

/// The Tauri menu for the model.
fn build(app: &AppHandle, entries: &[Entry]) -> tauri::Result<Menu<Wry>> {
    let items = items(app, entries)?;
    Menu::with_items(app, &refs(&items))
}

type Item = Box<dyn IsMenuItem<Wry>>;

fn refs(items: &[Item]) -> Vec<&dyn IsMenuItem<Wry>> {
    items.iter().map(|i| i.as_ref()).collect()
}

fn items(app: &AppHandle, entries: &[Entry]) -> tauri::Result<Vec<Item>> {
    entries
        .iter()
        .map(|e| -> tauri::Result<Item> {
            Ok(match e {
                Entry::Label(l) => Box::new(MenuItem::new(app, text(l), false, None::<&str>)?),
                Entry::Separator => Box::new(PredefinedMenuItem::separator(app)?),
                Entry::Item {
                    id,
                    label,
                    checked: Some(on),
                    ..
                } => Box::new(CheckMenuItem::with_id(
                    app,
                    id,
                    text(label),
                    true,
                    *on,
                    None::<&str>,
                )?),
                Entry::Item { id, label, .. } => {
                    // ⌘O while the menu is open (spec 28 §4).
                    let key = (id == "open").then_some("CmdOrCtrl+O");
                    Box::new(MenuItem::with_id(app, id, text(label), true, key)?)
                }
                Entry::Submenu { label, entries } => {
                    let inner = items(app, entries)?;
                    Box::new(Submenu::with_items(app, text(label), true, &refs(&inner))?)
                }
            })
        })
        .collect()
}

/// A menu event (main thread).
fn on_menu(app: &AppHandle, id: &str) {
    let state = app.state::<Tray>();
    let action = {
        let shown = state.shown.lock().unwrap();
        // A check item ticks itself when clicked: draw the model again.
        draw(app, &shown.entries);
        action_for(&shown.entries, id)
    };
    match action {
        None => {}
        Some(Action::Quit) => app.exit(0),
        Some(Action::Open) => window::open(app, None),
        Some(Action::OpenAgent { project, name }) => {
            window::open(app, Some(window::agent_page(&project, &name)));
        }
        // Start at login is not built yet (spec 28 §4).
        Some(Action::ToggleLogin) => {}
        Some(action) => run(app, &action),
    }
}

/// Runs an action's `donn` call on its own thread; a failure is a dialog.
fn run(app: &AppHandle, action: &Action) {
    let Some(donn) = app.state::<Tray>().donn.lock().unwrap().clone() else {
        return;
    };
    let (args, cwd) = action_args(action);
    if args.is_empty() {
        return;
    }
    let cwd = cwd.unwrap_or_else(home);
    let app = app.clone();
    std::thread::spawn(move || {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        if let Err(failure) = donn.run(&args, &cwd) {
            alert(&app, failure_text(&failure));
        }
    });
}

/// The "donn" error dialog. Non-blocking: `blocking_show` must not run on the
/// main thread.
pub fn alert(app: &AppHandle, text: String) {
    app.dialog()
        .message(text)
        .kind(MessageDialogKind::Error)
        .title("donn")
        .show(|_| {});
}

/// A disabled line and Quit.
fn notice(line: &str) -> Vec<Entry> {
    vec![
        Entry::Label(line.into()),
        Entry::Item {
            id: "quit".into(),
            label: "Quit".into(),
            action: Action::Quit,
            checked: None,
        },
    ]
}

/// realpath, or the path as given.
fn canon(p: &str) -> String {
    std::fs::canonicalize(p).map_or_else(|_| p.to_owned(), |c| c.display().to_string())
}

pub fn home() -> PathBuf {
    home_from(std::env::var("HOME").ok())
}

/// The home directory from `$HOME`; `/` without one.
fn home_from(var: Option<String>) -> PathBuf {
    PathBuf::from(var.filter(|h| !h.is_empty()).unwrap_or_else(|| "/".into()))
}

/// The tooltip: `donn · <default persona>`, or `donn` with none.
fn tooltip(s: &Snapshot) -> String {
    match &s.switched.default {
        Some(r) => format!("donn · {r}"),
        None => "donn".into(),
    }
}

/// A failed action's dialog: the CLI's `message`, then its `fix`.
pub fn failure_text(f: &CliFailure) -> String {
    match &f.fix {
        Some(fix) => format!("{}\n\n{fix}", f.message),
        None => f.message.clone(),
    }
}

/// A menu label as muda reads it: `&` marks a mnemonic, `&&` is one `&`.
fn text(s: &str) -> String {
    s.replace('&', "&&")
}

/// What the persona lists depend on: each session's project and state.
type ListKey = Vec<(Option<String>, Option<String>)>;

fn list_key(s: &Snapshot) -> ListKey {
    let mut key: ListKey = s
        .sessions
        .iter()
        .map(|x| (x.project.clone(), x.state.clone()))
        .collect();
    key.sort();
    key
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::path::Path;

    fn read<T: for<'de> Deserialize<'de>>(name: &str) -> T {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn tooltip_names_the_default() {
        let mut s: Snapshot = read("two-projects.json");
        s.switched.default = Some("team/payments".into());
        assert_eq!(tooltip(&s), "donn · team/payments");
        s.switched.default = None;
        assert_eq!(tooltip(&s), "donn");
    }

    #[test]
    fn failure_text_adds_the_fix() {
        let mut f = CliFailure {
            code: "store".into(),
            message: "no persona team/x".into(),
            fix: Some("donn list".into()),
        };
        assert_eq!(failure_text(&f), "no persona team/x\n\ndonn list");
        f.fix = None;
        assert_eq!(failure_text(&f), "no persona team/x");
    }

    #[test]
    fn labels_keep_ampersands() {
        assert_eq!(text("R&D · team/a&b"), "R&&D · team/a&&b");
        assert_eq!(text("plain"), "plain");
    }

    #[test]
    fn home_falls_back_to_root() {
        assert_eq!(
            home_from(Some("/Users/me".into())),
            PathBuf::from("/Users/me")
        );
        assert_eq!(home_from(Some(String::new())), PathBuf::from("/"));
        assert_eq!(home_from(None), PathBuf::from("/"));
    }

    #[test]
    fn lists_rerun_on_projects_or_state() {
        let s: Snapshot = read("two-projects.json");
        let key = list_key(&s);
        assert!(!key.is_empty());

        let mut reordered = s.clone();
        reordered.sessions.reverse();
        reordered.agents.clear();
        reordered.switched.default = Some("other".into());
        assert_eq!(
            list_key(&reordered),
            key,
            "order and other fields: no rerun"
        );

        let mut state = s.clone();
        state.sessions[0].state = Some("refresh-failed".into());
        assert_ne!(list_key(&state), key, "a state change reruns");

        let mut gone = s.clone();
        gone.sessions.retain(|x| x.project != s.sessions[0].project);
        assert_ne!(list_key(&gone), key, "a project leaving reruns");
    }
}
