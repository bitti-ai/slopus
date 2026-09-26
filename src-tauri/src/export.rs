//! Getting a finished export out of the webview and onto the disk.
//!
//! The encode itself happens in the webview — WebCodecs owns the OS hardware
//! encoder, and there is no FFmpeg here by design. Rust does the things the
//! webview cannot: open the platform's save dialog (starting in the folder the
//! last export went to), propose a default destination before any dialog has
//! been shown, write the bytes to the path the user picked, open the finished
//! file, and read the one kind of side file the editor imports by path — a
//! `.cube` colour LUT picked in the native Open dialog.
//!
//! The bytes arrive as a RAW ipc body rather than as command arguments. A
//! 200 MB file serialised as a JSON array of numbers is well over a gigabyte of
//! text, which is enough to take the window down; the raw body is the same
//! bytes with no encoding at all. That leaves nowhere to put the destination
//! path, so it rides in a header — percent-encoded, because a header may only
//! carry ASCII and a Windows path may not be.

use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager,
};
use tauri_plugin_dialog::DialogExt;

const PATH_HEADER: &str = "x-export-path";

/// Strips anything that would turn a file name into a path, so a project called
/// `../../etc` can only ever suggest a name inside the folder the user chose.
fn safe_file_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            other if (other as u32) < 0x20 => ' ',
            other => other,
        })
        .collect();
    let trimmed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() {
        "Slopus export.mp4".to_string()
    } else {
        trimmed
    }
}

/// Decodes `encodeURIComponent` output back to the path the user chose. Only
/// `%XX` is special; everything else is already the character it looks like.
/// Shared with the generated-video write, which carries its own paths in
/// headers for the same reason: a raw body leaves nowhere else to put them.
pub(crate) use crate::commands::binary::percent_decode;

/// Destinations the save dialog returned in THIS run.
///
/// The path makes a round trip through the webview between the dialog and the
/// write, so what comes back is a string the webview chose — and a string that
/// merely ends in `.mp4` and sits in an existing folder is every `.mp4` on the
/// disk. Shape checks cannot tell "the file the user named" from "a file that
/// looks like one", so the write is tied to the dialog's own answer instead.
/// Never written to disk, never survives a restart: an export always starts
/// with the dialog, so there is nothing to remember across runs.
static CHOSEN_DESTINATIONS: std::sync::LazyLock<std::sync::Mutex<BTreeSet<PathBuf>>> =
    std::sync::LazyLock::new(Default::default);

/// The identity a destination is remembered by. The file itself usually does
/// not exist yet, so only the FOLDER is canonicalised; the name is compared as
/// written, which is exactly the string the dialog handed out and the webview
/// hands back.
fn destination_key(path: &Path) -> PathBuf {
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return path.to_path_buf();
    };
    parent
        .canonicalize()
        .unwrap_or_else(|_| parent.to_path_buf())
        .join(name)
}

fn remember_destination(path: &Path) {
    // A poisoned lock only means another thread panicked mid-insert. Failing
    // the export is the safe direction, so nothing is escalated here.
    if let Ok(mut chosen) = CHOSEN_DESTINATIONS.lock() {
        chosen.insert(destination_key(path));
    }
}

fn was_chosen_this_session(path: &Path) -> bool {
    CHOSEN_DESTINATIONS
        .lock()
        .map(|chosen| chosen.contains(&destination_key(path)))
        .unwrap_or(false)
}

/// Checks the SHAPE of a destination: absolute, `.mp4`, in a folder that
/// exists, not itself a folder. Necessary and not sufficient — see
/// [`authorized_destination`], which is what the write actually goes through.
fn checked_destination(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(format!("{value} is not a full path."));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if extension.as_deref() != Some("mp4") {
        return Err(format!("{value} does not end in .mp4."));
    }
    let parent = path
        .parent()
        .ok_or_else(|| format!("{value} has no folder to write into."))?;
    if !parent.is_dir() {
        return Err(format!("{} is not a folder.", parent.to_string_lossy()));
    }
    if path.is_dir() {
        return Err(format!("{value} is a folder, not a file."));
    }
    Ok(path)
}

