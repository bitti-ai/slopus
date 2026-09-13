//! Persistent diagnostics shared by the native runtime and the webview.
//!
//! One human-readable record is written per line so a damaged final write
//! never makes earlier records unreadable. The active file rotates at startup
//! and at 5 MiB, and only one previous file is retained. Prompt bodies and credentials are
//! deliberately excluded by callers and redacted again here at the final
//! write boundary.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, Once, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const ACTIVE_FILE: &str = "slopus.log";
const PREVIOUS_FILE: &str = "slopus-prev.log";
const MAX_BYTES: u64 = 5 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 8 * 1024;

static LOGGER: OnceLock<Mutex<LogWriter>> = OnceLock::new();
static PANIC_HOOK: Once = Once::new();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendLogEvent {
    pub level: String,
    pub target: String,
    pub event: String,
    pub message: String,
    #[serde(default)]
    pub context: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLogInfo {
    pub path: String,
    pub previous_path: Option<String>,
    pub session_id: String,
    pub max_file_bytes: u64,
}

struct LogWriter {
    active_path: PathBuf,
    previous_path: PathBuf,
    session_id: String,
    max_bytes: u64,
    bytes: u64,
    file: Option<BufWriter<File>>,
}

impl LogWriter {
    fn new(directory: &Path, max_bytes: u64) -> Result<Self, String> {
        fs::create_dir_all(directory).map_err(|error| {
            format!(
                "Could not create diagnostic log directory '{}': {error}",
                directory.display()
            )
        })?;
        let active_path = directory.join(ACTIVE_FILE);
        let previous_path = directory.join(PREVIOUS_FILE);
        let mut writer = Self {
            active_path,
            previous_path,
            session_id: format!("{}-{}", std::process::id(), timestamp_ms()),
            max_bytes,
            bytes: 0,
            file: None,
        };
        writer.rotate()?;
        Ok(writer)
    }

    fn write(
        &mut self,
        level: &str,
        target: &str,
        event: &str,
        message: &str,
        context: Value,
    ) -> Result<(), String> {
        let context = format_context(redact(context, 0));
        let mut fields = format!(
            "sessionId={}",
            serde_json::to_string(&self.session_id).unwrap_or_else(|_| "\"[unprintable]\"".into())
        );
        if !context.is_empty() {
            fields.push_str(", ");
            fields.push_str(&context);
        }
        let line = format!(
            "{} [{}] {} {} - {}{}\n",
            format_timestamp(timestamp_ms()),
            normalized_level(level).to_ascii_uppercase(),
            single_line(&bounded_text(target)),
            single_line(&bounded_text(event)),
            single_line(&bounded_text(message)),
            format!(" | {fields}"),
        )
        .into_bytes();
        if self.bytes > 0 && self.bytes.saturating_add(line.len() as u64) > self.max_bytes {
            self.rotate()?;
        }
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| "Diagnostic log is not open.".to_string())?;
        file.write_all(&line)
            .map_err(|error| format!("Could not write diagnostic log: {error}"))?;
        file.flush()
            .map_err(|error| format!("Could not flush diagnostic log: {error}"))?;
        self.bytes = self.bytes.saturating_add(line.len() as u64);
        Ok(())
    }

    fn rotate(&mut self) -> Result<(), String> {
        if let Some(mut file) = self.file.take() {
            let _ = file.flush();
        }
        if self.active_path.exists() {
            if self.previous_path.exists() {
                fs::remove_file(&self.previous_path).map_err(|error| {
                    format!("Could not replace previous diagnostic log: {error}")
                })?;
            }
            fs::rename(&self.active_path, &self.previous_path)
                .map_err(|error| format!("Could not rotate diagnostic log: {error}"))?;
        }
        self.file = Some(open_append(&self.active_path)?);
        self.bytes = 0;
        Ok(())
    }

    fn info(&self) -> DiagnosticLogInfo {
        DiagnosticLogInfo {
            path: self.active_path.to_string_lossy().into_owned(),
            previous_path: self
                .previous_path
                .is_file()
                .then(|| self.previous_path.to_string_lossy().into_owned()),
            session_id: self.session_id.clone(),
            max_file_bytes: self.max_bytes,
        }
    }
}

fn open_append(path: &Path) -> Result<BufWriter<File>, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map(BufWriter::new)
        .map_err(|error| {
            format!(
                "Could not open diagnostic log '{}': {error}",
                path.display()
            )
        })
}

