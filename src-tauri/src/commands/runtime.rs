use crate::project::{paths::*, *};
use crate::{agent, diagnostics, slopfab};
use serde::Serialize;
use std::collections::BTreeMap;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeStatus {
    pub(crate) providers: Vec<agent::ProviderStatus>,
    pub(crate) slopfab: slopfab::SlopfabStatus,
}

/// Probes the video engine from provider settings alone. The settings screen
/// has no project in hand — engine paths belong to the machine, not to a
/// project file — so it cannot go through `runtime_status`.
#[tauri::command]
pub(crate) fn slopfab_status(
    settings: BTreeMap<String, ProviderSetting>,
) -> slopfab::SlopfabStatus {
    let status = slopfab::status(&settings);
    diagnostics::info(
        "runtime",
        "slopfab.probed",
        "Video engine probe completed.",
        serde_json::json!({
            "state": status.state,
            "version": status.version,
            "platform": status.platform,
            "models": status.models.iter().map(|model| serde_json::json!({
                "id": model.id, "configured": model.configured, "available": model.available,
            })).collect::<Vec<_>>(),
        }),
    );
    status
}

/// One OS picker for one engine path. `directory` picks a folder (the
/// tokenizer is one); `extensions` filters the file picker and an empty list
/// means any file.
#[tauri::command]
pub(crate) fn choose_engine_path(
    app: AppHandle,
    title: String,
    directory: bool,
    extensions: Vec<String>,
) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_title(title);
    if !directory && !extensions.is_empty() {
        let filters = extensions.iter().map(String::as_str).collect::<Vec<_>>();
        dialog = dialog.add_filter("Supported files", &filters);
    }
    let selected = if directory {
        dialog.blocking_pick_folder()
    } else {
        dialog.blocking_pick_file()
    };
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("Could not access the selected path: {error}"))?;
    Ok(Some(display_path(&path)))
}

/// What is installed on this computer: the two agent CLIs and the video engine.
///
/// Async on purpose — this launches two CLIs (up to 7s each) and loads the
/// engine DLL. Run inline on the main thread it froze the window for as long
/// as that took, which is what it was doing.
///
/// Takes provider settings rather than a whole project: what is installed here
/// is a property of the machine, so the frontend probes it ONCE at startup and
/// every project shares the answer.
#[tauri::command]
pub(crate) async fn runtime_status(
    discovery: tauri::State<'_, agent::ProviderDiscovery>,
    settings: BTreeMap<String, ProviderSetting>,
) -> Result<RuntimeStatus, String> {
    let discovery = discovery.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || RuntimeStatus {
        providers: agent::provider_statuses(&discovery, &settings),
        slopfab: slopfab::status(&settings),
    })
    .await
    .map_err(|error| format!("Could not probe this computer: {error}"));
    match &result {
        Ok(status) => diagnostics::info(
            "runtime",
            "application.probed",
            "Application runtime probe completed.",
            serde_json::json!({
                "slopfabState": status.slopfab.state,
                "slopfabVersion": status.slopfab.version,
                "platform": status.slopfab.platform,
                "providers": status.providers.iter().map(|provider| serde_json::json!({
                    "id": provider.id, "state": provider.state, "version": provider.version,
                })).collect::<Vec<_>>(),
            }),
        ),
        Err(error) => diagnostics::error(
            "runtime",
            "application.probe_failed",
            error,
            serde_json::json!({}),
        ),
    }
    result
}
