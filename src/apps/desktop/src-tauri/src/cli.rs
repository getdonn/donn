//! Finds and runs the installed `donn` CLI (spec 28 §2). Never through a
//! shell; every call adds `--json` and parses stdout.

use std::ffi::OsString;
use std::fmt;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;

/// The oldest CLI that ships what the app reads (`status --watch`, spec 28 §1).
pub const MIN_CLI: (u32, u32, u32) = (0, 14, 0);

/// What the login shell is asked: where `donn` is, and its own PATH (an app
/// opened from Finder has a bare one, and `donn` is a Node script that needs
/// `node` on it). A fixed string: nothing is interpolated.
///
/// Asked of an interactive login shell (`-ilc`): `pnpm setup` and nvm put
/// their PATH lines in `~/.zshrc`, which a plain login shell does not read.
/// Its noise is skipped by the parsers; `LOCATE_TIMEOUT` bounds a hang.
const LOOKUP: &str = r#"command -v donn; printf "PATH=%s\n" "$PATH""#;

/// How long a login shell may take to answer `LOOKUP`.
const LOCATE_TIMEOUT: Duration = Duration::from_secs(5);

/// How long `donn --version` may take.
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

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

/// Why the app cannot use the CLI (spec 28 §2): the tray shows only this.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliProblem {
    NotFound,
    /// `donn --version` printed this, below `MIN_CLI`.
    TooOld(String),
    /// `donn --version` failed, hung or printed nothing.
    Broken,
}

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
    let out = shell_command_v(shell).map_err(|e| Missing(format!("{shell} -ilc: {e}")))?;
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

