use super::types::*;
use crate::project::*;
use std::{collections::BTreeMap, env, ffi::OsString, path::{Path, PathBuf}, sync::Mutex, time::{Duration, Instant}};
use super::{providers::*, providers::compatible::compatible_setting_is_configured, process::probe_command, providers::options::*};
/// The last answer the probe sweep gave, kept so it is not paid for twice.
///
/// One sweep is four child processes — a version check and an auth check per
/// CLI — and what is installed on this computer does not change between two
/// calls a moment apart. Without this, every remount of the app shell ran the
/// whole sweep again (React's development double-mount alone doubles it), and
/// on Windows each of those was a console window in the user's face.
///
/// A TTL rather than a permanent memo: a CLI installed, or logged into, while
/// Slopus is open is still picked up, just not instantly.
pub(super) struct CachedProbe {
    key: String,
    at: Instant,
    statuses: Vec<ProviderStatus>,
}

pub(super) static PROVIDER_PROBE_CACHE: Mutex<Option<CachedProbe>> = Mutex::new(None);
pub(super) const PROVIDER_PROBE_TTL: Duration = Duration::from_secs(120);

/// What the answer depends on: the settings for the agent CLIs themselves.
/// The engine paths travel in the same map and change often, and rekeying on
/// those would have thrown the probe away every time the settings screen was
/// touched.
pub(super) fn provider_probe_key(settings: &BTreeMap<String, ProviderSetting>) -> String {
    let relevant: BTreeMap<&str, &ProviderSetting> = [ProviderId::Claude, ProviderId::Codex]
        .into_iter()
        .filter_map(|id| settings.get(id.key()).map(|setting| (id.key(), setting)))
        .collect();
    serde_json::to_string(&relevant).unwrap_or_default()
}

