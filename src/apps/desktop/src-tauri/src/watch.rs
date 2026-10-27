//! Keeps one `donn status --watch --json` child (spec 28 §2): reads its lines,
//! hands each snapshot on, restarts it with backoff when it exits, and kills it
//! when the app exits.

use std::io::{BufRead, BufReader};
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::cli::Donn;
use crate::snapshot::Snapshot;

/// The wait before restart `attempt` (0-based): 1 s, doubling, at most 30 s.
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_secs((1u64 << attempt.min(5)).min(30))
}

/// The running child, shared by the reader thread and `stop`.
#[derive(Default)]
struct Watch(Arc<Inner>);

#[derive(Default)]
struct Inner {
    stopped: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl Inner {
    /// Keeps `child` unless the app is exiting; then kills it. False: stop.
    fn keep(&self, mut child: Child) -> bool {
        let mut slot = self.child.lock().unwrap();
        if self.stopped.load(Ordering::SeqCst) {
            reap(&mut child);
            return false;
        }
        *slot = Some(child);
        true
    }

    fn reap(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            reap(&mut child);
        }
    }
}

fn reap(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Starts the reader thread. Lines that are not a snapshot (the CLI's pretty
/// `{ error }` envelope before it exits) are skipped; a good line resets the
/// backoff.
pub fn start(app: AppHandle, donn: Donn, on_snapshot: impl Fn(Snapshot) + Send + 'static) {
    // Managed once; `stop` may have managed it first (an exit during start).
    app.manage(Watch::default());
    let inner = app.state::<Watch>().0.clone();
    std::thread::spawn(move || {
        let mut attempt = 0;
        while !inner.stopped.load(Ordering::SeqCst) {
            if let Ok(mut child) = donn.spawn_watch() {
                let stdout = child.stdout.take().expect("stdout is piped");
                if !inner.keep(child) {
                    return;
                }
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if let Ok(snapshot) = serde_json::from_str::<Snapshot>(&line) {
                        attempt = 0;
                        on_snapshot(snapshot);
                    }
                }
                inner.reap();
            }
            if inner.stopped.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(backoff(attempt));
            attempt = attempt.saturating_add(1);
        }
    });
}

/// Kills the child and keeps a new one from starting (on `RunEvent::Exit`).
pub fn stop(app: &AppHandle) {
    app.manage(Watch::default());
    let inner = app.state::<Watch>().0.clone();
    inner.stopped.store(true, Ordering::SeqCst);
    inner.reap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_to_thirty_seconds() {
        let secs: Vec<u64> = (0..8).map(|a| backoff(a).as_secs()).collect();
        assert_eq!(secs, [1, 2, 4, 8, 16, 30, 30, 30]);
        assert_eq!(backoff(u32::MAX), Duration::from_secs(30));
    }
}
