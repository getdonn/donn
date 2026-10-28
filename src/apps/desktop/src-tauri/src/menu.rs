//! The tray's menu (spec 28 §3) as a pure model: built from a status snapshot
//! and the persona lists, then turned into a Tauri menu by `tray.rs`. Each
//! item carries the `Action` it runs; `action_args` gives its `donn` call.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::cli::{self, CliProblem};
use crate::snapshot::{Personas, Session, Snapshot};

/// What a menu item does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    SwitchDefault(String),
    ClearDefault,
    SwitchProject { cwd: PathBuf, r#ref: String },
    ClearProject { cwd: PathBuf },
    RunAgent { cwd: PathBuf, name: String },
    StopAgent { cwd: PathBuf, name: String },
    OpenAgent { project: String, name: String },
    StartDaemon,
    Open,
    ToggleLogin,
    Quit,
}

/// One line of the menu. A `Label` is a disabled item.
#[derive(Debug, Clone, PartialEq)]
pub enum Entry {
    Label(String),
    Separator,
    Item {
        id: String,
        label: String,
        action: Action,
        checked: Option<bool>,
    },
    Submenu {
        label: String,
        entries: Vec<Entry>,
    },
}

/// The tray's menu. `cli_version` is `donn --version`'s output, to tell an
/// outdated daemon (spec 28 open question 5). `project_personas` holds each project's `donn list`,
/// keyed by a session's `project` exactly as the snapshot gives it; a session
/// project and a `switched.projects` key match when `canon` (the tray passes
/// realpath) of each has the same project root. A project's line names what its
/// sessions run; its submenu ticks its switch. `login`: start at login is on.
pub fn menu_model(
    s: &Snapshot,
    default_personas: &Personas,
    project_personas: &BTreeMap<String, Personas>,
    cli_version: Option<&str>,
    canon: impl Fn(&str) -> String,
    login: bool,
) -> Vec<Entry> {
    let mut m = Vec::new();
    if s.daemon {
        m.push(Entry::Label(match &s.version {
            Some(v) => format!("donn {v} · daemon running"),
            None => "donn · daemon running".into(),
        }));
        if let Some((daemon, cli)) = outdated(s, cli_version) {
            m.push(Entry::Label(format!(
                "daemon {daemon} is older than the CLI {cli} — donn daemon install"
            )));
        }
    } else {
        m.push(Entry::Label("donn · daemon not running".into()));
        m.push(item(
            "daemon:start",
            "Start daemon",
            Action::StartDaemon,
            None,
        ));
    }

    let default = s.switched.default.as_deref();
    m.push(Entry::Submenu {
        label: format!("Default persona: {}", default.unwrap_or("none")),
        entries: choices(
            "default",
            Some(default_personas),
            default,
            |r| Action::SwitchDefault(r.into()),
            Action::ClearDefault,
        ),
    });
    // Sessions outside a project: one line and no submenu, as the default
    // persona above is their switch.
    let loose: Vec<&Session> = s.sessions.iter().filter(|x| x.project.is_none()).collect();
    if !loose.is_empty() {
        let personas: BTreeSet<&str> = loose.iter().map(|x| running(x)).collect();
        let harnesses: BTreeSet<&str> = loose.iter().map(|x| x.harness.as_str()).collect();
        m.push(Entry::Label(format!("no project · {}", joined(&personas))));
        m.push(Entry::Label(joined(&harnesses)));
    }
    m.push(Entry::Separator);

    let projects = projects(s, &canon);
    for (key, p) in &projects {
        let switch = s
            .switched
            .projects
            .iter()
            .find(|(k, _)| root(&canon(k)) == *key)
            .map(|(_, r)| r.as_str());
        let listed = p.given.iter().find_map(|g| project_personas.get(*g));
        let cwd = root(p.given[0]);
        // What the next launch gets, when it differs from what runs now.
        let mut entries = vec![Entry::Label(format!(
            "switched: {}",
            switch.unwrap_or("default")
        ))];
        entries.extend(choices(
            &format!("project:{}", key.display()),
            listed,
            switch,
            |r| Action::SwitchProject {
                cwd: cwd.clone(),
                r#ref: r.into(),
            },
            Action::ClearProject { cwd: cwd.clone() },
        ));
        m.push(Entry::Submenu {
            label: format!("{} · {}", folder(key, &projects), joined(&p.personas)),
            entries,
        });
        m.push(Entry::Label(joined(&p.harnesses)));
    }
    if !projects.is_empty() {
        m.push(Entry::Separator);
    }

    if !s.agents.is_empty() {
        m.push(Entry::Label("Agents".into()));
        for a in &s.agents {
            let (cwd, name) = (root(&a.project), a.name.clone());
            let at = format!("{}:{}", a.project, a.name);
            // With no daemon, `agent run` would hold the agent in the CLI's
            // foreground until a signal: the tray offers no Run or Stop then.
            let go = if !s.daemon {
                Entry::Label("Start the daemon to run".into())
            } else if a.state == "running" {
                let stop = Action::StopAgent { cwd, name };
                item(&format!("agent:stop:{at}"), "Stop", stop, None)
            } else {
                let run = Action::RunAgent { cwd, name };
                item(&format!("agent:run:{at}"), "Run", run, None)
            };
            let open = Action::OpenAgent {
                project: root(&a.project).display().to_string(),
                name: a.name.clone(),
            };
            m.push(Entry::Submenu {
                label: format!("{} · {}", a.name, a.state),
                entries: vec![
                    go,
                    item(&format!("agent:open:{at}"), "Open in donn", open, None),
                ],
            });
        }
        m.push(Entry::Separator);
    }

    m.push(item("open", "Open donn", Action::Open, None));
    m.push(item(
        "login",
        "Start at login",
        Action::ToggleLogin,
        Some(login),
    ));
    m.push(item("quit", "Quit", Action::Quit, None));
    m
}