pub(super) fn cached_or_probe<F>(
    cache: &Mutex<Option<CachedProbe>>,
    key: String,
    ttl: Duration,
    probe: F,
) -> Vec<ProviderStatus>
where
    F: FnOnce() -> Vec<ProviderStatus>,
{
    // The lock is held ACROSS the probe on purpose. Two calls arriving together
    // — which is exactly what a double-mounted app shell does — would otherwise
    // both miss the cache and both run the sweep. The second one waits here and
    // then finds the first one's answer.
    let mut guard = match cache.lock() {
        Ok(guard) => guard,
        // A panic while probing must not make probing impossible for the rest
        // of the session.
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(cached) = guard.as_ref() {
        if cached.key == key && cached.at.elapsed() < ttl {
            return cached.statuses.clone();
        }
    }
    let statuses = probe();
    *guard = Some(CachedProbe {
        key,
        at: Instant::now(),
        statuses: statuses.clone(),
    });
    statuses
}

pub fn provider_statuses(settings: &BTreeMap<String, ProviderSetting>) -> Vec<ProviderStatus> {
    let mut statuses = cached_or_probe(
        &PROVIDER_PROBE_CACHE,
        provider_probe_key(settings),
        PROVIDER_PROBE_TTL,
        || probe_provider_statuses(settings),
    );
    for id in [ProviderId::Openrouter, ProviderId::Local] {
        if let Some(setting) = settings
            .get(id.key())
            .filter(|setting| compatible_setting_is_configured(id, setting))
        {
            statuses.push(ProviderStatus {
                id,
                label: id.label(),
                state: "ready",
                executable: None,
                version: setting.model.clone(),
                detail: format!(
                    "Configured to use {}.",
                    setting.model.as_deref().unwrap_or("the selected model")
                ),
            });
        }
    }
    statuses
}

pub(super) fn probe_provider_statuses(settings: &BTreeMap<String, ProviderSetting>) -> Vec<ProviderStatus> {
    [ProviderId::Claude, ProviderId::Codex]
        .into_iter()
        .map(|id| {
            let provider = cli_provider_for(id).expect("CLI provider id");
            let setting = settings.get(id.key());
            if setting.is_some_and(|value| !value.enabled) {
                return ProviderStatus {
                    id,
                    label: provider.label(),
                    state: "disabled",
                    executable: None,
                    version: None,
                    detail: "Disabled in project settings.".into(),
                };
            }
            let Some(executable) = discover_executable(provider.executable_name(), setting) else {
                return ProviderStatus {
                    id,
                    label: provider.label(),
                    state: "notInstalled",
                    executable: None,
                    version: None,
                    detail: format!("{} was not found on PATH.", provider.executable_name()),
                };
            };
            installed_provider_status(id, provider, executable, probe_command)
        })
        .collect()
}

pub(super) fn installed_provider_status<F>(
    id: ProviderId,
    provider: &dyn CliProvider,
    executable: PathBuf,
    mut probe: F,
) -> ProviderStatus
where
    F: FnMut(&Path, &[&str], Duration) -> Result<String, String>,
{
    match probe(&executable, provider.version_args(), Duration::from_secs(3)) {
        Ok(version) => match probe(&executable, provider.auth_args(), Duration::from_secs(4)) {
            Ok(_) => ProviderStatus {
                id,
                label: provider.label(),
                state: "ready",
                executable: Some(executable.to_string_lossy().into_owned()),
                version: Some(version),
                detail: "Installed and authenticated for the configured execution mode.".into(),
            },
            Err(error) => ProviderStatus {
                id,
                label: provider.label(),
                state: "authRequired",
                executable: Some(executable.to_string_lossy().into_owned()),
                version: Some(version),
                detail: format!(
                    "Authentication is required for the configured execution mode: {error}"
                ),
            },
        },
        Err(error) => ProviderStatus {
            id,
            label: provider.label(),
            state: "unavailable",
            executable: Some(executable.to_string_lossy().into_owned()),
            version: None,
            detail: error,
        },
    }
}

pub(super) fn confined_project_root(folder: &Path) -> Result<PathBuf, String> {
    let canonical = folder
        .canonicalize()
        .map_err(|error| format!("Could not resolve project root: {error}"))?;
    let holds_a_project = crate::project::storage::project_file_in(&canonical).is_file();
    if !canonical.is_dir() || !holds_a_project {
        return Err("Agent turns require a valid Slopus project root.".into());
    }
    // `canonicalize` hands back a `\\?\`-prefixed verbatim path on Windows.
    // Windows itself normalises that away for a child's working directory, but
    // Codex is *told* its root a second time as a plain `-C <DIR>` argument,
    // and a third-party CLI has no reason to understand the verbatim form. The
    // rest of the app already reports project folders through `display_path`,
    // so the agent hands the CLIs the same spelling the user sees.
    Ok(PathBuf::from(crate::project::paths::display_path(&canonical)))
}
pub(super) fn discover_executable(name: &str, setting: Option<&ProviderSetting>) -> Option<PathBuf> {
    if let Some(configured) = setting.and_then(|value| option_string(value, "executable")) {
        let path = PathBuf::from(configured);
        #[cfg(windows)]
        if !path.extension().is_some_and(|extension| {
            extension.eq_ignore_ascii_case("exe") || extension.eq_ignore_ascii_case("com")
        }) {
            return None;
        }
        return path.is_file().then(|| path.canonicalize().unwrap_or(path));
    }
    let path = env::var_os("PATH")?;
    #[cfg(windows)]
    // Batch and PowerShell shims are deliberately excluded: Rust delegates
    // them to a command interpreter, which weakens argument-boundary safety.
    let extensions: Vec<OsString> = vec![".exe".into(), ".com".into()];
    #[cfg(not(windows))]
    let extensions: Vec<OsString> = vec![OsString::new()];
    for directory in env::split_paths(&path) {
        #[cfg(not(windows))]
        if directory.join(name).is_file() {
            return Some(directory.join(name));
        }
        for extension in &extensions {
            let candidate = directory.join(format!("{name}{}", extension.to_string_lossy()));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        #[cfg(all(windows, target_arch = "x86_64"))]
        if name == "codex" {
            let native = directory
                .join("node_modules/@openai/codex/node_modules/@openai/codex-win32-x64")
                .join("vendor/x86_64-pc-windows-msvc/bin/codex.exe");
            if native.is_file() {
                return Some(native);
            }
        }
    }
    None
}
