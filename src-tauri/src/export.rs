//! Getting a finished export out of the webview and onto the disk.
//!
//! The encode itself happens in the webview — WebCodecs owns the OS hardware
//! encoder, and there is no FFmpeg here by design. Rust does the two things the
//! webview cannot: open the platform's save dialog, and write the bytes to the
//! path the user picked.
//!
//! The bytes arrive as a RAW ipc body rather than as command arguments. A
//! 200 MB file serialised as a JSON array of numbers is well over a gigabyte of
//! text, which is enough to take the window down; the raw body is the same
//! bytes with no encoding at all. That leaves nowhere to put the destination
//! path, so it rides in a header — percent-encoded, because a header may only
//! carry ASCII and a Windows path may not be.

use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle,
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
        "PolStudio export.mp4".to_string()
    } else {
        trimmed
    }
}

/// Decodes `encodeURIComponent` output back to the path the user chose. Only
/// `%XX` is special; everything else is already the character it looks like.
fn percent_decode(value: &str) -> Result<String, String> {
    let source = value.as_bytes();
    let mut bytes = Vec::with_capacity(source.len());
    let mut index = 0;
    while index < source.len() {
        if source[index] == b'%' {
            let digits = source
                .get(index + 1..index + 3)
                .ok_or_else(|| "The export path was cut short after a % escape.".to_string())?;
            let text = std::str::from_utf8(digits)
                .map_err(|_| "The export path has a malformed % escape.".to_string())?;
            let byte = u8::from_str_radix(text, 16)
                .map_err(|_| format!("The export path has a malformed % escape: %{text}"))?;
            bytes.push(byte);
            index += 3;
        } else {
            bytes.push(source[index]);
            index += 1;
        }
    }
    String::from_utf8(bytes).map_err(|_| "The export path is not valid UTF-8.".to_string())
}

/// Checks a destination before anything is written to it. The path came back
/// from the OS dialog, but it made a round trip through the webview to get
/// here, so it is treated as untrusted on the way back in.
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

/// Writes beside the destination and renames on top of it, so an export that
/// fails half way through cannot leave a truncated file where a playable one
/// used to be. `fs::rename` replaces the destination on both platforms here.
fn write_atomically(destination: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut temporary = destination.as_os_str().to_os_string();
    temporary.push(".part");
    let temporary = PathBuf::from(temporary);
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write {}: {error}", temporary.to_string_lossy()))?;
    if let Err(error) = fs::rename(&temporary, destination) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "Could not save {}: {error}",
            destination.to_string_lossy()
        ));
    }
    Ok(())
}

/// Opens the platform's save dialog. `Ok(None)` means the user cancelled, which
/// is not an error.
#[tauri::command]
pub fn choose_export_destination(
    app: AppHandle,
    suggested_name: String,
) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Export video")
        .set_file_name(safe_file_name(&suggested_name))
        .add_filter("MP4 video", &["mp4"])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("Could not use the selected path: {error}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Writes the muxed MP4 to the chosen path and reports how many bytes landed,
/// so the frontend can state the size of a file that demonstrably exists rather
/// than the size it hoped for.
#[tauri::command]
pub fn write_export_file(request: Request<'_>) -> Result<u64, String> {
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
    let destination = checked_destination(&percent_decode(encoded)?)?;
    write_atomically(&destination, bytes)?;
    Ok(bytes.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(safe_file_name("   "), "PolStudio export.mp4");
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
