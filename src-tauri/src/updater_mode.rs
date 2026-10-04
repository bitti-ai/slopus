//! A loose executable is portable unless an installer owns its exact location.
pub(crate) fn detect() -> Result<&'static str, String> {
    if cfg!(debug_assertions) {
        return Ok("disabled");
    }
    // Tauri can replace an AppImage. Other Linux packages update through their
    // package manager or the releases page, not the AppImage updater payload.
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_some() {
        return Ok("installed");
    }
    #[cfg(windows)]
    if windows::is_registered(&std::env::current_exe().map_err(|error| error.to_string())?) {
        return Ok("installed");
    }
    Ok("portable")
}

#[cfg(any(windows, test))]
fn matches_install(
    executable: &std::path::Path,
    name: &str,
    publisher: &str,
    location: &str,
) -> bool {
    if !name.eq_ignore_ascii_case("Slopus")
        || !publisher.eq_ignore_ascii_case("slopus")
        || !executable
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("slopus.exe"))
    {
        return false;
    }
    // NSIS quotes InstallLocation; WiX writes the unquoted directory with a
    // trailing separator. Do not accept relative, missing or stale locations.
    let location = location.trim();
    let location = location
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(location);
    let directory = std::path::Path::new(location);
    if !directory.is_absolute() {
        return false;
    }
    let (Ok(executable), Ok(directory)) = (executable.canonicalize(), directory.canonicalize())
    else {
        return false;
    };
    executable.parent() == Some(directory.as_path())
}

#[cfg(windows)]
mod windows {
    use std::{path::Path, ptr};
    use windows_sys::Win32::{Foundation::ERROR_SUCCESS, System::Registry::*};

    const UNINSTALL: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";

    struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    fn string(key: HKEY, subkey: &[u16], name: &str) -> Option<String> {
        let name = wide(name);
        let mut bytes = 0;
        // Read only REG_SZ, as written by both shipped Windows installers.
        if unsafe {
            RegGetValueW(
                key,
                subkey.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut bytes,
            )
        } != ERROR_SUCCESS
            || bytes == 0
            || bytes > 65_536
            || bytes % 2 != 0
        {
            return None;
        }
        let mut buffer = vec![0u16; bytes as usize / 2];
        if unsafe {
            RegGetValueW(
                key,
                subkey.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut bytes,
            )
        } != ERROR_SUCCESS
        {
            return None;
        }
        let end = buffer
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(buffer.len());
        String::from_utf16(&buffer[..end]).ok()
    }

    pub(super) fn is_registered(executable: &Path) -> bool {
        let uninstall = wide(UNINSTALL);
        // NSIS uses a named key; MSI uses a product GUID. Enumerating the
        // uninstall records supports both, including already-installed releases.
        // Check user/machine scopes and both registry views for custom installs.
        for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
                let mut raw = ptr::null_mut();
                if unsafe { RegOpenKeyExW(root, uninstall.as_ptr(), 0, KEY_READ | view, &mut raw) }
                    != ERROR_SUCCESS
                {
                    continue;
                }
                let key = Key(raw);
                let mut index = 0;
                loop {
                    // Registry key names are at most 255 UTF-16 characters.
                    let mut subkey = [0u16; 256];
                    let mut length = subkey.len() as u32;
                    if unsafe {
                        RegEnumKeyExW(
                            key.0,
                            index,
                            subkey.as_mut_ptr(),
                            &mut length,
                            ptr::null(),
                            ptr::null_mut(),
                            ptr::null_mut(),
                            ptr::null_mut(),
                        )
                    } != ERROR_SUCCESS
                    {
                        break;
                    }
                    index += 1;
                    let Some(name) = string(key.0, &subkey, "DisplayName") else {
                        continue;
                    };
                    if !name.eq_ignore_ascii_case("Slopus") {
                        continue;
                    }
                    let Some(publisher) = string(key.0, &subkey, "Publisher") else {
                        continue;
                    };
                    let Some(location) = string(key.0, &subkey, "InstallLocation") else {
                        continue;
                    };
                    if super::matches_install(executable, &name, &publisher, &location) {
                        return true;
                    }
                }
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn recognizes_nsis_and_msi_locations_including_custom_install_folders() {
        let installed = tempfile::tempdir().unwrap();
        let executable = installed.path().join("Slopus.exe");
        fs::write(&executable, []).unwrap();
        let location = installed.path().to_string_lossy();
        assert!(matches_install(
            &executable,
            "Slopus",
            "slopus",
            &format!("\"{location}\"")
        ));
        assert!(matches_install(
            &executable,
            "SLOPUS",
            "Slopus",
            &format!("{location}/")
        ));
    }

    #[test]
    fn a_loose_copy_is_portable_even_when_slopus_is_installed_elsewhere() {
        let installed = tempfile::tempdir().unwrap();
        let portable = tempfile::tempdir().unwrap();
        let executable = portable.path().join("slopus.exe");
        fs::write(&executable, []).unwrap();
        fs::write(portable.path().join("slopfab.dll"), []).unwrap();
        assert!(!matches_install(
            &executable,
            "Slopus",
            "slopus",
            &installed.path().to_string_lossy()
        ));
        // A similarly named directory or a loose copy beneath an installation
        // is not the installed application either.
        let child = installed.path().join("portable");
        fs::create_dir(&child).unwrap();
        fs::copy(&executable, child.join("slopus.exe")).unwrap();
        assert!(!matches_install(
            &child.join("slopus.exe"),
            "Slopus",
            "slopus",
            &installed.path().to_string_lossy()
        ));
    }

    #[test]
    fn unrelated_incomplete_or_stale_registry_entries_do_not_enable_installation() {
        let installed = tempfile::tempdir().unwrap();
        let executable = installed.path().join("slopus.exe");
        fs::write(&executable, []).unwrap();
        let location = installed.path().to_string_lossy();
        assert!(!matches_install(
            &executable,
            "Another app",
            "slopus",
            &location
        ));
        assert!(!matches_install(
            &executable,
            "Slopus",
            "Other publisher",
            &location
        ));
        for location in [
            "",
            ".",
            "relative/install",
            "\"unterminated",
            "Z:/missing-slopus-install",
        ] {
            assert!(!matches_install(&executable, "Slopus", "slopus", location));
        }
        assert!(!matches_install(
            &installed.path().join("missing.exe"),
            "Slopus",
            "slopus",
            &location
        ));
    }

    #[test]
    fn debug_builds_disable_the_updater() {
        if cfg!(debug_assertions) {
            assert_eq!(detect().unwrap(), "disabled");
        }
    }
}
