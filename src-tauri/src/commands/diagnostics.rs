use crate::diagnostics;
#[tauri::command]
pub(crate) fn write_diagnostic_log(entry: diagnostics::FrontendLogEvent) -> Result<(), String> {
    diagnostics::write_frontend(entry)
}

#[tauri::command]
pub(crate) fn diagnostic_log_info() -> Result<diagnostics::DiagnosticLogInfo, String> {
    diagnostics::log_info()
}

#[tauri::command]
pub(crate) fn reveal_diagnostic_log() -> Result<diagnostics::DiagnosticLogInfo, String> {
    diagnostics::reveal_log()
}