/// The version gate on `donn --version` output: `None` when it is new enough,
/// `Broken` when it is no version at all.
pub fn version_problem(version_output: &str) -> Option<CliProblem> {
    let v = version_output.trim();
    if v.trim_start_matches('v').parse::<semver_lite::V>().is_err() {
        return Some(CliProblem::Broken);
    }
    (!version_ok(v, MIN_CLI)).then(|| CliProblem::TooOld(v.into()))
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

/// Runs `<shell> -ilc LOOKUP`, bounded by `LOCATE_TIMEOUT`; its stdout.
fn shell_command_v(shell: &str) -> std::io::Result<String> {
    let out = run_bounded(Command::new(shell).args(["-ilc", LOOKUP]), LOCATE_TIMEOUT)?;
    Ok(out.stdout)
}

/// What `run_bounded` collected; `status` is `None` when the child was still
/// running at the deadline (it is killed).
struct Bounded {
    stdout: String,
    stderr: String,
    status: Option<ExitStatus>,
}

/// Runs `command` (stdin null, stdout and stderr piped) for at most `timeout`:
/// the child is killed and reaped past it, and once it exits its output is
/// collected for only a short grace, so a grandchild that inherited a pipe
/// cannot hold the app up. The reader threads are abandoned.
fn run_bounded(command: &mut Command, timeout: Duration) -> std::io::Result<Bounded> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let (tx, rx) = mpsc::channel::<(bool, Vec<u8>)>();
    let pipes: [(bool, Box<dyn Read + Send>); 2] = [
        (
            false,
            Box::new(child.stdout.take().expect("stdout is piped")),
        ),
        (
            true,
            Box::new(child.stderr.take().expect("stderr is piped")),
        ),
    ];
    for (is_err, mut pipe) in pipes {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 || tx.send((is_err, buf[..n].to_vec())).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);
    let start = Instant::now();
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut exited: Option<(Instant, ExitStatus)> = None;
    // Both pipes at EOF (every chunk was received before this).
    let mut closed = false;
    loop {
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok((false, chunk)) => out.extend(chunk),
            Ok((true, chunk)) => err.extend(chunk),
            Err(mpsc::RecvTimeoutError::Disconnected) => closed = true,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if exited.is_none()
            && let Ok(Some(status)) = child.try_wait()
        {
            exited = Some((Instant::now(), status));
        }
        let done = exited.is_some_and(|(t, _)| closed || t.elapsed() > EXIT_GRACE);
        if done || start.elapsed() > timeout {
            break;
        }
        if closed {
            // Only the exit is left to wait for; `recv_timeout` no longer waits.
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Ok(Bounded {
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
        status: exited.map(|(_, status)| status),
    })
}

/// A finished call's result: stdout parsed as JSON on success, else the failure.
fn answer(status: ExitStatus, stdout: &str, stderr: &str) -> Result<Value, CliFailure> {
    if !status.success() {
        return Err(failure_from(stdout, stderr));
    }
    serde_json::from_str(stdout).map_err(|e| unreadable(format!("donn printed no JSON: {e}")))
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
        answer(out.status, &stdout, &String::from_utf8_lossy(&out.stderr))
    }

    /// `run`, bounded by `timeout` (reads such as `donn list`; actions such as
    /// `agent run` may take minutes and use `run`). Past it, `donn` is killed
    /// and the call fails with `timeout`.
    pub fn run_with_timeout(
        &self,
        args: &[&str],
        cwd: &Path,
        timeout: Duration,
    ) -> Result<Value, CliFailure> {
        let mut command = self.command();
        command.args(args).arg("--json").current_dir(cwd);
        let out = run_bounded(&mut command, timeout)
            .map_err(|e| unreadable(format!("could not run donn: {e}")))?;
        let Some(status) = out.status else {
            return Err(CliFailure {
                code: "timeout".into(),
                message: format!(
                    "donn {} did not answer within {} s",
                    args.join(" "),
                    timeout.as_secs()
                ),
                fix: None,
            });
        };
        answer(status, &out.stdout, &out.stderr)
    }

    /// `donn --version`'s trimmed stdout (no `--json`: it would print an
    /// object), bounded by `VERSION_TIMEOUT`. An error says why there is none.
    pub fn version(&self) -> Result<String, String> {
        let bin = self.bin.display();
        let out = run_bounded(self.command().arg("--version"), VERSION_TIMEOUT)
            .map_err(|e| format!("could not run {bin}: {e}"))?;
        let Some(status) = out.status else {
            let secs = VERSION_TIMEOUT.as_secs();
            return Err(format!("{bin} did not answer --version within {secs} s"));
        };
        if !status.success() {
            return Err(format!("{bin} --version ({status}): {}", out.stderr.trim()));
        }
        let version = out.stdout.trim();
        if version.is_empty() {
            return Err(format!("{bin} --version printed nothing"));
        }
        Ok(version.to_owned())
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
    fn version_problem_names_the_old_version() {
        assert_eq!(version_problem("0.14.0\n"), None);
        assert_eq!(
            version_problem("0.13.2\n"),
            Some(CliProblem::TooOld("0.13.2".into()))
        );
        assert_eq!(
            version_problem(" 0.14.0-next.1 "),
            Some(CliProblem::TooOld("0.14.0-next.1".into()))
        );
        assert_eq!(version_problem("donn 0.14.0"), Some(CliProblem::Broken));
        assert_eq!(version_problem("garbage"), Some(CliProblem::Broken));
    }

    #[test]
    fn version_runs_the_binary_with_the_located_path() {
        let _serial = serial();
        let body = "#!/bin/sh\n[ \"$1\" = --version ] && [ \"$#\" = 1 ] || exit 3\necho \"0.14.2 $PATH\"\n";
        let bin = script("donn-cli-test-version", body);
        let donn = Donn::new(bin.clone(), Some("/opt/x:/usr/bin:/bin".into()));
        assert_eq!(donn.version().unwrap(), "0.14.2 /opt/x:/usr/bin:/bin");

        std::fs::write(&bin, "#!/bin/sh\necho nope >&2\nexit 1\n").unwrap();
        assert!(donn.version().unwrap_err().contains("nope"));
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        assert!(donn.version().is_err(), "no output is no version");
        std::fs::remove_file(&bin).unwrap();
        assert!(donn.version().is_err());
    }

    #[test]
    fn version_is_bounded_when_donn_hangs() {
        let _serial = serial();
        let bin = script("donn-cli-test-version-hang", "#!/bin/sh\nsleep 30\n");
        let start = Instant::now();
        let err = Donn::new(bin.clone(), None).version().unwrap_err();
        assert!(
            start.elapsed() < Duration::from_secs(6),
            "{:?}",
            start.elapsed()
        );
        assert!(err.contains("did not answer"), "{err}");
        std::fs::remove_file(&bin).unwrap();
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

    /// Tests that write a script and run it take this lock: on Linux, a fork in
    /// another test thread while a script is open for writing makes its exec
    /// fail with ETXTBSY (rust-lang/rust#114554). They are the only tests that
    /// spawn processes, so running them one at a time closes the race.
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// An executable script in the temp dir (call under `serial`). The file is
    /// closed when this returns.
    fn script(name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn locate_is_bounded_when_a_grandchild_holds_stdout() {
        let _serial = serial();
        let body = "#!/bin/sh\necho /opt/x/donn\necho PATH=/opt/x:/bin\nsleep 30 &\n";
        let script = script("donn-cli-test-shell", body);
        let start = Instant::now();
        let found = locate(None, script.to_str().unwrap());
        assert!(start.elapsed() < Duration::from_secs(6));
        let donn = found.unwrap();
        assert_eq!(donn.bin(), Path::new("/opt/x/donn"));
        assert_eq!(donn.path(), Some(&OsString::from("/opt/x:/bin")));
        std::fs::remove_file(&script).unwrap();
    }
    #[test]
    fn run_with_timeout_answers_or_times_out() {
        let _serial = serial();
        let body =
            "#!/bin/sh\n[ \"$1 $2\" = \"list --json\" ] || exit 3\necho '{\"personas\":[]}'\n";
        let bin = script("donn-cli-test-list", body);
        let donn = Donn::new(bin.clone(), None);
        let tmp = std::env::temp_dir();
        let v = donn
            .run_with_timeout(&["list"], &tmp, Duration::from_secs(5))
            .unwrap();
        assert_eq!(v, serde_json::json!({ "personas": [] }));

        let body =
            "#!/bin/sh\necho '{\"error\":{\"code\":\"store\",\"message\":\"bad\"}}'\nexit 1\n";
        let bin = script("donn-cli-test-list", body);
        let f = donn
            .run_with_timeout(&["list"], &tmp, Duration::from_secs(5))
            .unwrap_err();
        assert_eq!((f.code.as_str(), f.message.as_str()), ("store", "bad"));

        let hang = script("donn-cli-test-list-hang", "#!/bin/sh\nsleep 30\n");
        let start = Instant::now();
        let f = Donn::new(hang.clone(), None)
            .run_with_timeout(&["list"], &tmp, Duration::from_millis(300))
            .unwrap_err();
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "{:?}",
            start.elapsed()
        );
        assert_eq!(f.code, "timeout", "{f:?}");
        std::fs::remove_file(&bin).unwrap();
        std::fs::remove_file(&hang).unwrap();
    }
}
