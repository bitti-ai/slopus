/* ── The native shell ────────────────────────────────────────────────────────
Everything that makes the Slopus window behave like a Windows 11 app rather
than a web page in a frame: the Mica backdrop, the frameless window's corners,
the WebView2 switches that turn off browser-only behaviour, the Windows accent
colour, the first-launch size, the text-field context menu, and two small
file-system helpers (reveal in Explorer, pick a file).

The page's half lives in src/lib/nativeShell.ts. Every command here has a
counterpart there that no-ops outside Tauri, so the web build and the jsdom
tests never have to care which host they are in.
-------------------------------------------------------------------------- */

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager as _, Runtime};

/// Event the page listens to for a changed accent (src/lib/nativeShell.ts).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const ACCENT_EVENT: &str = "system-accent-changed";

/// Global the page's boot script reads to learn that Mica is behind it. Set
/// from an initialization script, which runs before any of the page's own
/// scripts — including public/theme-boot.js, which turns it into
/// `<html data-backdrop="mica">` before the first paint.
pub(crate) const BACKDROP_GLOBAL: &str = "__SLOPUS_BACKDROP__";

/* ── Mica ─────────────────────────────────────────────────────────────────── */

/// Windows 11 is build 22000 and up; Mica exists from there on (documented
/// DWMSBT_MAINWINDOW from 22523, the undocumented attribute before that — the
/// window-vibrancy crate Tauri uses covers both). Windows 10 reports major
/// version 10 too, so only the build number tells them apart, and only
/// RtlGetVersion reports it truthfully: GetVersionEx lies to unmanifested apps.
#[cfg(windows)]
pub(crate) fn mica_supported() -> bool {
    use windows::Wdk::System::SystemServices::RtlGetVersion;
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    // SAFETY: `info` is a correctly sized, writable OSVERSIONINFOW.
    let status = unsafe { RtlGetVersion(&mut info) };
    status.is_ok() && info.dwMajorVersion >= 10 && info.dwBuildNumber >= 22000
}

#[cfg(not(windows))]
pub(crate) fn mica_supported() -> bool {
    false
}

/// The script that tells the page Mica is on. Kept as a function so the name
/// of the global is spelled once.
pub(crate) fn backdrop_script() -> String {
    format!("window.{BACKDROP_GLOBAL} = \"mica\";")
}

/// Whether this window was built with Mica behind it. Recorded once at
/// startup; window.rs reads it so its opaque ground never covers the backdrop.
#[derive(Default)]
pub(crate) struct Backdrop {
    pub(crate) mica: std::sync::atomic::AtomicBool,
}

impl Backdrop {
    pub(crate) fn is_mica(&self) -> bool {
        self.mica.load(std::sync::atomic::Ordering::Acquire)
    }
}

/// A frameless window keeps the Windows 11 rounded corners only if it asks for
/// them; without a caption DWM is free to square it off.
#[cfg(windows)]
pub(crate) fn round_corners<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };
    let Ok(hwnd) = window.hwnd() else { return };
    let preference = DWMWCP_ROUND;
    // SAFETY: a valid HWND and a pointer to a live 4-byte value. On Windows 10
    // the attribute does not exist and the call simply fails.
    let _ = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &preference as *const _ as *const core::ffi::c_void,
            std::mem::size_of_val(&preference) as u32,
        )
    };
}

#[cfg(not(windows))]
pub(crate) fn round_corners<R: Runtime>(_window: &tauri::WebviewWindow<R>) {}

/* ── WebView2: browser behaviour off ─────────────────────────────────────── */

/// Turns off what makes the webview act like a browser tab. Tauri and wry
/// already disable the status bar, pinch zoom and swipe navigation (both follow
/// `zoom_hotkeys_enabled` / `back_forward_navigation_gestures`, which default
/// off); what is left is set here on ICoreWebView2Settings directly.
///
/// Debug builds keep the browser accelerators and the default context menu so
/// F12 / "Inspect" still reach DevTools. The capture-phase keydown in
/// src/main.tsx covers the same reload/print/find keys in both builds.
pub(crate) fn disable_browser_behaviour<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(windows)]
    let _ = window.with_webview(|webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Settings3, ICoreWebView2Settings4,
        };
        use windows::core::Interface as _;
        // SAFETY: plain COM calls on the live controller Tauri hands us, on the
        // thread it hands it to us on.
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else { return };
            let Ok(settings) = core.Settings() else { return };
            let release = !cfg!(debug_assertions);
            if release {
                /* F5 / Ctrl+R reload (and lose unsaved edits), Ctrl+P prints,
                   Ctrl+F opens the Edge find bar, Ctrl+U views source. */
                if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
                    let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
                }
                /* The page shows its own menus (src/main.tsx asks Rust for a
                   native Cut/Copy/Paste menu over text). Edge's — Back, Reload,
                   "Search the web", Inspect — never appears. */
                let _ = settings.SetAreDefaultContextMenusEnabled(false);
            }
            if let Ok(settings4) = settings.cast::<ICoreWebView2Settings4>() {
                /* A prompt box is not an address form. general_autofill_enabled
                   on the builder covers this too; password autosave has no
                   builder switch. */
                let _ = settings4.SetIsGeneralAutofillEnabled(false);
                let _ = settings4.SetIsPasswordAutosaveEnabled(false);
            }
        }
    });
    #[cfg(not(windows))]
    let _ = window;
}

