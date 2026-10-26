//! The window (spec 28 §4): the donn web app from the daemon's loopback
//! bridge. One window, created on demand and signed in by a fresh `donn ui`;
//! it navigates only within the bridge and hands other links to the browser.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU16, Ordering};

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::Value;
use tauri::webview::{NewWindowResponse, WebviewWindow, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, Url, WebviewUrl};
use tauri_plugin_opener::OpenerExt;

use crate::cli::CliFailure;
use crate::snapshot::Snapshot;
use crate::tray;

const LABEL: &str = "main";

/// Everything but RFC 3986's unreserved characters is encoded.
const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// The window's state: the bridge's port, which `on_navigation` reads (a
/// daemon restart moves it), and the sign-ins.
#[derive(Default)]
struct Shell {
    port: Arc<AtomicU16>,
    track: Mutex<Track>,
}

/// The daemon as last known (snapshots, or a `donn ui` that answered, which
/// starts it) and the `donn ui` sign-ins: the newest, and how many run.
#[derive(Default)]
struct Track {
    daemon: Option<bool>,
    latest: u64,
    running: u32,
}

impl Track {
    fn up(&self) -> bool {
        self.daemon == Some(true)
    }

    /// A snapshot. True: the daemon is back after being down, and no sign-in
    /// that would load a fresh URL anyway is running.
    fn snapshot(&mut self, up: bool) -> bool {
        let before = self.daemon.replace(up);
        before == Some(false) && up && self.running == 0
    }

    /// A sign-in starts; its number.
    fn begin(&mut self) -> u64 {
        self.latest += 1;
        self.running += 1;
        self.latest
    }

    /// A sign-in ended (`ok`: `donn ui` answered, so the daemon is up). True:
    /// it is the newest; an older one's result is dropped.
    fn finish(&mut self, seq: u64, ok: bool) -> bool {
        self.running = self.running.saturating_sub(1);
        if ok {
            self.daemon = Some(true);
        }
        self.is_latest(seq)
    }

    fn is_latest(&self, seq: u64) -> bool {
        seq == self.latest
    }
}

/// Where a navigation goes.
#[derive(Debug, PartialEq, Eq)]
enum Nav {
    /// The bridge: the webview loads it.
    Load,
    /// Another `http(s)` URL, not on `127.0.0.1`: the default browser.
    Browser,
    /// Anything else (`file:`, `javascript:`, `about:`, a stale bridge URL
    /// with its one-time code): nowhere.
    Deny,
}

/// Whether the webview may load `url`: the bridge, `http://127.0.0.1:<port>`.
pub fn allowed_navigation(url: &Url, port: u16) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() == Some(port)
}

/// The agent page for `--page`: `/agents/a/<name>?project=<project>`.
pub fn agent_page(project: &str, name: &str) -> String {
    format!(
        "/agents/a/{}?project={}",
        utf8_percent_encode(name, COMPONENT),
        utf8_percent_encode(project, COMPONENT)
    )
}

fn route(url: &Url, port: u16) -> Nav {
    if allowed_navigation(url, port) {
        Nav::Load
    } else if matches!(url.scheme(), "http" | "https") && url.host_str() != Some("127.0.0.1") {
        Nav::Browser
    } else {
        Nav::Deny
    }
}

/// `donn ui --json`'s `{ url, port }`, when `url` is that port's bridge.
fn parse_ui(v: &Value) -> Option<(Url, u16)> {
    let port = u16::try_from(v.get("port")?.as_u64()?).ok()?;
    let url: Url = v.get("url")?.as_str()?.parse().ok()?;
    allowed_navigation(&url, port).then_some((url, port))
}

/// Manages the window's state (at setup).
pub fn install(app: &AppHandle) {
    app.manage(Shell::default());
}

/// "Open donn" (`page: None`) and "Open in donn". An open window with the
/// daemon up is only focused; otherwise a fresh `donn ui` signs it in.
pub fn open(app: &AppHandle, page: Option<String>) {
    let Some(state) = app.try_state::<Shell>() else {
        return;
    };
    let up = state.track.lock().unwrap().up();
    if page.is_none()
        && up
        && let Some(window) = app.get_webview_window(LABEL)
    {
        focus(&window);
        return;
    }
    sign_in(app, page, true);
}