/// The one destination this command will write to: a well-shaped path that the
/// save dialog itself returned earlier in this run. Without the second half,
/// "untrusted on the way back in" only ever meant "constrained to .mp4" — which
/// still lets a webview silently overwrite any existing .mp4 on the disk.
fn authorized_destination(value: &str) -> Result<PathBuf, String> {
    let path = checked_destination(value)?;
    if !was_chosen_this_session(&path) {
        return Err(format!(
            "{value} is not a destination the save dialog returned; choose where to export again."
        ));
    }
    Ok(path)
}

/// Writes beside the destination and renames on top of it, so an export that
/// fails half way through cannot leave a truncated file where a playable one
/// used to be. Flush the complete file before atomically publishing it.
pub(crate) use crate::storage::atomic::write_atomically;

/// Where the last export went, kept beside the app's settings so the next
/// export (and the Save dialog) starts there. One line: the folder path.
const LAST_FOLDER_FILE: &str = "last-export-folder.txt";

fn last_folder_store(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(LAST_FOLDER_FILE))
}

/// The folder the last export was written to, if it still exists.
fn last_export_folder(app: &AppHandle) -> Option<PathBuf> {
    let text = std::fs::read_to_string(last_folder_store(app)?).ok()?;
    let folder = PathBuf::from(text.trim());
    (folder.is_absolute() && folder.is_dir()).then_some(folder)
}

fn remember_export_folder(app: &AppHandle, destination: &Path) {
    let (Some(store), Some(folder)) = (last_folder_store(app), destination.parent()) else {
        return;
    };
    // Best effort: forgetting the folder costs one extra click next time.
    if let Some(parent) = store.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(store, folder.to_string_lossy().as_bytes());
}

/// The folder an export starts in: the last one used, else the user's Videos
/// folder, else their home folder.
fn starting_folder(app: &AppHandle) -> Option<PathBuf> {
    last_export_folder(app)
        .or_else(|| app.path().video_dir().ok().filter(|dir| dir.is_dir()))
        .or_else(|| app.path().home_dir().ok().filter(|dir| dir.is_dir()))
}

/// Makes `name` an `.mp4` file name: sanitised, with the extension added when
/// the suggestion lacks it.
fn mp4_file_name(name: &str) -> String {
    let safe = safe_file_name(name);
    if safe.to_ascii_lowercase().ends_with(".mp4") {
        safe
    } else {
        format!("{safe}.mp4")
    }
}

/// Opens the platform's save dialog, starting in the last export folder (or
/// Videos). `Ok(None)` means the user cancelled, which is not an error. Runs
/// on a blocking thread so the dialog's own message loop never waits on the
/// one the webview needs (see `pick_file` in native_shell.rs).
#[tauri::command]
pub async fn choose_export_destination(
    app: AppHandle,
    suggested_name: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app
            .dialog()
            .file()
            .set_title("Export video")
            .set_file_name(mp4_file_name(&suggested_name))
            .add_filter("MP4 video", &["mp4"]);
        if let Some(folder) = starting_folder(&app) {
            dialog = dialog.set_directory(folder);
        }
        let Some(selected) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|error| format!("Could not use the selected path: {error}"))?;
        // The write end will only accept a path that came through here.
        remember_destination(&path);
        remember_export_folder(&app, &path);
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| format!("The save dialog stopped unexpectedly: {error}"))?
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultDestination {
    path: String,
    exists: bool,
}

/// The destination the Export screen shows before the user has opened any
/// dialog: the suggested name in the last export folder (or Videos). Rust
/// builds the whole path itself — the webview only supplies a name, which is
/// sanitised — so authorising it cannot open anything outside those folders.
#[tauri::command]
pub fn default_export_destination(
    app: AppHandle,
    suggested_name: String,
) -> Result<Option<DefaultDestination>, String> {
    let Some(folder) = starting_folder(&app) else {
        return Ok(None);
    };
    let path = folder.join(mp4_file_name(&suggested_name));
    checked_destination(&path.to_string_lossy())?;
    remember_destination(&path);
    Ok(Some(DefaultDestination {
        exists: path.exists(),
        path: path.to_string_lossy().into_owned(),
    }))
}