/* ── First launch size ───────────────────────────────────────────────────── */

/// The window's first size when nothing has been remembered yet: 80 % of the
/// primary monitor's WORK AREA (the screen minus the taskbar), in logical
/// pixels, never below the configured minimum. A fixed 1440×920 was 2160×1380
/// physical at 150 % — taller than a 1080p laptop.
pub(crate) fn first_launch_size(
    work_width: u32,
    work_height: u32,
    scale: f64,
    min: (f64, f64),
) -> (f64, f64) {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let width = (f64::from(work_width) / scale * 0.8).round();
    let height = (f64::from(work_height) / scale * 0.8).round();
    (width.max(min.0), height.max(min.1))
}

/// True when tauri-plugin-window-state has no file yet, i.e. this is the first
/// launch (or the user deleted it). The plugin restores size, position and the
/// maximized flag itself whenever the file exists.
pub(crate) fn window_state_missing<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.path()
        .app_config_dir()
        .map(|dir| !dir.join(tauri_plugin_window_state::DEFAULT_FILENAME).exists())
        .unwrap_or(true)
}

/* ── Accent colour ────────────────────────────────────────────────────────── */

/// The Windows accent palette as `#rrggbb`. `accent` is the user's colour;
/// the Light/Dark ramps are the shades Windows derives from it (WinUI uses
/// AccentDark1 as the fill in light theme and AccentLight2 in dark).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccentColors {
    pub(crate) accent: String,
    pub(crate) light1: String,
    pub(crate) light2: String,
    pub(crate) light3: String,
    pub(crate) dark1: String,
    pub(crate) dark2: String,
    pub(crate) dark3: String,
}

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn hex(r: u8, g: u8, b: u8) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// Holds the current palette and keeps the WinRT settings object alive: its
/// ColorValuesChanged event stops firing the moment it is dropped.
#[derive(Default)]
pub(crate) struct SystemAccent {
    current: std::sync::Mutex<Option<AccentColors>>,
    #[cfg(windows)]
    settings: std::sync::Mutex<Option<windows::UI::ViewManagement::UISettings>>,
}

#[cfg(windows)]
fn read_accent(
    settings: &windows::UI::ViewManagement::UISettings,
) -> windows::core::Result<AccentColors> {
    use windows::UI::ViewManagement::UIColorType;
    let get = |kind: UIColorType| -> windows::core::Result<String> {
        let color = settings.GetColorValue(kind)?;
        Ok(hex(color.R, color.G, color.B))
    };
    Ok(AccentColors {
        accent: get(UIColorType::Accent)?,
        light1: get(UIColorType::AccentLight1)?,
        light2: get(UIColorType::AccentLight2)?,
        light3: get(UIColorType::AccentLight3)?,
        dark1: get(UIColorType::AccentDark1)?,
        dark2: get(UIColorType::AccentDark2)?,
        dark3: get(UIColorType::AccentDark3)?,
    })
}

