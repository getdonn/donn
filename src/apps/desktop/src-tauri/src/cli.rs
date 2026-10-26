//! Finds and runs the installed `donn` CLI (spec 28 §2). Never through a
//! shell; every call adds `--json` and parses stdout.

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;

/// The oldest CLI that ships what the app reads (`status --watch`, spec 28 §1).
pub const MIN_CLI: (u32, u32, u32) = (0, 14, 0);

/// What the login shell is asked: where `donn` is, and its own PATH (an app
/// opened from Finder has a bare one, and `donn` is a Node script that needs
/// `node` on it). A fixed string: nothing is interpolated.
const LOOKUP: &str = r#"command -v donn; printf "PATH=%s\n" "$PATH""#;

/// How long a login shell may take to answer `LOOKUP`.
const LOCATE_TIMEOUT: Duration = Duration::from_secs(5);

/// How long output may trail the shell's exit (a grandchild holding stdout).
const EXIT_GRACE: Duration = Duration::from_millis(300);

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

/// The located `donn` binary, and the PATH it runs with (`None`: the app's).
#[derive(Debug, Clone)]
pub struct Donn {
    bin: PathBuf,
    path: Option<OsString>,
}

/// The last line of `LOOKUP` output that is an absolute path (`PATH=…` is not).
pub fn parse_command_v(stdout: &str) -> Option<PathBuf> {
    stdout
        .lines()
        .map(str::trim)
        .rfind(|l| l.starts_with('/'))
        .map(PathBuf::from)
}

/// The login shell's PATH: the last `PATH=` line of `LOOKUP` output.
pub fn parse_path(stdout: &str) -> Option<OsString> {
    stdout
        .lines()
        .rev()
        .find_map(|l| l.strip_prefix("PATH="))
        .map(str::trim_end)
        .filter(|p| !p.is_empty())
        .map(OsString::from)
}

/// `$DONN_BIN` if set (and a file), run with the app's PATH; else the login
/// shell's `command -v donn`, run with the login shell's PATH.
pub fn locate(env_bin: Option<&str>, shell: &str) -> Result<Donn, Missing> {
    if let Some(bin) = env_bin.filter(|b| !b.is_empty()) {
        let path = PathBuf::from(bin);
        return if path.is_file() {
            Ok(Donn::new(path, None))
        } else {
            Err(Missing(format!("DONN_BIN is not a file: {bin}")))
        };
    }
    let out = shell_command_v(shell).map_err(|e| Missing(format!("{shell} -lc: {e}")))?;
    let bin = parse_command_v(&out)
        .ok_or_else(|| Missing("donn is not on the login shell's PATH".into()))?;
    Ok(Donn::new(bin, parse_path(&out)))
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

/// Runs `<shell> -lc LOOKUP`. The whole call is bounded by
/// `LOCATE_TIMEOUT`: the shell is killed and reaped past it, and once the shell
/// exits the output is collected for only a short grace, so a grandchild that
/// inherited stdout cannot hold the app up. The reader thread is abandoned.
fn shell_command_v(shell: &str) -> std::io::Result<String> {
    let mut child = Command::new(shell)
        .args(["-lc", LOOKUP])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut pipe = child.stdout.take().expect("stdout is piped");
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = std::io::Read::read(&mut pipe, &mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let start = Instant::now();
    let mut out = Vec::new();
    let mut exited_at: Option<Instant> = None;
    loop {
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(chunk) => out.extend(chunk),
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if exited_at.is_none() && child.try_wait().ok().flatten().is_some() {
            exited_at = Some(Instant::now());
        }
        let grace_over = exited_at.is_some_and(|t| t.elapsed() > EXIT_GRACE);
        if grace_over || start.elapsed() > LOCATE_TIMEOUT {
            break;
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Ok(String::from_utf8_lossy(&out).into_owned())
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
    /// Wraps a located binary; `path` replaces the app's PATH for every call.
    pub fn new(bin: PathBuf, path: Option<OsString>) -> Self {
        Donn { bin, path }
    }

    pub fn bin(&self) -> &Path {
        &self.bin
    }

    pub fn path(&self) -> Option<&OsString> {
        self.path.as_ref()
    }

    /// A command for the binary, with the located PATH when there is one.
    fn command(&self) -> Command {
        let mut command = Command::new(&self.bin);
        if let Some(path) = &self.path {
            command.env("PATH", path);
        }
        command
    }

    /// Runs `donn <args> --json` in `cwd`; stdout parsed as JSON on exit 0.
    pub fn run(&self, args: &[&str], cwd: &Path) -> Result<Value, CliFailure> {
        let out = self
            .command()
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
        self.command()
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
        let lookup = "Last login: Mon\n/opt/homebrew/bin/donn\nPATH=/opt/homebrew/bin:/usr/bin\n";
        assert_eq!(
            parse_command_v(lookup),
            Some(PathBuf::from("/opt/homebrew/bin/donn"))
        );
        assert_eq!(parse_command_v("PATH=/usr/bin:/bin\n"), None);
    }

    #[test]
    fn parses_the_login_path() {
        let out = "motd\nPATH=/old\n/opt/x/donn\nPATH=/opt/x:/usr/bin:/bin\n";
        assert_eq!(
            parse_path(out),
            Some(OsString::from("/opt/x:/usr/bin:/bin"))
        );
        assert_eq!(parse_path("/opt/x/donn\n"), None);
        assert_eq!(parse_path("/opt/x/donn\nPATH=\n"), None);
        assert_eq!(parse_path("export PATH=/x\n"), None);
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
        let donn = locate(Some(path), "/bin/sh").unwrap();
        assert_eq!((donn.bin(), donn.path()), (file.as_path(), None));
        assert!(locate(Some("/nonexistent/donn"), "/bin/sh").is_err());
        std::fs::remove_file(&file).unwrap();
    }

    #[test]
    fn locate_is_bounded_when_a_grandchild_holds_stdout() {
        use std::os::unix::fs::PermissionsExt;
        let script = std::env::temp_dir().join("donn-cli-test-shell");
        let body = "#!/bin/sh\necho /opt/x/donn\necho PATH=/opt/x:/bin\nsleep 30 &\n";
        std::fs::write(&script, body).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let start = Instant::now();
        let found = locate(None, script.to_str().unwrap());
        assert!(start.elapsed() < Duration::from_secs(6));
        let donn = found.unwrap();
        assert_eq!(donn.bin(), Path::new("/opt/x/donn"));
        assert_eq!(donn.path(), Some(&OsString::from("/opt/x:/bin")));
        std::fs::remove_file(&script).unwrap();
    }
}