/// Whether an authorised destination already holds a file, so the page can
/// ask before replacing it.
#[tauri::command]
pub fn export_destination_exists(path: String) -> Result<bool, String> {
    Ok(authorized_destination(&path)?.exists())
}

/// Opens a finished export in the default video player. Only a destination
/// this run was allowed to export to can be opened, so the command cannot be
/// used to launch arbitrary files.
#[tauri::command]
pub fn open_export_file(path: String) -> Result<(), String> {
    let path = authorized_destination(&path)?;
    if !path.is_file() {
        return Err(format!("{} does not exist.", path.display()));
    }
    #[cfg(windows)]
    std::process::Command::new("explorer.exe")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("Could not open the video: {error}"))?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("Could not open the video: {error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("Could not open the video: {error}"))?;
    Ok(())
}

/// The largest LUT the editor accepts — the same limit as MAX_LUT_FILE_BYTES in
/// src/lib/effectSettings.ts.
const MAX_LUT_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// Checks a LUT path's shape: absolute, `.cube`, an existing file no larger
/// than the limit.
fn checked_lut_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(format!("{value} is not a full path."));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if extension.as_deref() != Some("cube") {
        return Err("Choose a 3D .cube LUT file.".to_string());
    }
    let metadata = std::fs::metadata(&path).map_err(|_| format!("{value} does not exist."))?;
    if !metadata.is_file() {
        return Err(format!("{value} is not a file."));
    }
    if metadata.len() > MAX_LUT_FILE_BYTES {
        return Err("LUT files must be smaller than 16 MB.".to_string());
    }
    Ok(path)
}