fn timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn format_timestamp(timestamp_ms: u64) -> String {
    let total_seconds = timestamp_ms / 1_000;
    let milliseconds = timestamp_ms % 1_000;
    let days = (total_seconds / 86_400) as i64;
    let seconds_in_day = total_seconds % 86_400;
    let hour = seconds_in_day / 3_600;
    let minute = seconds_in_day % 3_600 / 60;
    let second = seconds_in_day % 60;

    // Gregorian civil date conversion from days since the Unix epoch.
    let shifted_days = days + 719_468;
    let era = if shifted_days >= 0 {
        shifted_days
    } else {
        shifted_days - 146_096
    } / 146_097;
    let day_of_era = shifted_days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milliseconds:03}Z")
}

fn single_line(value: &str) -> String {
    value
        .replace('\r', "\\r")
        .replace('\n', "\\n")
        .replace('\t', "\\t")
}

fn format_context(value: Value) -> String {
    let format_value =
        |value: &Value| serde_json::to_string(value).unwrap_or_else(|_| "\"[unprintable]\"".into());
    match value {
        Value::Null => String::new(),
        Value::Object(values) if values.is_empty() => String::new(),
        Value::Object(values) => values
            .iter()
            .map(|(key, value)| format!("{}={}", single_line(key), format_value(value)))
            .collect::<Vec<_>>()
            .join(", "),
        other => format!("context={}", format_value(&other)),
    }
}

fn bounded_text(value: &str) -> String {
    value.chars().take(MAX_TEXT_CHARS).collect()
}

fn normalized_level(value: &str) -> &'static str {
    match value.to_ascii_lowercase().as_str() {
        "trace" => "trace",
        "debug" => "debug",
        "warn" | "warning" => "warn",
        "error" => "error",
        _ => "info",
    }
}

fn sensitive_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().replace(['_', '-'], "").as_str(),
        "apikey"
            | "authorization"
            | "password"
            | "secret"
            | "token"
            | "accesstoken"
            | "refreshtoken"
            | "prompt"
            | "content"
    )
}

fn redact(value: Value, depth: usize) -> Value {
    if depth >= 6 {
        return Value::String("[truncated]".into());
    }
    match value {
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .take(64)
                .map(|(key, value)| {
                    let value = if sensitive_key(&key) {
                        Value::String("[redacted]".into())
                    } else {
                        redact(value, depth + 1)
                    };
                    (key, value)
                })
                .collect::<Map<_, _>>(),
        ),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .take(64)
                .map(|value| redact(value, depth + 1))
                .collect(),
        ),
        Value::String(value) => Value::String(bounded_text(&value)),
        other => other,
    }
}

pub fn directory(app: &AppHandle) -> PathBuf {
    app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("slopus").join("logs"))
}

pub fn initialize(app: &AppHandle) -> Result<DiagnosticLogInfo, String> {
    let directory = directory(app);
    let writer = LogWriter::new(&directory, MAX_BYTES)?;
    let info = writer.info();
    LOGGER
        .set(Mutex::new(writer))
        .map_err(|_| "Diagnostic logging was initialized twice.".to_string())?;
    install_panic_hook();
    Ok(info)
}

fn install_panic_hook() {
    PANIC_HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |panic| {
            let location = panic
                .location()
                .map(|value| {
                    serde_json::json!({
                        "file": value.file(), "line": value.line(), "column": value.column(),
                    })
                })
                .unwrap_or(Value::Null);
            let message = panic
                .payload()
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| panic.payload().downcast_ref::<String>().map(String::as_str))
                .unwrap_or("Rust panicked without a string message.");
            error(
                "native",
                "panic",
                message,
                serde_json::json!({ "location": location }),
            );
            previous(panic);
        }));
    });
}

fn write(
    level: &str,
    target: &str,
    event: &str,
    message: &str,
    context: Value,
) -> Result<(), String> {
    let logger = LOGGER
        .get()
        .ok_or_else(|| "Diagnostic logging is not initialized.".to_string())?;
    logger
        .lock()
        .map_err(|_| "Diagnostic log lock failed.".to_string())?
        .write(level, target, event, message, context)
}

pub fn info(target: &str, event: &str, message: &str, context: Value) {
    let _ = write("info", target, event, message, context);
}

pub fn debug(target: &str, event: &str, message: &str, context: Value) {
    let _ = write("debug", target, event, message, context);
}

pub fn warn(target: &str, event: &str, message: &str, context: Value) {
    let _ = write("warn", target, event, message, context);
}