/// Each snapshot (watch thread): the daemon back with the window open loads a
/// fresh `donn ui` URL (the app showed its "ended" page meanwhile).
pub fn on_snapshot(app: &AppHandle, s: &Snapshot) {
    let Some(state) = app.try_state::<Shell>() else {
        return;
    };
    let back = state.track.lock().unwrap().snapshot(s.daemon);
    if back {
        daemon_back(app);
    }
}

/// Loads a fresh `donn ui` URL into the window, if it is open.
pub fn daemon_back(app: &AppHandle) {
    if app.get_webview_window(LABEL).is_some() {
        sign_in(app, None, false);
    }
}

/// Runs `donn ui` off the main thread (it may start the daemon), then shows
/// the URL on it. `create`: open the window if it is not (a user's open).
fn sign_in(app: &AppHandle, page: Option<String>, create: bool) {
    let Some(donn) = tray::donn(app) else {
        return;
    };
    let Some(state) = app.try_state::<Shell>() else {
        return;
    };
    let seq = state.track.lock().unwrap().begin();
    let app = app.clone();
    std::thread::spawn(move || {
        let mut args = vec!["ui", "--no-open"];
        if let Some(page) = &page {
            args.extend(["--page", page]);
        }
        let opened = donn.run(&args, &tray::home()).and_then(|v| {
            parse_ui(&v).ok_or_else(|| CliFailure {
                code: "unreadable".into(),
                message: format!("donn ui printed no bridge URL: {v}"),
                fix: None,
            })
        });
        let track = &app.state::<Shell>().track;
        if !track.lock().unwrap().finish(seq, opened.is_ok()) {
            return;
        }
        match opened {
            Ok((url, port)) => {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || show(&handle, seq, url, port, create));
            }
            Err(failure) => tray::alert(&app, tray::failure_text(&failure)),
        }
    });
}

/// Main thread: unless a newer sign-in started, the port first
/// (`on_navigation` checks the new URL against it), then the existing window
/// navigated, or a new one.
fn show(app: &AppHandle, seq: u64, url: Url, port: u16, create: bool) {
    let state = app.state::<Shell>();
    if !state.track.lock().unwrap().is_latest(seq) {
        return;
    }
    state.port.store(port, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.navigate(url);
        if create {
            focus(&window);
        }
    } else if create {
        match build(app, url, state.port.clone()) {
            Ok(window) => focus(&window),
            Err(e) => tray::alert(app, format!("could not open the window: {e}")),
        }
    }
}