/// Reads the accent once and subscribes to changes. A failure anywhere leaves
/// the page on the palette's own blue — tokens.css — which is the fallback.
pub(crate) fn watch_accent<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(windows)]
    {
        use tauri::Emitter as _;
        use windows::Foundation::TypedEventHandler;
        use windows::UI::ViewManagement::UISettings;
        let Ok(settings) = UISettings::new() else { return };
        let state = app.state::<SystemAccent>();
        if let Ok(colors) = read_accent(&settings) {
            *state.current.lock().unwrap_or_else(|p| p.into_inner()) = Some(colors);
        }
        let handle = app.clone();
        /* Fires on a background thread, often several times for one change
           (once per derived shade). Only a real difference is sent on. */
        let handler = TypedEventHandler::new(move |_, _| {
            let Ok(fresh) = UISettings::new().and_then(|settings| read_accent(&settings)) else {
                return Ok(());
            };
            let state = handle.state::<SystemAccent>();
            let mut current = state.current.lock().unwrap_or_else(|p| p.into_inner());
            if current.as_ref() != Some(&fresh) {
                *current = Some(fresh.clone());
                drop(current);
                let _ = handle.emit(ACCENT_EVENT, fresh);
            }
            Ok(())
        });
        if settings.ColorValuesChanged(&handler).is_ok() {
            *state.settings.lock().unwrap_or_else(|p| p.into_inner()) = Some(settings);
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// The accent as last read, or `None` when the OS does not have one to give
/// (not Windows, or UISettings unavailable). The page asks once at startup
/// and then listens for ACCENT_EVENT, so a change between the two is not lost.
#[tauri::command]
pub(crate) fn system_accent_colors(state: tauri::State<'_, SystemAccent>) -> Option<AccentColors> {
    state.current.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/* ── Text context menu ───────────────────────────────────────────────────── */

const MENU_CUT: &str = "slopus-text-cut";
const MENU_COPY: &str = "slopus-text-copy";
const MENU_PASTE: &str = "slopus-text-paste";
const MENU_SELECT_ALL: &str = "slopus-text-select-all";

/// What the page knows about the text under the pointer.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextMenuRequest {
    /// An input or textarea the user can type in (Cut and Paste make sense).
    pub(crate) editable: bool,
    /// Something is selected (Cut and Copy have something to act on).
    pub(crate) has_selection: bool,
}

/// Shows a native Cut / Copy / Paste / Select all menu at the pointer in place
/// of Edge's (which offers "Search the web", writing assistance and Inspect).
/// The items do not touch the clipboard themselves: they replay the keyboard
/// shortcut into the focused field, exactly as muda's own predefined edit items
/// do, so undo history, input events and React's onChange all behave as if the
/// user had pressed the keys.
#[tauri::command]
pub(crate) fn show_text_context_menu(
    window: tauri::Window,
    request: TextMenuRequest,
) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    let handle = window.app_handle();
    let item = |id: &str, text: &str, enabled: bool, accelerator: &str| {
        MenuItem::with_id(handle, id, text, enabled, Some(accelerator))
    };
    let build = || -> tauri::Result<Menu<tauri::Wry>> {
        let menu = Menu::new(handle)?;
        if request.editable {
            menu.append(&item(MENU_CUT, "Cut", request.has_selection, "Ctrl+X")?)?;
        }
        menu.append(&item(MENU_COPY, "Copy", request.has_selection, "Ctrl+C")?)?;
        if request.editable {
            menu.append(&item(MENU_PASTE, "Paste", true, "Ctrl+V")?)?;
        }
        menu.append(&PredefinedMenuItem::separator(handle)?)?;
        menu.append(&item(MENU_SELECT_ALL, "Select all", true, "Ctrl+A")?)?;
        Ok(menu)
    };
    let menu = build().map_err(|error| format!("Could not build the text menu: {error}"))?;
    window
        .popup_menu(&menu)
        .map_err(|error| format!("Could not show the text menu: {error}"))
}

/// The text menu's items: the Ctrl shortcut Windows replays, and the editing
/// command WebKitGTK runs for the same item.
fn text_menu_item(id: &str) -> Option<(u8, &'static str)> {
    match id {
        MENU_CUT => Some((b'X', "Cut")),
        MENU_COPY => Some((b'C', "Copy")),
        MENU_PASTE => Some((b'V', "Paste")),
        MENU_SELECT_ALL => Some((b'A', "SelectAll")),
        _ => None,
    }
}

/// Routes a click on one of the text menu's items. Returns false for any other
/// menu, so the caller can keep one global handler.
pub(crate) fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    let Some((key, command)) = text_menu_item(id) else { return false };
    #[cfg(target_os = "linux")]
    {
        let _ = key;
        if let Some(window) = app.get_webview_window("main") {
            crate::linux_webview::execute_editing_command(&window, command);
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, command);
        send_ctrl_shortcut(key);
    }
    true
}

#[cfg(windows)]
fn send_ctrl_shortcut(key: u8) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VIRTUAL_KEY, VK_CONTROL,
    };
    let stroke = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                ..Default::default()
            },
        },
    };
    let letter = VIRTUAL_KEY(u16::from(key));
    let inputs = [
        stroke(VK_CONTROL, false),
        stroke(letter, false),
        stroke(letter, true),
        stroke(VK_CONTROL, true),
    ];
    // SAFETY: a stack array of fully initialised keyboard INPUTs.
    unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
}