pub fn error(target: &str, event: &str, message: &str, context: Value) {
    let _ = write("error", target, event, message, context);
}

pub fn write_frontend(entry: FrontendLogEvent) -> Result<(), String> {
    write(
        &entry.level,
        &format!("frontend.{}", entry.target),
        &entry.event,
        &entry.message,
        entry.context.unwrap_or_else(|| Value::Object(Map::new())),
    )
}

pub fn log_info() -> Result<DiagnosticLogInfo, String> {
    let logger = LOGGER
        .get()
        .ok_or_else(|| "Diagnostic logging is not initialized.".to_string())?;
    Ok(logger
        .lock()
        .map_err(|_| "Diagnostic log lock failed.".to_string())?
        .info())
}

pub fn reveal_log() -> Result<DiagnosticLogInfo, String> {
    let info = log_info()?;
    let path = PathBuf::from(&info.path);
    #[cfg(target_os = "windows")]
    Command::new("explorer.exe")
        .arg("/select,")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("Could not open the diagnostic log folder: {error}"))?;
    #[cfg(target_os = "macos")]
    Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("Could not reveal the diagnostic log: {error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open")
        .arg(path.parent().unwrap_or(Path::new(".")))
        .spawn()
        .map_err(|error| format!("Could not open the diagnostic log folder: {error}"))?;
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_lines_are_readable_and_redact_credentials_and_prompt_content() {
        let folder = tempfile::tempdir().unwrap();
        let mut writer = LogWriter::new(folder.path(), 1024 * 1024).unwrap();
        writer.write("error", "generation", "failed", "encoder failed", serde_json::json!({
            "jobId": "job-1", "apiKey": "secret-key", "prompt": "private scene", "nested": { "password": "secret" }
        })).unwrap();
        drop(writer);
        let text = fs::read_to_string(folder.path().join(ACTIVE_FILE)).unwrap();
        assert!(text.contains("[ERROR] generation failed - encoder failed"));
        assert!(text.contains("sessionId="));
        assert!(text.contains("jobId=\"job-1\""));
        assert!(text.contains("apiKey=\"[redacted]\""));
        assert!(text.contains("prompt=\"[redacted]\""));
        assert!(text.contains("nested={\"password\":\"[redacted]\"}"));
        assert!(!text.contains("private scene"));
        assert!(!text.contains("secret-key"));
    }

    #[test]
    fn timestamp_is_utc_and_human_readable() {
        assert_eq!(format_timestamp(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            format_timestamp(1_788_449_322_122),
            "2026-09-03T15:28:42.122Z"
        );
    }

    #[test]
    fn startup_rotates_the_old_log_and_replaces_the_previous_session() {
        let folder = tempfile::tempdir().unwrap();
        let active = folder.path().join(ACTIVE_FILE);
        let previous = folder.path().join("slopus-prev.log");
        fs::write(&active, "last session").unwrap();
        fs::write(&previous, "older session").unwrap();

        let mut writer = LogWriter::new(folder.path(), MAX_BYTES).unwrap();
        assert_eq!(fs::read_to_string(&previous).unwrap(), "last session");
        assert_eq!(fs::read_to_string(&active).unwrap(), "");
        assert_eq!(writer.bytes, 0);
        assert_eq!(
            writer.info().previous_path,
            Some(previous.to_string_lossy().into_owned())
        );
        writer
            .write("info", "test", "startup", "new session", Value::Null)
            .unwrap();
        drop(writer);

        let current = fs::read_to_string(&active).unwrap();
        assert!(current.contains("new session"));
        assert!(!current.contains("last session"));
        let writer = LogWriter::new(folder.path(), MAX_BYTES).unwrap();
        assert_eq!(fs::read_to_string(&previous).unwrap(), current);
        assert_eq!(fs::read_to_string(&active).unwrap(), "");
        drop(writer);
    }

    #[test]
    fn rotation_keeps_one_previous_file() {
        let folder = tempfile::tempdir().unwrap();
        let mut writer = LogWriter::new(folder.path(), 300).unwrap();
        for index in 0..12 {
            writer
                .write(
                    "info",
                    "test",
                    "line",
                    &format!("record {index} {}", "x".repeat(80)),
                    Value::Null,
                )
                .unwrap();
        }
        drop(writer);
        assert!(folder.path().join(ACTIVE_FILE).is_file());
        assert!(folder.path().join(PREVIOUS_FILE).is_file());
        assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 2);
    }
}