/// The window. Closing it destroys it (the default); no IPC reaches its pages
/// (`capabilities/default.json` has no `remote`).
fn build(app: &AppHandle, url: Url, port: Arc<AtomicU16>) -> tauri::Result<WebviewWindow> {
    let (nav_app, new_app) = (app.clone(), app.clone());
    let nav_port = port.clone();
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
        .title("donn")
        .inner_size(1200.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .on_navigation(
            move |url| match route(url, nav_port.load(Ordering::SeqCst)) {
                Nav::Load => true,
                Nav::Browser => {
                    browse(&nav_app, url);
                    false
                }
                Nav::Deny => false,
            },
        )
        // `target=_blank` and `window.open`: never a second window.
        .on_new_window(move |url, _| {
            if route(&url, port.load(Ordering::SeqCst)) == Nav::Browser {
                browse(&new_app, &url);
            }
            NewWindowResponse::Deny
        })
        .build()
}

fn browse(app: &AppHandle, url: &Url) {
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
}

/// Shows, raises and focuses the window (the app is an accessory on macOS).
fn focus(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn url(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn allows_only_the_bridge() {
        assert!(allowed_navigation(&url("http://127.0.0.1:4100/x"), 4100));
        assert!(!allowed_navigation(&url("http://localhost:4100/"), 4100));
        assert!(!allowed_navigation(&url("http://127.0.0.1:4101/"), 4100));
        assert!(!allowed_navigation(&url("https://127.0.0.1:4100/"), 4100));
        assert!(!allowed_navigation(&url("http://evil.example/"), 4100));
    }

    #[test]
    fn agent_page_encodes() {
        assert_eq!(
            agent_page("/Users/me/repo", "my agent"),
            "/agents/a/my%20agent?project=%2FUsers%2Fme%2Frepo"
        );
        assert_eq!(
            agent_page("/r/a&b=c?d#e", "a/b#c"),
            "/agents/a/a%2Fb%23c?project=%2Fr%2Fa%26b%3Dc%3Fd%23e"
        );
        assert_eq!(
            agent_page("/r/x-y_z.~", "n-1"),
            "/agents/a/n-1?project=%2Fr%2Fx-y_z.~"
        );
    }

    #[test]
    fn routes_bridge_browser_or_nowhere() {
        assert_eq!(route(&url("http://127.0.0.1:4100/agents"), 4100), Nav::Load);
        assert_eq!(route(&url("https://example.com/"), 4100), Nav::Browser);
        // Another port on 127.0.0.1 is a stale bridge URL (its one-time code
        // with it): never the browser.
        assert_eq!(route(&url("http://127.0.0.1:4101/#t=abc"), 4100), Nav::Deny);
        assert_eq!(route(&url("https://127.0.0.1:4100/"), 4100), Nav::Deny);
        assert_eq!(route(&url("file:///etc/passwd"), 4100), Nav::Deny);
        assert_eq!(route(&url("javascript:alert(1)"), 4100), Nav::Deny);
        assert_eq!(route(&url("about:blank"), 4100), Nav::Deny);
        // Before any open the port is 0: nothing is the bridge.
        assert_eq!(route(&url("http://127.0.0.1:4100/"), 0), Nav::Deny);
    }

    #[test]
    fn parses_the_bridge_url() {
        let v = json!({ "url": "http://127.0.0.1:4100/agents#t=abc", "port": 4100 });
        let (u, port) = parse_ui(&v).unwrap();
        assert_eq!(
            (u.as_str(), port),
            ("http://127.0.0.1:4100/agents#t=abc", 4100)
        );
        for bad in [
            json!({ "url": "http://evil.example/#t=abc", "port": 4100 }),
            json!({ "url": "http://127.0.0.1:4100/", "port": 4101 }),
            json!({ "url": "http://127.0.0.1:4100/", "port": 70000 }),
            json!({ "url": "not a url", "port": 4100 }),
            json!({ "port": 4100 }),
            json!({ "url": "http://127.0.0.1:4100/" }),
        ] {
            assert_eq!(parse_ui(&bad), None, "{bad}");
        }
    }

    #[test]
    fn the_daemon_comes_back_only_after_down() {
        let mut t = Track::default();
        assert!(!t.snapshot(true), "the first snapshot");
        assert!(!t.snapshot(true));
        assert!(!t.snapshot(false));
        assert!(!t.snapshot(false));
        assert!(t.snapshot(true), "down, then up");
        assert!(!t.snapshot(false) && !t.snapshot(false));
    }

    #[test]
    fn an_open_that_started_the_daemon_is_no_comeback() {
        let mut t = Track::default();
        t.snapshot(false);
        let open = t.begin();
        assert!(t.finish(open, true));
        assert!(!t.snapshot(true), "the open already signed in");
        assert!(t.up());
    }

    #[test]
    fn no_comeback_while_a_sign_in_runs() {
        let mut t = Track::default();
        t.snapshot(false);
        let open = t.begin();
        // The daemon is up before `donn ui` returns: that open signs in.
        assert!(!t.snapshot(true));
        assert!(t.finish(open, true));
        // A failed sign-in leaves the daemon as the snapshots say.
        t.snapshot(false);
        let open = t.begin();
        assert!(t.finish(open, false));
        assert!(!t.up());
        assert!(t.snapshot(true));
    }

    #[test]
    fn only_the_latest_sign_in_is_shown() {
        let mut t = Track::default();
        let a = t.begin();
        let b = t.begin();
        assert!(!t.finish(a, true), "older than b: dropped");
        assert!(t.finish(b, true));
        let c = t.begin();
        assert!(t.finish(c, false), "the latest, even failed, is reported");
    }
}
