/* ── WebKitGTK, the Linux webview ────────────────────────────────────────────
WebView2 ships WebCodecs and WebGPU switched on; WebKitGTK ships them behind
runtime feature flags. The media pipeline (AGENTS.md) needs both, so they are
switched on here, together with GPU compositing and WebGL.

The feature API (webkit_settings_get_all_features and friends) arrived in
WebKitGTK 2.42, after the newest version the webkit2gtk crate binds. It is
looked up at run time instead of linked, so an older WebKitGTK still starts the
app, just without the flags; diagnostics then records which ones were missing.
-------------------------------------------------------------------------- */

use std::ffi::{c_char, c_int, c_void, CStr};
use tauri::Runtime;
use webkit2gtk::{glib::translate::ToGlibPtr as _, HardwareAccelerationPolicy, SettingsExt as _, WebViewExt as _};

/// WebKit preference keys (UnifiedWebPreferences.yaml) the page relies on.
pub(crate) const REQUIRED_FEATURES: &[&str] = &[
    "WebCodecsVideoEnabled",
    "WebCodecsAudioEnabled",
    "WebCodecsAV1Enabled",
    "WebGPUEnabled",
];

type GetAllFeatures = unsafe extern "C" fn() -> *mut c_void;
type ListLength = unsafe extern "C" fn(*mut c_void) -> usize;
type ListGet = unsafe extern "C" fn(*mut c_void, usize) -> *mut c_void;
type ListUnref = unsafe extern "C" fn(*mut c_void);
type FeatureIdentifier = unsafe extern "C" fn(*mut c_void) -> *const c_char;
type GetFeatureEnabled = unsafe extern "C" fn(*mut c_void, *mut c_void) -> c_int;
type SetFeatureEnabled = unsafe extern "C" fn(*mut c_void, *mut c_void, c_int);

/// Which of REQUIRED_FEATURES a settings object could turn on.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct FeatureReport {
    pub(crate) enabled: Vec<&'static str>,
    pub(crate) missing: Vec<&'static str>,
    /// A flag was off until now, so a page already loaded does not have it.
    pub(crate) changed: bool,
}

/// The features from REQUIRED_FEATURES that `available` offers, and the rest.
pub(crate) fn match_features<'a>(available: impl IntoIterator<Item = &'a str>) -> FeatureReport {
    let available: Vec<&str> = available.into_iter().collect();
    let (enabled, missing) = REQUIRED_FEATURES.iter().partition(|name| available.contains(name));
    FeatureReport { enabled, missing, changed: false }
}

/// Switches on the flags in REQUIRED_FEATURES that this WebKitGTK knows.
fn enable_features(settings: &webkit2gtk::Settings) -> Result<FeatureReport, String> {
    // SAFETY: symbols are looked up in libraries this process already loaded
    // (wry links WebKitGTK), with the signatures documented for 2.42+. The
    // list is owned by us and unreferenced once; features are borrowed from it.
    unsafe {
        let process = libloading::os::unix::Library::this();
        let symbol = |name: &[u8]| process.get::<*mut c_void>(name).map(|symbol| *symbol);
        let missing = |error: libloading::Error| format!("WebKitGTK 2.42 or later is required for WebCodecs and WebGPU: {error}");
        let get_all: GetAllFeatures = std::mem::transmute(symbol(b"webkit_settings_get_all_features\0").map_err(missing)?);
        let length: ListLength = std::mem::transmute(symbol(b"webkit_feature_list_get_length\0").map_err(missing)?);
        let get: ListGet = std::mem::transmute(symbol(b"webkit_feature_list_get\0").map_err(missing)?);
        let unref: ListUnref = std::mem::transmute(symbol(b"webkit_feature_list_unref\0").map_err(missing)?);
        let identifier: FeatureIdentifier = std::mem::transmute(symbol(b"webkit_feature_get_identifier\0").map_err(missing)?);
        let get_enabled: GetFeatureEnabled = std::mem::transmute(symbol(b"webkit_settings_get_feature_enabled\0").map_err(missing)?);
        let set_enabled: SetFeatureEnabled = std::mem::transmute(symbol(b"webkit_settings_set_feature_enabled\0").map_err(missing)?);

        let settings_ptr: *mut c_void = settings.to_glib_none().0.cast();
        let list = get_all();
        if list.is_null() {
            return Err("WebKitGTK returned no feature list.".into());
        }
        let mut available = Vec::new();
        let mut changed = false;
        for index in 0..length(list) {
            let feature = get(list, index);
            if feature.is_null() {
                continue;
            }
            let name = identifier(feature);
            if name.is_null() {
                continue;
            }
            let name = CStr::from_ptr(name).to_string_lossy();
            if let Some(required) = REQUIRED_FEATURES.iter().find(|required| **required == name) {
                if get_enabled(settings_ptr, feature) == 0 {
                    set_enabled(settings_ptr, feature, 1);
                    changed = true;
                }
                available.push(*required);
            }
        }
        unref(list);
        Ok(FeatureReport { changed, ..match_features(available) })
    }
}

/// Media and GPU settings for the main webview, plus the browser behaviour
/// native_shell.rs turns off on Windows. Logs what could not be enabled.
pub(crate) fn configure<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.with_webview(|webview| {
        let view = webview.inner();
        let Some(settings) = view.settings() else { return };
        settings.set_hardware_acceleration_policy(HardwareAccelerationPolicy::Always);
        settings.set_enable_webgl(true);
        settings.set_enable_media(true);
        settings.set_media_playback_requires_user_gesture(false);
        // DevTools only in debug builds, as with WebView2.
        settings.set_enable_developer_extras(cfg!(debug_assertions));
        let report = enable_features(&settings);
        view.set_settings(&settings);
        /* The first navigation started when the window was built, and
           WebKit decides navigator.gpu and the codec classes when a page's
           global object is created. Load the page again so it has them;
           the window is still empty this early in startup. */
        if report.as_ref().is_ok_and(|report| report.changed) {
            view.reload();
        }
        match report {
            Ok(report) if report.missing.is_empty() => crate::diagnostics::info(
                "app",
                "webview",
                "WebKitGTK media and GPU features enabled.",
                serde_json::json!({ "enabled": report.enabled }),
            ),
            Ok(report) => crate::diagnostics::warn(
                "app",
                "webview",
                "This WebKitGTK lacks some media or GPU features. Update WebKitGTK for video decoding, export and effects.",
                serde_json::json!({ "enabled": report.enabled, "missing": report.missing }),
            ),
            Err(error) => crate::diagnostics::warn("app", "webview", &error, serde_json::json!({})),
        }
    });
}

/// Runs a text menu item (Cut, Copy, Paste, Select all) in the focused field.
/// WebKit's own editing commands keep undo history and input events intact,
/// which is what replaying the keys achieves on Windows.
pub(crate) fn execute_editing_command<R: Runtime>(window: &tauri::WebviewWindow<R>, command: &'static str) {
    let _ = window.with_webview(move |webview| webview.inner().execute_editing_command(command));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_which_required_features_this_webkit_offers() {
        let report = match_features(["WebGPUEnabled", "WebCodecsVideoEnabled", "SomethingElse"]);
        assert_eq!(report.enabled, ["WebCodecsVideoEnabled", "WebGPUEnabled"]);
        assert_eq!(report.missing, ["WebCodecsAudioEnabled", "WebCodecsAV1Enabled"]);
    }
}
