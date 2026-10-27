//! The tray (spec 28 §3): the Tauri menu drawn from `menu_model`, the icon and
//! its tooltip, and the menu's actions, each a `donn` call off the main thread.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::cli::{CliFailure, CliProblem, Donn};
use crate::menu::{
    self, Action, Entry, action_args, action_for, badge, cli_problem_menu, menu_model,
};
use crate::snapshot::{Personas, Snapshot};
use crate::window;

const TRAY: &str = "donn";

/// How long one `donn list` may take: a hung one must not hold up the menu.
const LIST_TIMEOUT: Duration = Duration::from_secs(10);

/// The tray's state: the CLI once located and its `--version`, what is drawn,
/// the persona lists.
#[derive(Default)]
struct Tray {
    donn: Mutex<Option<Donn>>,
    cli_version: Mutex<Option<String>>,
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
    TrayIconBuilder::with_id(TRAY)
        .icon(icon(false))
        .icon_as_template(TEMPLATE)
        .tooltip("donn")
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .build(app)?;
    show(app, notice("donn · connecting…"), false, "donn".into());
    Ok(())
}

/// The CLI was found: actions and lists run it; its version (`--version`
/// output) tells an outdated daemon.
pub fn set_donn(app: &AppHandle, donn: Donn, version: String) {
    let state = app.state::<Tray>();
    *state.donn.lock().unwrap() = Some(donn);
    *state.cli_version.lock().unwrap() = Some(version);
}

/// The located CLI, once `set_donn` has run.
pub fn donn(app: &AppHandle) -> Option<Donn> {
    app.try_state::<Tray>()?.donn.lock().unwrap().clone()
}

/// A missing or old CLI: its line and Quit, nothing else (spec 28 §2).
pub fn cli_problem(app: &AppHandle, problem: &CliProblem) {
    show(app, cli_problem_menu(problem), false, "donn".into());
}

/// Draws a snapshot. Runs on the watch thread: the lists may run `donn list`.
pub fn rebuild(app: &AppHandle, s: &Snapshot) {
    let state = app.state::<Tray>();
    let Some(donn) = state.donn.lock().unwrap().clone() else {
        return;
    };
    let (default, projects) = lists(&state.lists, &donn, s);
    let version = state.cli_version.lock().unwrap().clone();
    let version = version.as_deref();
    let entries = menu_model(s, &default, &projects, version, canon, login(app));
    show(app, entries, badge(s, version), tooltip(s));
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

/// `donn list` in `cwd`, bounded by `LIST_TIMEOUT`; a failure or a timeout
/// lists nothing (the menu says `no personas`).
fn list(donn: &Donn, cwd: &Path) -> Personas {
    donn.run_with_timeout(&["list"], cwd, LIST_TIMEOUT)
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
            let _ = tray.set_icon_with_as_template(Some(icon(badge)), TEMPLATE);
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

/// The tray icon, the d, with the dot or without (spec 28 §3). macOS: a
/// template image (black, tinted to the menu bar) drawn 18 pt high, so the @2x
/// image is sharp on a Retina display. Linux panels do not tint and are mostly
/// dark: a white d, 22 px.
fn icon(badge: bool) -> Image<'static> {
    #[cfg(target_os = "macos")]
    let (plain, dotted) = (
        tauri::include_image!("icons/tray-template@2x.png"),
        tauri::include_image!("icons/tray-template-badge@2x.png"),
    );
    #[cfg(not(target_os = "macos"))]
    let (plain, dotted) = (
        tauri::include_image!("icons/tray-light.png"),
        tauri::include_image!("icons/tray-light-badge.png"),
    );
    if badge { dotted } else { plain }
}

/// Whether the icon is a template image: on macOS only.
const TEMPLATE: bool = cfg!(target_os = "macos");

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
        Some(Action::ToggleLogin) => toggle_login(app),
        Some(action) => run(app, &action),
    }
}