/// Reads the text of a `.cube` LUT the user picked in the Open dialog. The
/// webview cannot read arbitrary paths itself; this reads only `.cube` files
/// under the size limit, and parsing stays in the page (effectSettings.ts).
#[tauri::command]
pub fn read_lut_file(path: String) -> Result<String, String> {
    let path = checked_lut_path(&path)?;
    let bytes = std::fs::read(&path).map_err(|error| format!("Could not read the LUT: {error}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Writes the muxed MP4 to the chosen path and reports how many bytes landed,
/// so the frontend can state the size of a file that demonstrably exists rather
/// than the size it hoped for.
#[tauri::command]
pub fn write_export_file(app: AppHandle, request: Request<'_>) -> Result<u64, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("The export was sent as JSON instead of raw bytes.".to_string());
    };
    if bytes.is_empty() {
        return Err("The export produced no bytes, so nothing was written.".to_string());
    }
    let header = request
        .headers()
        .get(PATH_HEADER)
        .ok_or_else(|| format!("The export request carried no {PATH_HEADER} header."))?;
    let encoded = header
        .to_str()
        .map_err(|_| "The export path header is not readable text.".to_string())?;
    let destination = authorized_destination(&percent_decode(encoded)?)?;
    write_atomically(&destination, bytes)?;
    remember_export_folder(&app, &destination);
    Ok(bytes.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn percent_decode_restores_a_windows_path() {
        assert_eq!(
            percent_decode("C%3A%5CUsers%5CNN%5CNorthern%20Light.mp4").unwrap(),
            "C:\\Users\\NN\\Northern Light.mp4"
        );
    }

    #[test]
    fn percent_decode_restores_non_ascii_names() {
        // encodeURIComponent("/tmp/Grüße 映画.mp4")
        assert_eq!(
            percent_decode("%2Ftmp%2FGr%C3%BC%C3%9Fe%20%E6%98%A0%E7%94%BB.mp4").unwrap(),
            "/tmp/Grüße 映画.mp4"
        );
    }

    #[test]
    fn percent_decode_rejects_a_truncated_escape() {
        assert!(percent_decode("C%3A%5").is_err());
        assert!(percent_decode("C%zz.mp4").is_err());
    }

    #[test]
    fn safe_file_name_strips_separators() {
        assert_eq!(
            safe_file_name("../../etc/passwd.mp4"),
            ".. .. etc passwd.mp4"
        );
        assert_eq!(safe_file_name("   "), "Slopus export.mp4");
        assert_eq!(safe_file_name("Northern Light.mp4"), "Northern Light.mp4");
    }

    #[test]
    fn destinations_must_be_absolute_mp4_files_in_a_real_folder() {
        let folder = tempfile::tempdir().unwrap();
        let good = folder.path().join("cut.mp4");
        assert_eq!(checked_destination(&good.to_string_lossy()).unwrap(), good);
        assert!(checked_destination("cut.mp4").is_err());
        assert!(checked_destination(&folder.path().join("cut.mov").to_string_lossy()).is_err());
        assert!(checked_destination(
            &folder
                .path()
                .join("missing")
                .join("cut.mp4")
                .to_string_lossy()
        )
        .is_err());
        assert!(checked_destination(&folder.path().to_string_lossy()).is_err());
    }

    /// S4: shape is not permission. Before the session list, any absolute
    /// `.mp4` under any existing folder was writable, so a webview that never
    /// opened the save dialog could name — and silently overwrite — a finished
    /// film somewhere else on the disk.
    #[test]
    fn only_a_destination_the_dialog_returned_may_be_written() {
        let folder = tempfile::tempdir().unwrap();
        let someone_elses_film = folder.path().join("Wedding final cut.mp4");
        fs::write(&someone_elses_film, b"a year of work").unwrap();

        // Well-shaped in every way the old check asked about, and refused.
        let error = authorized_destination(&someone_elses_film.to_string_lossy()).unwrap_err();
        assert!(
            error.contains("not a destination the save dialog returned"),
            "unexpected error: {error}"
        );
        assert_eq!(fs::read(&someone_elses_film).unwrap(), b"a year of work");

        // What the dialog handed out is writable, spelled the same way or not.
        let chosen = folder.path().join("Northern Light.mp4");
        remember_destination(&chosen);
        assert_eq!(
            authorized_destination(&chosen.to_string_lossy()).unwrap(),
            chosen
        );
        let roundabout = folder.path().join(".").join("Northern Light.mp4");
        assert!(authorized_destination(&roundabout.to_string_lossy()).is_ok());

        // Choosing one file does not open its neighbours.
        let neighbour = folder.path().join("Northern Light 2.mp4");
        assert!(authorized_destination(&neighbour.to_string_lossy()).is_err());
    }

    #[test]
    fn mp4_file_names_gain_the_extension_once() {
        assert_eq!(mp4_file_name("Northern Light"), "Northern Light.mp4");
        assert_eq!(mp4_file_name("Northern Light.MP4"), "Northern Light.MP4");
        assert_eq!(mp4_file_name("a/b"), "a b.mp4");
    }

    #[test]
    fn lut_paths_must_be_cube_files_under_the_limit() {
        let folder = tempfile::tempdir().unwrap();
        let cube = folder.path().join("look.cube");
        fs::write(&cube, b"LUT_3D_SIZE 2").unwrap();
        assert_eq!(
            read_lut_file(cube.to_string_lossy().into_owned()).unwrap(),
            "LUT_3D_SIZE 2"
        );
        let other = folder.path().join("look.txt");
        fs::write(&other, b"LUT_3D_SIZE 2").unwrap();
        assert!(checked_lut_path(&other.to_string_lossy()).is_err());
        assert!(checked_lut_path("look.cube").is_err());
        assert!(checked_lut_path(&folder.path().join("missing.cube").to_string_lossy()).is_err());
    }

    #[test]
    fn only_authorised_destinations_can_be_opened_or_checked() {
        let folder = tempfile::tempdir().unwrap();
        let film = folder.path().join("Somebody else.mp4");
        fs::write(&film, b"x").unwrap();
        assert!(open_export_file(film.to_string_lossy().into_owned()).is_err());
        assert!(export_destination_exists(film.to_string_lossy().into_owned()).is_err());
        remember_destination(&film);
        assert!(export_destination_exists(film.to_string_lossy().into_owned()).unwrap());
    }

    #[test]
    fn writing_replaces_an_existing_file_and_leaves_no_part_file() {
        let folder = tempfile::tempdir().unwrap();
        let destination = folder.path().join("cut.mp4");
        fs::write(&destination, b"old").unwrap();
        write_atomically(&destination, b"new bytes").unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"new bytes");
        assert!(!folder.path().join("cut.mp4.part").exists());
    }
}