/// The whole menu when the CLI cannot be used (spec 28 §2): one disabled line
/// with the install, update or diagnose command, and Quit.
pub fn cli_problem_menu(problem: &CliProblem) -> Vec<Entry> {
    let line = match problem {
        CliProblem::NotFound => "donn CLI not found — npm i -g @getdonn/cli".into(),
        CliProblem::Broken => {
            "donn CLI did not answer --version — run donn doctor in a terminal".into()
        }
        CliProblem::TooOld(v) => {
            format!("donn CLI {v} is too old for this app — npm i -g @getdonn/cli@latest")
        }
    };
    vec![
        Entry::Label(line),
        Entry::Separator,
        item("quit", "Quit", Action::Quit, None),
    ]
}

/// Sets the check of the item with this id (start at login, after a toggle).
pub fn set_checked(entries: &mut [Entry], id: &str, on: bool) {
    for e in entries {
        match e {
            Entry::Item { id: i, checked, .. } if i == id && checked.is_some() => {
                *checked = Some(on)
            }
            Entry::Submenu { entries, .. } => set_checked(entries, id, on),
            _ => {}
        }
    }
}

/// The action of the item with this id, if the menu has one.
pub fn action_for(entries: &[Entry], id: &str) -> Option<Action> {
    entries.iter().find_map(|e| match e {
        Entry::Item { id: i, action, .. } if i == id => Some(action.clone()),
        Entry::Submenu { entries, .. } => action_for(entries, id),
        _ => None,
    })
}

/// The `donn` call for an action, without `--json` (`Donn::run` adds it), and
/// its cwd; `None` runs in the home. Empty args: not a `donn` call from the
/// tray (the window, autostart and quit are the shell's own).
pub fn action_args(a: &Action) -> (Vec<String>, Option<PathBuf>) {
    let args = |v: &[&str]| v.iter().map(|x| x.to_string()).collect();
    match a {
        Action::SwitchDefault(r) => (args(&["switch", r, "--default"]), None),
        Action::ClearDefault => (args(&["switch", "--clear", "--default"]), None),
        Action::SwitchProject { cwd, r#ref } => (args(&["switch", r#ref]), Some(cwd.clone())),
        Action::ClearProject { cwd } => (args(&["switch", "--clear"]), Some(cwd.clone())),
        Action::RunAgent { cwd, name } => (args(&["agent", "run", name]), Some(cwd.clone())),
        Action::StopAgent { cwd, name } => (args(&["agent", "stop", name]), Some(cwd.clone())),
        Action::StartDaemon => (args(&["daemon", "start"]), None),
        Action::OpenAgent { .. } | Action::Open | Action::ToggleLogin | Action::Quit => {
            (Vec::new(), None)
        }
    }
}

/// The icon's dot (spec 28 §3): a session `stale` or failed to refresh, an
/// agent whose sync failed, or a daemon older than the CLI.
pub fn badge(s: &Snapshot, cli_version: Option<&str>) -> bool {
    s.sessions
        .iter()
        .any(|x| matches!(x.state.as_deref(), Some("stale" | "refresh-failed")))
        || s.agents.iter().any(|a| a.sync_failed.is_some())
        || outdated(s, cli_version).is_some()
}

/// The daemon's and the CLI's versions, trimmed, when the daemon's is older:
/// a service started before an upgrade runs the old code until reinstalled.
fn outdated<'a>(s: &'a Snapshot, cli_version: Option<&'a str>) -> Option<(&'a str, &'a str)> {
    let (daemon, cli) = (s.version.as_deref()?.trim(), cli_version?.trim());
    (s.daemon && cli::older(daemon, cli)).then_some((daemon, cli))
}