/// Whether start at login is on: the autostart plugin's answer, off on error.
fn login(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Start at login on or off (spec 28 §4; quick: one LaunchAgent file), then
/// the check drawn from what the plugin says, so a failure leaves it as it was.
fn toggle_login(app: &AppHandle) {
    let autolaunch = app.autolaunch();
    let result = if login(app) {
        autolaunch.disable()
    } else {
        autolaunch.enable().inspect(|()| name_login_item())
    };
    if let Err(e) = result {
        alert(app, format!("Could not change start at login: {e}"));
    }
    let state = app.state::<Tray>();
    let mut shown = state.shown.lock().unwrap();
    menu::set_checked(&mut shown.entries, "login", login(app));
    draw(app, &shown.entries);
}

/// macOS: names the app in the LaunchAgent the plugin just wrote, so Login
/// Items shows donn (spec 28 open question 3). The plugin writes an empty
/// `AssociatedBundleIdentifiers` and cannot set it. A failure only goes to
/// stderr: start at login works without it.
fn name_login_item() {
    #[cfg(target_os = "macos")]
    {
        let file = home()
            .join("Library/LaunchAgents")
            .join(format!("{}.plist", crate::APP_ID));
        let rewrite = || -> std::io::Result<()> {
            let text = std::fs::read_to_string(&file)?;
            match with_bundle_id(&text, crate::APP_ID) {
                Some(named) if named != text => {
                    // Written aside and renamed: launchd never reads half a file.
                    let tmp = file.with_extension("plist.tmp");
                    std::fs::write(&tmp, named)?;
                    std::fs::rename(&tmp, &file)
                }
                Some(_) => Ok(()),
                None => Err(std::io::Error::other(
                    "no AssociatedBundleIdentifiers array",
                )),
            }
        };
        if let Err(e) = rewrite() {
            eprintln!(
                "donn: could not name the login item in {}: {e}",
                file.display()
            );
        }
    }
}

/// The LaunchAgent plist with `AssociatedBundleIdentifiers` set to `[id]`;
/// `None` when the key is not followed by one array.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn with_bundle_id(plist: &str, id: &str) -> Option<String> {
    const KEY: &str = "<key>AssociatedBundleIdentifiers</key>";
    let after = plist.find(KEY)? + KEY.len();
    let start = after + plist[after..].len() - plist[after..].trim_start().len();
    let tail = &plist[start..];
    let len = if tail.starts_with("<array/>") {
        "<array/>".len()
    } else {
        let inner = tail.strip_prefix("<array>")?;
        let close = inner.find("</array>")?;
        if inner[..close].contains("<array") {
            return None;
        }
        "<array>".len() + close + "</array>".len()
    };
    Some(format!(
        "{}<array><string>{id}</string></array>{}",
        &plist[..start],
        &tail[len..]
    ))
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
    fn linux_icons_are_white_on_transparent() {
        let light = [
            tauri::include_image!("icons/tray-light.png"),
            tauri::include_image!("icons/tray-light-badge.png"),
        ];
        for image in light {
            assert_eq!((image.width(), image.height()), (22, 22));
            let px: Vec<_> = image.rgba().chunks(4).collect();
            assert!(px.iter().any(|p| p[3] == 0), "transparent background");
            assert!(
                px.iter()
                    .filter(|p| p[3] > 128)
                    .all(|p| p[..3] == [255, 255, 255]),
                "a white d"
            );
        }
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

    /// The LaunchAgent as tauri-plugin-autostart 2.7.0 (auto-launch 0.6.0) writes it.
    const PLUGIN_PLIST: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
  <dict>
  <key>Label</key>
  <string>dev.getdonn.desktop</string>
  <key>AssociatedBundleIdentifiers</key>
  <array></array>
  <key>ProgramArguments</key>
  <array><string>/Applications/donn.app/Contents/MacOS/donn-desktop</string></array>
  <key>RunAtLoad</key>
  <true/>
  </dict>
</plist>";

    #[test]
    fn login_item_names_the_app() {
        let id = "dev.getdonn.desktop";
        let named = with_bundle_id(PLUGIN_PLIST, id).unwrap();
        assert_eq!(
            named,
            PLUGIN_PLIST.replace(
                "<key>AssociatedBundleIdentifiers</key>\n  <array></array>",
                "<key>AssociatedBundleIdentifiers</key>\n  \
                 <array><string>dev.getdonn.desktop</string></array>",
            )
        );
        assert!(named.contains("<array><string>/Applications/donn.app/"));
        // Again: no change.
        assert_eq!(with_bundle_id(&named, id).unwrap(), named);
        // An empty `<array/>`, and another id, are replaced the same way.
        let short = PLUGIN_PLIST.replace("<array></array>", "<array/>");
        assert_eq!(with_bundle_id(&short, id).unwrap(), named);
        let other = PLUGIN_PLIST.replace("<array></array>", "<array><string>x.y</string></array>");
        assert_eq!(with_bundle_id(&other, id).unwrap(), named);
        // Not the plugin's shape: left alone.
        assert_eq!(with_bundle_id("<plist><dict/></plist>", id), None);
        let open = PLUGIN_PLIST.replace("<array></array>", "<array>");
        assert_eq!(with_bundle_id(&open, id), None, "an unclosed array");
        let cut = &open[..open.find("<key>ProgramArguments").unwrap()];
        assert_eq!(with_bundle_id(cut, id), None);
        let odd = PLUGIN_PLIST.replace("<array></array>", "<string>x</string>");
        assert_eq!(with_bundle_id(&odd, id), None);
    }

    #[test]
    fn app_id_is_the_bundle_identifier() {
        let conf = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let conf: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(conf).unwrap()).unwrap();
        assert_eq!(conf["identifier"], crate::APP_ID);
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
