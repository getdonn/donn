//! What the tray reads (spec 28 §2): the shapes of `donn status --json` and
//! `donn list --json`. Only the fields the menu uses; the rest is ignored, so
//! a newer CLI that adds fields still parses.

use std::collections::BTreeMap;

use serde::Deserialize;

/// One line of `donn status --watch --json`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Snapshot {
    pub daemon: bool,
    /// Only when the daemon is up.
    pub version: Option<String>,
    pub sessions: Vec<Session>,
    pub agents: Vec<Agent>,
    pub switched: Switched,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Session {
    pub harness: String,
    pub project: Option<String>,
    pub launched: String,
    /// The persona swapped in since the launch, if any.
    pub live: Option<String>,
    /// `current`, `refreshed`, `stale` or `refresh-failed`; only with a daemon.
    pub state: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Agent {
    pub name: String,
    pub project: String,
    /// `created`, `running`, `built`, `deployed` or `unknown`.
    pub state: String,
    #[serde(rename = "syncFailed")]
    pub sync_failed: Option<String>,
}

/// `state.json`: the default switch and each project's, keyed by its `.donn` path.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Switched {
    pub default: Option<String>,
    pub projects: BTreeMap<String, String>,
}

/// `donn list --json`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Personas {
    pub personas: Vec<PersonaRef>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct PersonaRef {
    pub r#ref: String,
    pub layer: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn fixtures() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
    }

    fn read<T: for<'de> Deserialize<'de>>(name: &str) -> T {
        let text = fs::read_to_string(fixtures().join(name)).unwrap();
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name}: {e}"))
    }

    #[test]
    fn parses_every_fixture() {
        let mut seen = 0;
        for entry in fs::read_dir(fixtures()).unwrap() {
            let name = entry.unwrap().file_name().into_string().unwrap();
            if !name.ends_with(".json") {
                continue;
            }
            if name == "personas.json" {
                let personas: Personas = read(&name);
                assert!(!personas.personas.is_empty());
            } else {
                let _: Snapshot = read(&name);
            }
            seen += 1;
        }
        assert!(seen >= 5, "expected the five fixtures, found {seen}");
    }

    #[test]
    fn reads_what_the_tray_needs() {
        let none: Snapshot = read("no-daemon.json");
        assert!(!none.daemon && none.version.is_none());
        assert!(none.sessions.iter().all(|s| s.state.is_none()));

        let two: Snapshot = read("two-projects.json");
        assert!(
            two.sessions
                .iter()
                .any(|s| s.state.as_deref() == Some("stale"))
        );
        assert!(two.switched.default.is_some() && !two.switched.projects.is_empty());

        let agents: Snapshot = read("agents.json");
        let states: Vec<_> = agents.agents.iter().map(|a| a.state.as_str()).collect();
        for state in ["created", "running", "built", "deployed", "unknown"] {
            assert!(states.contains(&state), "no {state} agent");
        }
        assert!(agents.agents.iter().any(|a| a.sync_failed.is_some()));

        let same: Snapshot = read("same-name.json");
        let projects: Vec<_> = same
            .sessions
            .iter()
            .filter_map(|s| s.project.as_deref())
            .collect();
        assert_eq!(projects.len(), 2);
        assert!(projects[0].ends_with("/a/api/.donn") && projects[1].ends_with("/b/api/.donn"));
    }
}
