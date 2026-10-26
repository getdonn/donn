//! Finds and runs the installed `donn` CLI (spec 28 §2). Never through a
//! shell; every call adds `--json` and parses stdout.

use std::fmt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

/// The oldest CLI that ships what the app reads (`status --watch`, spec 28 §1).
pub const MIN_CLI: (u32, u32, u32) = (0, 14, 0);

/// How long a login shell may take to answer `command -v donn`.
const LOCATE_TIMEOUT: Duration = Duration::from_secs(5);

/// `donn` could not be found.
#[derive(Debug, Clone, PartialEq)]
pub struct Missing(pub String);

impl fmt::Display for Missing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Missing {}

/// A failed CLI call: the CLI's `{ error }` envelope, or `unreadable`.
#[derive(Debug, Clone, PartialEq)]
pub struct CliFailure {
    pub code: String,
    pub message: String,
    pub fix: Option<String>,
}

/// The located `donn` binary.
#[derive(Debug, Clone)]
pub struct Donn {
    bin: PathBuf,
}

/// The last line of `command -v` output that is an absolute path.
pub fn parse_command_v(stdout: &str) -> Option<PathBuf> {
    stdout
        .lines()
        .map(str::trim)
        .rfind(|l| l.starts_with('/'))
        .map(PathBuf::from)
}

/// `$DONN_BIN` if set (and a file), else the login shell's `command -v donn`.
pub fn locate(env_bin: Option<&str>, shell: &str) -> Result<PathBuf, Missing> {
    if let Some(bin) = env_bin.filter(|b| !b.is_empty()) {
        let path = PathBuf::from(bin);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(Missing(format!("DONN_BIN is not a file: {bin}")))
        };
    }
    let out = shell_command_v(shell).map_err(|e| Missing(format!("{shell} -lc: {e}")))?;
    parse_command_v(&out).ok_or_else(|| Missing("donn is not on the login shell's PATH".into()))
}

/// Whether `donn --version` output is at least `min`; prereleases count as below.
pub fn version_ok(version_output: &str, min: (u32, u32, u32)) -> bool {
    let Some(v) = version_output
        .trim()
        .trim_start_matches('v')
        .parse::<semver_lite::V>()
        .ok()
    else {
        return false;
    };
    !v.pre && (v.major, v.minor, v.patch) >= min
}

/// The failure for a non-zero exit: the CLI's envelope from stdout, then stderr.
fn failure_from(stdout: &str, stderr: &str) -> CliFailure {
    let envelope = |text: &str| {
        let value: Value = serde_json::from_str(text.trim()).ok()?;
        let error = value.get("error")?;
        let field = |k: &str| error.get(k)?.as_str().map(str::to_owned);
        Some(CliFailure {
            code: field("code")?,
            message: field("message")?,
            fix: field("fix"),
        })
    };
    envelope(stdout)
        .or_else(|| envelope(stderr))
        .unwrap_or_else(|| {
            let text = if stderr.trim().is_empty() {
                stdout
            } else {
                stderr
            };
            CliFailure {
                code: "unreadable".into(),
                message: text.trim().to_owned(),
                fix: None,
            }
        })
}

/// A failure with no CLI envelope behind it.
fn unreadable(message: String) -> CliFailure {
    CliFailure {
        code: "unreadable".into(),
        message,
        fix: None,
    }
}