/// The projects with a session, keyed by canonical root.
struct Project<'a> {
    /// The session `project` strings, as the snapshot gives them.
    given: Vec<&'a str>,
    harnesses: BTreeSet<&'a str>,
    /// What its sessions run (`running`).
    personas: BTreeSet<&'a str>,
}

/// The persona a session runs: the one swapped in live, else the launched one.
fn running(x: &Session) -> &str {
    x.live.as_deref().unwrap_or(&x.launched)
}

/// Personas or harnesses for a line: distinct and sorted (a set), joined.
fn joined(personas: &BTreeSet<&str>) -> String {
    personas.iter().copied().collect::<Vec<_>>().join(", ")
}

fn projects<'a>(
    s: &'a Snapshot,
    canon: &impl Fn(&str) -> String,
) -> BTreeMap<PathBuf, Project<'a>> {
    let mut out: BTreeMap<PathBuf, Project> = BTreeMap::new();
    for x in &s.sessions {
        let Some(given) = x.project.as_deref() else {
            continue;
        };
        let p = out.entry(root(&canon(given))).or_insert(Project {
            given: Vec::new(),
            harnesses: BTreeSet::new(),
            personas: BTreeSet::new(),
        });
        if !p.given.contains(&given) {
            p.given.push(given);
        }
        p.harnesses.insert(&x.harness);
        p.personas.insert(running(x));
    }
    out
}

/// A project's root: the parent of its `.donn`, else the path itself.
pub(crate) fn root(path: &str) -> PathBuf {
    let p = Path::new(path);
    match (p.file_name(), p.parent()) {
        (Some(name), Some(parent)) if name == ".donn" => parent.to_path_buf(),
        _ => p.to_path_buf(),
    }
}

fn name(p: &Path) -> String {
    p.file_name().map_or_else(
        || p.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    )
}

/// The root's folder name, with its parent's when another project shares it.
fn folder(key: &Path, all: &BTreeMap<PathBuf, Project>) -> String {
    let base = name(key);
    if all.keys().filter(|k| name(k) == base).count() < 2 {
        return base;
    }
    match key.parent() {
        Some(parent) => format!("{base} ({})", name(parent)),
        None => base,
    }
}