#[cfg(not(any(windows, target_os = "linux")))]
fn send_ctrl_shortcut(_key: u8) {}

/* ── Files ────────────────────────────────────────────────────────────────── */

/// Opens Explorer with `path` selected. Only an absolute path that exists is
/// accepted: the argument is handed to explorer.exe's own command-line parser,
/// and a relative or made-up string has no business reaching it.
#[tauri::command]
pub(crate) fn reveal_in_explorer(path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(path);
    if !path.is_absolute() || !path.exists() {
        return Err(format!("{} does not exist.", path.display()));
    }
    #[cfg(windows)]
    std::process::Command::new("explorer.exe")
        .arg("/select,")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("Could not open File Explorer: {error}"))?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("Could not reveal the file: {error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        /* Files, Dolphin and most other file managers implement the
           FileManager1 interface and select the item; xdg-open can only open
           the folder around it. */
        let selected = std::process::Command::new("dbus-send")
            .args([
                "--session",
                "--print-reply",
                "--reply-timeout=5000",
                "--dest=org.freedesktop.FileManager1",
                "--type=method_call",
                "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1.ShowItems",
            ])
            .arg(format!("array:string:{}", file_uri(&path)))
            .arg("string:")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        if !selected {
            std::process::Command::new("xdg-open")
                .arg(path.parent().unwrap_or(&path))
                .spawn()
                .map_err(|error| format!("Could not open the folder: {error}"))?;
        }
    }
    Ok(())
}

/// A `file://` URI for an absolute path, percent-encoding everything but
/// unreserved characters and separators. dbus-send splits arrays on commas,
/// so those are encoded too.
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
pub(crate) fn file_uri(path: &std::path::Path) -> String {
    let mut uri = String::from("file://");
    for byte in path.to_string_lossy().bytes() {
        if byte.is_ascii_alphanumeric() || b"/-_.~".contains(&byte) {
            uri.push(char::from(byte));
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri
}

#[derive(Debug, Deserialize)]
pub(crate) struct FileFilter {
    pub(crate) name: String,
    pub(crate) extensions: Vec<String>,
}

/// The system Open dialog. `Ok(None)` is a cancel, not an error. Mirrors
/// `choose_export_destination` in export.rs, on a blocking thread so the
/// dialog's own message loop never waits on the one the webview needs.
#[tauri::command]
pub(crate) async fn pick_file(
    app: AppHandle,
    title: Option<String>,
    filters: Option<Vec<FileFilter>>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let mut dialog = app.dialog().file();
        if let Some(title) = title {
            dialog = dialog.set_title(title);
        }
        for filter in filters.unwrap_or_default() {
            let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(filter.name, &extensions);
        }
        let Some(selected) = dialog.blocking_pick_file() else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|error| format!("Could not use the selected file: {error}"))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| format!("The file dialog failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_launch_is_eighty_percent_of_the_work_area_in_logical_pixels() {
        // 1920×1040 work area (1080p minus the taskbar) at 150 %.
        assert_eq!(first_launch_size(1920, 1040, 1.5, (900.0, 650.0)), (1024.0, 650.0));
        // 2560×1400 at 100 %.
        assert_eq!(first_launch_size(2560, 1400, 1.0, (900.0, 650.0)), (2048.0, 1120.0));
    }

    #[test]
    fn first_launch_never_goes_below_the_minimum_or_divides_by_nothing() {
        assert_eq!(first_launch_size(800, 600, 1.0, (900.0, 650.0)), (900.0, 650.0));
        assert_eq!(first_launch_size(1000, 1000, 0.0, (100.0, 100.0)), (800.0, 800.0));
    }

    #[test]
    fn file_uris_encode_spaces_commas_and_unicode() {
        assert_eq!(
            file_uri(std::path::Path::new("/home/me/My Videos/a,b ä.mp4")),
            "file:///home/me/My%20Videos/a%2Cb%20%C3%A4.mp4"
        );
    }

    #[test]
    fn colours_are_lowercase_hash_hex() {
        assert_eq!(hex(0x00, 0x78, 0xd4), "#0078d4");
        assert_eq!(hex(255, 255, 255), "#ffffff");
    }

    #[test]
    fn only_the_text_menu_ids_are_claimed() {
        assert!(text_menu_item("something-else").is_none());
        assert_eq!(text_menu_item(MENU_SELECT_ALL), Some((b'A', "SelectAll")));
    }

    #[test]
    fn the_backdrop_script_sets_the_global_the_boot_script_reads() {
        assert_eq!(backdrop_script(), "window.__SLOPUS_BACKDROP__ = \"mica\";");
    }
}
