use std::{fs, io, path::{Path, PathBuf}};
use tauri::{AppHandle, Manager};

/// Keep the installed app identity stable while using a readable data directory.
pub fn data_directory(app: &AppHandle) -> PathBuf {
    app.path().local_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("Slopus")
}

/// Runs before WebView2 opens its profile or diagnostics opens the current log.
pub fn prepare(app: &AppHandle) -> io::Result<PathBuf> {
    let destination = data_directory(app);
    let legacy = destination.parent().unwrap().join("com.slopus.desktop");
    migrate(&legacy, &destination)?;
    Ok(destination)
}

fn move_missing(source: &Path, destination: &Path) -> io::Result<()> {
    if !source.is_dir() { return Ok(()); }
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        // Never combine WebView database directories or replace newer files.
        if !target.exists() { fs::rename(entry.path(), target)?; }
    }
    if fs::read_dir(source)?.next().is_none() { fs::remove_dir(source)?; }
    Ok(())
}

fn migrate(legacy: &Path, destination: &Path) -> io::Result<()> {
    if legacy.is_dir() && !destination.exists() {
        fs::rename(legacy, destination)?;
    }
    fs::create_dir_all(destination)?;
    let icons = destination.join("reference-icons");
    move_missing(&destination.join("logs/reference-icons"), &icons)?;
    move_missing(&legacy.join("reference-icons"), &icons)?;
    move_missing(&legacy.join("logs/reference-icons"), &icons)?;
    move_missing(&legacy.join("logs"), &destination.join("logs"))?;
    move_missing(legacy, destination)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_the_profile_logs_and_icons_before_startup() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("com.slopus.desktop");
        let destination = temp.path().join("Slopus");
        fs::create_dir_all(legacy.join("EBWebView")).unwrap();
        fs::create_dir_all(legacy.join("logs/reference-icons")).unwrap();
        fs::write(legacy.join("EBWebView/preferences"), b"settings").unwrap();
        fs::write(legacy.join("logs/slopus.log"), b"previous session").unwrap();
        fs::write(legacy.join("logs/reference-icons/alice.jpg"), b"finished icon").unwrap();
        migrate(&legacy, &destination).unwrap();
        assert!(!legacy.exists());
        assert!(!destination.join("logs/reference-icons").exists());
        assert_eq!(fs::read(destination.join("EBWebView/preferences")).unwrap(), b"settings");
        assert_eq!(fs::read(destination.join("logs/slopus.log")).unwrap(), b"previous session");
        assert_eq!(fs::read(destination.join("reference-icons/alice.jpg")).unwrap(), b"finished icon");
        migrate(&legacy, &destination).unwrap();
    }

    #[test]
    fn preserves_existing_data_and_keeps_conflicting_legacy_files() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("com.slopus.desktop");
        let destination = temp.path().join("Slopus");
        for root in [&legacy, &destination] {
            fs::create_dir_all(root.join("EBWebView")).unwrap();
            fs::create_dir_all(root.join("reference-icons")).unwrap();
        }
        fs::write(legacy.join("EBWebView/preferences"), b"old").unwrap();
        fs::write(destination.join("EBWebView/preferences"), b"new").unwrap();
        fs::write(legacy.join("reference-icons/alice.jpg"), b"old icon").unwrap();
        fs::write(destination.join("reference-icons/alice.jpg"), b"new icon").unwrap();
        fs::write(legacy.join("reference-icons/bob.jpg"), b"other icon").unwrap();
        migrate(&legacy, &destination).unwrap();
        assert_eq!(fs::read(destination.join("EBWebView/preferences")).unwrap(), b"new");
        assert_eq!(fs::read(legacy.join("EBWebView/preferences")).unwrap(), b"old");
        assert_eq!(fs::read(destination.join("reference-icons/alice.jpg")).unwrap(), b"new icon");
        assert_eq!(fs::read(legacy.join("reference-icons/alice.jpg")).unwrap(), b"old icon");
        assert!(destination.join("reference-icons/bob.jpg").is_file());
    }
}