/// A persona submenu: each ref (✓ on `current`), then `Clear` when one is set.
fn choices(
    id: &str,
    personas: Option<&Personas>,
    current: Option<&str>,
    switch: impl Fn(&str) -> Action,
    clear: Action,
) -> Vec<Entry> {
    let mut out: Vec<Entry> = personas
        .map(|p| p.personas.as_slice())
        .unwrap_or_default()
        .iter()
        .map(|p| {
            let on = current == Some(p.r#ref.as_str());
            let id = format!("{id}:switch:{}", p.r#ref);
            item(&id, &p.r#ref, switch(&p.r#ref), Some(on))
        })
        .collect();
    if out.is_empty() {
        out.push(Entry::Label("no personas".into()));
    }
    if current.is_some() {
        out.push(Entry::Separator);
        out.push(item(&format!("{id}:clear"), "Clear", clear, None));
    }
    out
}

fn item(id: &str, label: &str, action: Action, checked: Option<bool>) -> Entry {
    Entry::Item {
        id: id.into(),
        label: label.into(),
        action,
        checked,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::Agent;
    use serde::Deserialize;
    use std::path::Path;

    fn read<T: for<'de> Deserialize<'de>>(name: &str) -> T {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        let text = std::fs::read_to_string(path).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    fn personas() -> Personas {
        read("personas.json")
    }

    fn model(s: &Snapshot, projects: &BTreeMap<String, Personas>) -> Vec<Entry> {
        menu_model(s, &personas(), projects, None, |p| p.to_string(), false)
    }

    fn label(e: &Entry) -> &str {
        match e {
            Entry::Label(l) | Entry::Item { label: l, .. } | Entry::Submenu { label: l, .. } => l,
            Entry::Separator => "─",
        }
    }

    fn labels(entries: &[Entry]) -> Vec<&str> {
        entries.iter().map(label).collect()
    }

    fn submenu<'a>(entries: &'a [Entry], prefix: &str) -> &'a [Entry] {
        entries
            .iter()
            .find_map(|e| match e {
                Entry::Submenu { label, entries } if label.starts_with(prefix) => {
                    Some(entries.as_slice())
                }
                _ => None,
            })
            .unwrap_or_else(|| panic!("no submenu {prefix}"))
    }

    fn item<'a>(entries: &'a [Entry], name: &str) -> (&'a Action, Option<bool>) {
        entries
            .iter()
            .find_map(|e| match e {
                Entry::Item {
                    label,
                    action,
                    checked,
                    ..
                } if label == name => Some((action, *checked)),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no item {name}"))
    }

    fn ids(entries: &[Entry], out: &mut Vec<String>) {
        for e in entries {
            match e {
                Entry::Item { id, .. } => out.push(id.clone()),
                Entry::Submenu { entries, .. } => ids(entries, out),
                _ => {}
            }
        }
    }

    fn session(project: &str, harness: &str, state: &str) -> Session {
        Session {
            harness: harness.into(),
            project: Some(project.into()),
            launched: "org/base".into(),
            live: None,
            state: Some(state.into()),
        }
    }

    #[test]
    fn no_daemon_offers_start() {
        let s: Snapshot = read("no-daemon.json");
        let m = model(&s, &BTreeMap::new());
        assert_eq!(m[0], Entry::Label("donn · daemon not running".into()));
        assert_eq!(item(&m, "Start daemon").0, &Action::StartDaemon);

        let up: Snapshot = read("two-projects.json");
        let m = model(&up, &BTreeMap::new());
        assert_eq!(m[0], Entry::Label("donn 0.0.0 · daemon running".into()));
        assert!(!labels(&m).contains(&"Start daemon"));
    }

    #[test]
    fn default_submenu_marks_current() {
        let s: Snapshot = read("two-projects.json");
        let m = model(&s, &BTreeMap::new());
        let default = submenu(&m, "Default persona: org/base");
        assert_eq!(
            labels(default),
            ["area/fintech", "org/base", "team/payments", "─", "Clear"]
        );
        assert_eq!(
            item(default, "org/base"),
            (&Action::SwitchDefault("org/base".into()), Some(true))
        );
        assert_eq!(item(default, "team/payments").1, Some(false));
        assert_eq!(item(default, "Clear").0, &Action::ClearDefault);

        // No default: `none`, and nothing to clear.
        let none: Snapshot = read("no-daemon.json");
        let m = model(&none, &BTreeMap::new());
        let default = submenu(&m, "Default persona: none");
        assert_eq!(
            labels(default),
            ["area/fintech", "org/base", "team/payments"]
        );
        assert!(default.iter().all(|e| matches!(
            e,
            Entry::Item {
                checked: Some(false),
                ..
            }
        )));
    }

    #[test]
    fn project_shows_what_its_sessions_run() {
        let s: Snapshot = read("two-projects.json");
        let m = model(&s, &BTreeMap::new());
        // `launched` when nothing was swapped in live; the switch does not count.
        assert!(labels(&m).contains(&"repo · project/persona"));
        assert!(labels(&m).contains(&"repo2 · project/persona"));

        // `live` over `launched`.
        let live: Snapshot = read("live.json");
        let m = model(&live, &BTreeMap::new());
        assert!(labels(&m).contains(&"repo · org/base"));

        // No daemon: still what each session launched.
        let none: Snapshot = read("no-daemon.json");
        let m = model(&none, &BTreeMap::new());
        assert!(labels(&m).contains(&"repo · team/payments"));
        assert!(labels(&m).contains(&"other · org/base"));
    }

    #[test]
    fn project_lists_mixed_personas_distinct_and_sorted() {
        let mut s: Snapshot = read("live.json");
        s.sessions
            .push(session("/fixture/repo", "codex", "current"));
        let mut swapped = session("/fixture/repo", "claude-code", "current");
        swapped.live = Some("team/payments".into());
        s.sessions.push(swapped);
        s.sessions
            .push(session("/fixture/repo", "codex", "current"));
        let m = model(&s, &BTreeMap::new());
        assert!(
            labels(&m).contains(&"repo · org/base, team/payments"),
            "{:?}",
            labels(&m)
        );
    }

    #[test]
    fn project_submenu_names_its_switch() {
        let s: Snapshot = read("two-projects.json");
        let m = model(&s, &BTreeMap::new());
        let repo = submenu(&m, "repo ·");
        assert_eq!(repo[0], Entry::Label("switched: team/payments".into()));
        let repo2 = submenu(&m, "repo2 ·");
        assert_eq!(repo2[0], Entry::Label("switched: default".into()));
        // No default either: still `default`, the persona a launch would use.
        let none: Snapshot = read("no-daemon.json");
        let m = model(&none, &BTreeMap::new());
        assert_eq!(
            submenu(&m, "repo ·")[0],
            Entry::Label("switched: default".into())
        );
    }

    #[test]
    fn sessions_outside_a_project_follow_the_default() {
        let s: Snapshot = read("no-project.json");
        let m = model(&s, &BTreeMap::new());
        let at = labels(&m)
            .iter()
            .position(|l| l.starts_with("Default persona:"))
            .unwrap();
        assert_eq!(
            labels(&m[at + 1..at + 5]),
            [
                "no project · org/base",
                "claude-code",
                "─",
                "repo · project/persona"
            ]
        );
        assert!(matches!(m[at + 1], Entry::Label(_)), "no submenu");
        assert!(matches!(m[at + 2], Entry::Label(_)));

        // One line for all of them: personas and harnesses distinct and sorted.
        let mut mixed = s.clone();
        let mut codex = session("-", "codex", "current");
        codex.project = None;
        codex.live = Some("team/payments".into());
        mixed.sessions.push(codex.clone());
        codex.live = None;
        mixed.sessions.push(codex);
        let m = model(&mixed, &BTreeMap::new());
        assert_eq!(
            labels(&m[at + 1..at + 3]),
            ["no project · org/base, team/payments", "claude-code, codex"]
        );
        assert_eq!(
            labels(&m)
                .iter()
                .filter(|l| l.starts_with("no project"))
                .count(),
            1
        );

        // Only sessions outside a project: the line, then the separator.
        let mut alone = s.clone();
        alone.sessions.retain(|x| x.project.is_none());
        let m = model(&alone, &BTreeMap::new());
        assert_eq!(
            labels(&m[at + 1..at + 4]),
            ["no project · org/base", "claude-code", "─"]
        );

        // None: no line.
        let two: Snapshot = read("two-projects.json");
        let m = model(&two, &BTreeMap::new());
        assert!(!labels(&m).iter().any(|l| l.starts_with("no project")));
    }

    #[test]
    fn project_matches_switch_through_canon() {
        let mut s: Snapshot = read("two-projects.json");
        s.sessions[0].project = Some("/link/repo/.donn".into());
        let canon = |p: &str| p.replace("/link/", "/fixture/");
        let m = menu_model(&s, &personas(), &BTreeMap::new(), None, canon, false);
        let switched = Entry::Label("switched: team/payments".into());
        assert_eq!(submenu(&m, "repo ·")[0], switched);
        // Identity canon: the link does not match the switch.
        let m = model(&s, &BTreeMap::new());
        assert_eq!(
            submenu(&m, "repo ·")[0],
            Entry::Label("switched: default".into())
        );
    }

    #[test]
    fn project_cwd_is_parent_of_dot_donn() {
        let mut s: Snapshot = read("same-name.json");
        s.switched
            .projects
            .insert("/fixture/a/api/.donn".into(), "org/base".into());
        let mut projects = BTreeMap::new();
        projects.insert("/fixture/a/api/.donn".to_string(), personas());
        let m = model(&s, &projects);
        let api = submenu(&m, "api (a)");
        assert_eq!(
            labels(api),
            [
                "switched: org/base",
                "area/fintech",
                "org/base",
                "team/payments",
                "─",
                "Clear"
            ]
        );
        assert_eq!(
            item(api, "team/payments"),
            (
                &Action::SwitchProject {
                    cwd: "/fixture/a/api".into(),
                    r#ref: "team/payments".into()
                },
                Some(false)
            )
        );
        assert_eq!(item(api, "org/base").1, Some(true));
        assert_eq!(
            item(api, "Clear").0,
            &Action::ClearProject {
                cwd: "/fixture/a/api".into()
            }
        );
        // A project path that is already a root is its own cwd; no personas
        // listed yet, no switch to clear.
        let two: Snapshot = read("two-projects.json");
        let m = model(&two, &BTreeMap::new());
        assert_eq!(
            labels(submenu(&m, "repo2 ·")),
            ["switched: default", "no personas"]
        );
    }

    #[test]
    fn harnesses_label_follows_the_project() {
        let mut s: Snapshot = read("two-projects.json");
        s.sessions
            .push(session("/fixture/repo", "codex", "current"));
        s.sessions
            .push(session("/fixture/repo", "claude-code", "current"));
        let m = model(&s, &BTreeMap::new());
        let at = labels(&m)
            .iter()
            .position(|l| *l == "repo · org/base, project/persona")
            .unwrap();
        assert_eq!(m[at + 1], Entry::Label("claude-code, codex".into()));
        // One line per project, not per session.
        assert_eq!(
            labels(&m)
                .iter()
                .filter(|l| l.starts_with("repo ·"))
                .count(),
            1
        );
    }

    #[test]
    fn agent_running_offers_stop() {
        let s: Snapshot = read("agents.json");
        let m = model(&s, &BTreeMap::new());
        assert!(labels(&m).contains(&"Agents"));
        let bravo = submenu(&m, "bravo · running");
        assert_eq!(labels(bravo), ["Stop", "Open in donn"]);
        assert_eq!(
            item(bravo, "Stop").0,
            &Action::StopAgent {
                cwd: "/fixture/repo".into(),
                name: "bravo".into()
            }
        );
        assert_eq!(
            item(bravo, "Open in donn").0,
            &Action::OpenAgent {
                project: "/fixture/repo".into(),
                name: "bravo".into()
            }
        );
    }

    #[test]
    fn agent_created_offers_run() {
        let s: Snapshot = read("agents.json");
        let m = model(&s, &BTreeMap::new());
        let alpha = submenu(&m, "alpha · created");
        assert_eq!(labels(alpha), ["Run", "Open in donn"]);
        assert_eq!(
            item(alpha, "Run").0,
            &Action::RunAgent {
                cwd: "/fixture/repo".into(),
                name: "alpha".into()
            }
        );
        // Every created agent is listed, whatever its state.
        for l in [
            "foxtrot · unknown",
            "charlie · built",
            "delta · deployed",
            "echo · created",
        ] {
            assert!(labels(&m).contains(&l), "{l}");
        }
        // No agents, no header.
        let none: Snapshot = read("two-projects.json");
        assert!(!labels(&model(&none, &BTreeMap::new())).contains(&"Agents"));
    }

    #[test]
    fn no_daemon_no_run_or_stop() {
        let mut s: Snapshot = read("no-daemon.json");
        let up: Snapshot = read("agents.json");
        s.agents = up.agents.clone();
        s.agents.push(Agent {
            name: "golf".into(),
            project: "/fixture/repo".into(),
            state: "running".into(),
            sync_failed: None,
        });
        let m = model(&s, &BTreeMap::new());
        let mut all = Vec::new();
        ids(&m, &mut all);
        for id in &all {
            assert!(
                !matches!(
                    action_for(&m, id),
                    Some(Action::RunAgent { .. } | Action::StopAgent { .. })
                ),
                "{id}"
            );
        }
        // Each agent still opens in donn, which starts the daemon itself.
        let alpha = submenu(&m, "alpha · created");
        assert_eq!(labels(alpha), ["Start the daemon to run", "Open in donn"]);
        let golf = submenu(&m, "golf · running");
        assert_eq!(labels(golf), ["Start the daemon to run", "Open in donn"]);
    }

    #[test]
    fn disambiguates_same_named_projects() {
        let s: Snapshot = read("same-name.json");
        let m = model(&s, &BTreeMap::new());
        assert!(labels(&m).contains(&"api (a) · project/persona"));
        assert!(labels(&m).contains(&"api (b) · project/persona"));
    }

    #[test]
    fn footer_and_login() {
        let s: Snapshot = read("two-projects.json");
        let m = menu_model(&s, &personas(), &BTreeMap::new(), None, |p| p.into(), true);
        assert_eq!(
            labels(&m[m.len() - 4..]),
            ["─", "Open donn", "Start at login", "Quit"]
        );
        assert_eq!(
            item(&m, "Start at login"),
            (&Action::ToggleLogin, Some(true))
        );
        assert_eq!(item(&m, "Open donn").0, &Action::Open);
        assert_eq!(item(&m, "Quit").0, &Action::Quit);
        let m = model(&s, &BTreeMap::new());
        assert_eq!(item(&m, "Start at login").1, Some(false));
    }

    #[test]
    fn cli_problem_menus() {
        let m = cli_problem_menu(&CliProblem::NotFound);
        assert_eq!(
            labels(&m),
            ["donn CLI not found — npm i -g @getdonn/cli", "─", "Quit"]
        );
        assert!(matches!(m[0], Entry::Label(_)), "the line is disabled");
        assert_eq!(item(&m, "Quit").0, &Action::Quit);

        let m = cli_problem_menu(&CliProblem::TooOld("0.13.2".into()));
        assert_eq!(
            labels(&m),
            [
                "donn CLI 0.13.2 is too old for this app — npm i -g @getdonn/cli@latest",
                "─",
                "Quit"
            ]
        );
        assert!(matches!(m[0], Entry::Label(_)));
        assert_eq!(action_for(&m, "quit"), Some(Action::Quit));

        let m = cli_problem_menu(&CliProblem::Broken);
        assert_eq!(
            labels(&m),
            [
                "donn CLI did not answer --version — run donn doctor in a terminal",
                "─",
                "Quit"
            ]
        );
        assert!(matches!(m[0], Entry::Label(_)));
    }

    #[test]
    fn set_checked_ticks_one_item() {
        let s: Snapshot = read("two-projects.json");
        let mut m = model(&s, &BTreeMap::new());
        let before = m.clone();
        set_checked(&mut m, "login", true);
        assert_eq!(item(&m, "Start at login").1, Some(true));
        set_checked(&mut m, "login", false);
        assert_eq!(m, before, "only the login item changed");
        set_checked(&mut m, "nope", true);
        assert_eq!(m, before);
    }

    #[test]
    fn ids_are_unique_stable_and_map_back() {
        let mut s: Snapshot = read("agents.json");
        let two: Snapshot = read("two-projects.json");
        s.sessions = two.sessions.clone();
        s.switched = two.switched.clone();
        // Same name in two projects.
        s.agents.push(Agent {
            name: "bravo".into(),
            project: "/fixture/repo2".into(),
            state: "running".into(),
            sync_failed: None,
        });
        let mut projects = BTreeMap::new();
        projects.insert("/fixture/repo".to_string(), personas());
        projects.insert("/fixture/repo2".to_string(), personas());
        let m = model(&s, &projects);
        let mut all = Vec::new();
        ids(&m, &mut all);
        let mut unique = all.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(all.len(), unique.len(), "{all:?}");

        let mut again = Vec::new();
        ids(&model(&s, &projects), &mut again);
        assert_eq!(all, again);

        for id in &all {
            assert!(action_for(&m, id).is_some(), "{id}");
        }
        assert_eq!(action_for(&m, "nope"), None);
        let stop = all
            .iter()
            .find(|i| i.contains("stop") && i.contains("repo2"));
        assert_eq!(
            action_for(&m, stop.unwrap()),
            Some(Action::StopAgent {
                cwd: "/fixture/repo2".into(),
                name: "bravo".into()
            })
        );
    }

    #[test]
    fn badge_on_stale_or_sync_failed() {
        let stale: Snapshot = read("two-projects.json");
        assert!(badge(&stale, None));
        let agents: Snapshot = read("agents.json");
        assert!(badge(&agents, None));

        let mut quiet: Snapshot = read("same-name.json");
        assert!(!badge(&quiet, None));
        quiet.sessions[1].state = Some("refresh-failed".into());
        assert!(badge(&quiet, None));
        quiet.sessions[1].state = Some("refreshed".into());
        assert!(!badge(&quiet, None));
        assert!(!badge(&read("no-daemon.json"), None));
    }

    #[test]
    fn outdated_daemon_line_and_badge() {
        let line = |s: &Snapshot, cli: Option<&str>| {
            let m = menu_model(s, &personas(), &BTreeMap::new(), cli, |p| p.into(), false);
            m.iter().find_map(|e| match e {
                Entry::Label(l) if l.starts_with("daemon ") => Some(l.clone()),
                _ => None,
            })
        };
        // The fixture's daemon reports 0.0.0.
        let mut s: Snapshot = read("same-name.json");
        let m = menu_model(
            &s,
            &personas(),
            &BTreeMap::new(),
            Some("0.14.0"),
            |p| p.into(),
            false,
        );
        assert_eq!(
            labels(&m[..3]),
            [
                "donn 0.0.0 · daemon running",
                "daemon 0.0.0 is older than the CLI 0.14.0 — donn daemon install",
                "Default persona: none"
            ]
        );
        assert!(matches!(m[1], Entry::Label(_)), "a disabled line");
        assert!(badge(&s, Some("0.14.0")));
        // `--version` output as the shell read it: trimmed, `v` kept as printed.
        assert_eq!(
            line(&s, Some(" v0.14.0\n")).as_deref(),
            Some("daemon 0.0.0 is older than the CLI v0.14.0 — donn daemon install")
        );

        // A prerelease counts lower than its release.
        s.version = Some("0.14.0-next.1".into());
        assert!(line(&s, Some("0.14.0")).is_some());
        assert!(badge(&s, Some("0.14.0")));

        // Same, newer, or unknown on either side: nothing.
        for (daemon, cli) in [
            (Some("0.14.0"), Some("0.14.0")),
            (Some("0.15.0"), Some("0.14.0")),
            (Some("0.14.0"), Some("0.14.0-next.1")),
            (Some("0.0.0"), None),
            (Some("0.0.0"), Some("garbage")),
            (Some("garbage"), Some("0.14.0")),
            (None, Some("0.14.0")),
        ] {
            s.version = daemon.map(Into::into);
            assert_eq!(line(&s, cli), None, "{daemon:?} {cli:?}");
            assert!(!badge(&s, cli), "{daemon:?} {cli:?}");
        }

        // No daemon: no version to compare.
        let down: Snapshot = read("no-daemon.json");
        assert_eq!(line(&down, Some("0.14.0")), None);
        assert!(!badge(&down, Some("0.14.0")));
    }

    #[test]
    fn action_args_for_each_action() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let repo = PathBuf::from("/fixture/repo");
        let cases = [
            (
                Action::SwitchDefault("team/payments".into()),
                s(&["switch", "team/payments", "--default"]),
                None,
            ),
            (
                Action::ClearDefault,
                s(&["switch", "--clear", "--default"]),
                None,
            ),
            (
                Action::SwitchProject {
                    cwd: repo.clone(),
                    r#ref: "team/payments".into(),
                },
                s(&["switch", "team/payments"]),
                Some(repo.clone()),
            ),
            (
                Action::ClearProject { cwd: repo.clone() },
                s(&["switch", "--clear"]),
                Some(repo.clone()),
            ),
            (
                Action::RunAgent {
                    cwd: repo.clone(),
                    name: "smoke".into(),
                },
                s(&["agent", "run", "smoke"]),
                Some(repo.clone()),
            ),
            (
                Action::StopAgent {
                    cwd: repo.clone(),
                    name: "smoke".into(),
                },
                s(&["agent", "stop", "smoke"]),
                Some(repo.clone()),
            ),
            (Action::StartDaemon, s(&["daemon", "start"]), None),
            // Handled by the shell itself, not a `donn` call from the tray.
            (
                Action::OpenAgent {
                    project: "/fixture/repo".into(),
                    name: "smoke".into(),
                },
                vec![],
                None,
            ),
            (Action::Open, vec![], None),
            (Action::ToggleLogin, vec![], None),
            (Action::Quit, vec![], None),
        ];
        for (action, args, cwd) in cases {
            assert_eq!(action_args(&action), (args, cwd), "{action:?}");
        }
    }
}
