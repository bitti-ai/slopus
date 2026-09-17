use super::providers::output::{extract_provider_output, structured_failure};
use super::types::*;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    ffi::OsString,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};
pub(super) struct CommandSpec {
    pub(crate) executable: PathBuf,
    pub(crate) args: Vec<OsString>,
    pub(crate) current_dir: PathBuf,
    pub(crate) stdin_payload: Option<String>,
}

/// Windows gives every child process started by a GUI application its own
/// console window. Launching Slopus therefore flashed up one black window
/// per probe — and the agent CLIs are batch shims, so each was a real window
/// that stole focus. CREATE_NO_WINDOW asks for no console at all; stdout and
/// stderr are piped either way, so nothing is lost by hiding it.
#[cfg(windows)]
pub(super) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(super) fn quiet_command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

pub(super) fn is_benign_provider_diagnostic(provider: ProviderId, line: &str) -> bool {
    provider == ProviderId::Codex
        && line
            .trim()
            .eq_ignore_ascii_case("Reading additional input from stdin...")
}

pub(super) fn run_subprocess(
    spec: CommandSpec,
    provider: ProviderId,
    cancel: Arc<AtomicBool>,
    timeout: Duration,
    on_event: &dyn Fn(&AgentEvent),
) -> Result<(Vec<AgentEvent>, String), String> {
    if cancel.load(Ordering::Acquire) {
        return Err("Agent turn cancelled.".into());
    }
    let started = Instant::now();
    let has_stdin_payload = spec.stdin_payload.is_some();
    let mut child = ChildGuard(Some(
        quiet_command(&spec.executable)
            .args(&spec.args)
            .current_dir(&spec.current_dir)
            .stdin(if has_stdin_payload {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Could not start agent provider: {error}"))?,
    ));
    let (sender, receiver) = mpsc::channel::<(bool, String)>();
    let stdout_sender = sender.clone();
    let stdout = child.stdout.take().expect("configured child stdout");
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = stdout_sender.send((false, line));
        }
    });
    let stderr_sender = sender.clone();
    let stderr = child.stderr.take().expect("configured child stderr");
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = stderr_sender.send((true, line));
        }
    });
    drop(sender);
    let (input_tx, input_rx) = mpsc::channel();
    if let Some(payload) = spec.stdin_payload {
        let mut stdin = child.stdin.take().expect("configured child stdin");
        thread::spawn(move || {
            let _ = input_tx.send(stdin.write_all(payload.as_bytes()));
        });
    }

    let mut lines = Vec::new();
    let started_event = AgentEvent::Started { provider };
    on_event(&started_event);
    let mut events = vec![started_event];
    let status = loop {
        if let Ok(Err(error)) = input_rx.try_recv() {
            return Err(format!("Could not send request to agent provider: {error}"));
        }
        while let Ok((stderr, line)) = receiver.try_recv() {
            if stderr {
                if is_benign_provider_diagnostic(provider, &line) {
                    continue;
                }
                let event = AgentEvent::Diagnostic { text: line };
                on_event(&event);
                events.push(event);
            } else {
                let event = AgentEvent::Message { text: line.clone() };
                on_event(&event);
                events.push(event);
                lines.push(line);
            }
        }
        if cancel.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Agent turn cancelled.".into());
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Agent turn timed out after {} seconds.",
                timeout.as_secs()
            ));
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not inspect agent process: {error}"))?
        {
            break status;
        }
        thread::sleep(Duration::from_millis(25));
    };
    while let Ok((stderr, line)) = receiver.recv_timeout(Duration::from_millis(10)) {
        if stderr {
            if is_benign_provider_diagnostic(provider, &line) {
                continue;
            }
            let event = AgentEvent::Diagnostic { text: line };
            on_event(&event);
            events.push(event);
        } else {
            let event = AgentEvent::Message { text: line.clone() };
            on_event(&event);
            events.push(event);
            lines.push(line);
        }
    }
    if !status.success() {
        // Look on stdout first. Codex announces "Reading additional input from
        // stdin..." on stderr on every run, which is the *last* stderr line
        // and therefore used to be the whole error message — it masked a real
        // HTTP 400 from the model behind a notice about a pipe.
        let diagnostic = structured_failure(&lines)
            .or_else(|| {
                events.iter().rev().find_map(|event| match event {
                    AgentEvent::Diagnostic { text } if !text.trim().is_empty() => {
                        Some(text.clone())
                    }
                    _ => None,
                })
            })
            .unwrap_or_else(|| "Provider exited without a diagnostic.".into());
        return Err(format!("Agent provider exited with {status}: {diagnostic}"));
    }
    let completed = AgentEvent::Completed;
    on_event(&completed);
    events.push(completed);
    let output = extract_provider_output(&lines)?;
    Ok((events, output))
}
pub(super) fn probe_command(
    executable: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let mut child = ChildGuard(Some(
        quiet_command(executable)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Could not launch provider: {error}"))?,
    ));
    let start = Instant::now();
    // Drain both pipes while the child runs. Waiting before reading can fill a
    // pipe and deadlock even a successful version/authentication probe.
    let (sender, receiver) = mpsc::channel();
    drain_probe_pipe(
        child.stdout.take().expect("configured stdout"),
        false,
        sender.clone(),
    );
    drain_probe_pipe(
        child.stderr.take().expect("configured stderr"),
        true,
        sender,
    );
    let mut status = None;
    let mut stdout = None;
    let mut stderr = None;
    loop {
        if status.is_none() {
            status = child
                .try_wait()
                .map_err(|error| format!("Could not inspect provider: {error}"))?;
        }
        while let Ok((is_stderr, bytes)) = receiver.try_recv() {
            let bytes =
                bytes.map_err(|error| format!("Could not read provider version: {error}"))?;
            if is_stderr {
                stderr = Some(bytes);
            } else {
                stdout = Some(bytes);
            }
        }
        if let (Some(status), Some(stdout), Some(stderr)) = (&status, &stdout, &stderr) {
            let text = String::from_utf8_lossy(if stdout.is_empty() { stderr } else { stdout })
                .trim()
                .to_string();
            return status
                .success()
                .then_some(text)
                .ok_or_else(|| "The provider executable is present but unavailable.".into());
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Provider status probe timed out.".into());
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn drain_probe_pipe(
    mut pipe: impl std::io::Read + Send + 'static,
    is_stderr: bool,
    sender: mpsc::Sender<(bool, std::io::Result<Vec<u8>>)>,
) {
    thread::spawn(move || {
        let result = (|| {
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let count = pipe.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                // Keep a bounded diagnostic, but drain all remaining bytes.
                let keep = count.min(65_536_usize.saturating_sub(bytes.len()));
                bytes.extend_from_slice(&buffer[..keep]);
            }
            Ok(bytes)
        })();
        let _ = sender.send((is_stderr, result));
    });
}

/// Every error path reaps the child, including I/O inspection failures.
struct ChildGuard(Option<std::process::Child>);
impl std::ops::Deref for ChildGuard {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        self.0.as_ref().expect("owned child")
    }
}
impl std::ops::DerefMut for ChildGuard {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.0.as_mut().expect("owned child")
    }
}
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 {
            if !matches!(child.try_wait(), Ok(Some(_))) {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }
}