/// Runs `<shell> -lc 'command -v donn'`, killing it after `LOCATE_TIMEOUT`.
fn shell_command_v(shell: &str) -> std::io::Result<String> {
    let mut child = Command::new(shell)
        .args(["-lc", "command -v donn"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut pipe = child.stdout.take().expect("stdout is piped");
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = std::io::Read::read_to_string(&mut pipe, &mut text);
        text
    });
    let start = Instant::now();
    while child.try_wait()?.is_none() {
        if start.elapsed() > LOCATE_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(reader.join().unwrap_or_default())
}

/// Just enough of semver for `major.minor.patch[-pre]`.
mod semver_lite {
    use std::str::FromStr;

    pub struct V {
        pub major: u32,
        pub minor: u32,
        pub patch: u32,
        pub pre: bool,
    }

    impl FromStr for V {
        type Err = ();

        fn from_str(s: &str) -> Result<V, ()> {
            let (core, pre) = match s.split_once('-') {
                Some((core, _)) => (core, true),
                None => (s, false),
            };
            let mut parts = core.split('.').map(|p| p.parse::<u32>().map_err(|_| ()));
            let mut next = || parts.next().unwrap_or(Err(()));
            let v = V {
                major: next()?,
                minor: next()?,
                patch: next()?,
                pre,
            };
            if parts.next().is_some() {
                return Err(());
            }
            Ok(v)
        }
    }
}

impl Donn {
    /// Wraps a located binary.
    pub fn new(bin: PathBuf) -> Self {
        Donn { bin }
    }

    /// Runs `donn <args> --json` in `cwd`; stdout parsed as JSON on exit 0.
    pub fn run(&self, args: &[&str], cwd: &Path) -> Result<Value, CliFailure> {
        let out = Command::new(&self.bin)
            .args(args)
            .arg("--json")
            .current_dir(cwd)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| unreadable(format!("could not run donn: {e}")))?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        if !out.status.success() {
            return Err(failure_from(&stdout, &String::from_utf8_lossy(&out.stderr)));
        }
        serde_json::from_str(&stdout).map_err(|e| unreadable(format!("donn printed no JSON: {e}")))
    }

    /// Starts `donn status --watch --json`: stdout piped, stdin and stderr null.
    pub fn spawn_watch(&self) -> std::io::Result<Child> {
        Command::new(&self.bin)
            .args(["status", "--watch", "--json"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_command_v_with_noise() {
        assert_eq!(
            parse_command_v("Last login: Mon\n/opt/homebrew/bin/donn\n"),
            Some(PathBuf::from("/opt/homebrew/bin/donn"))
        );
        assert_eq!(parse_command_v(""), None);
        assert_eq!(parse_command_v("donn: not found"), None);
    }

    #[test]
    fn failure_from_cli_json() {
        let out = "{\n  \"error\": {\n    \"code\": \"store\",\n    \"message\": \"bad\",\n    \"fix\": \"fix it\",\n    \"file\": \"x\"\n  }\n}\n";
        let f = failure_from(out, "");
        assert_eq!(f.code, "store");
        assert_eq!(f.message, "bad");
        assert_eq!(f.fix.as_deref(), Some("fix it"));
        let f = failure_from("", "{\"error\":{\"code\":\"usage\",\"message\":\"m\"}}");
        assert_eq!((f.code.as_str(), f.fix), ("usage", None));
    }

    #[test]
    fn failure_from_garbage() {
        let f = failure_from("nope", "boom\n");
        assert_eq!(f.code, "unreadable");
        assert_eq!(f.message, "boom");
    }

    #[test]
    fn version_gate() {
        let min = MIN_CLI;
        assert!(version_ok("0.14.0\n", min));
        assert!(version_ok(" v0.14.1 ", min));
        assert!(!version_ok("0.13.2", min));
        assert!(!version_ok("0.14.0-next.1", min));
        assert!(version_ok("1.0.0", min));
        assert!(!version_ok("garbage", min));
        assert!(!version_ok("", min));
    }

    #[test]
    fn env_override_must_be_a_file() {
        let file = std::env::temp_dir().join("donn-cli-test-bin");
        std::fs::write(&file, "").unwrap();
        let path = file.to_str().unwrap();
        assert_eq!(locate(Some(path), "/bin/sh").unwrap(), file);
        assert!(locate(Some("/nonexistent/donn"), "/bin/sh").is_err());
        std::fs::remove_file(&file).unwrap();
    }
}
