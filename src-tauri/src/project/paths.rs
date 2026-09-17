use super::storage::project_file_in;
use std::path::{Path, PathBuf};

/// Canonical identity of an existing project. All project artifact I/O resolves
/// through this boundary, including directories redirected by junctions.
#[derive(Debug, Clone)]
pub(crate) struct ProjectRoot(PathBuf);

impl ProjectRoot {
    /// Used while creating a project, before its config file exists.
    pub(crate) fn from_directory(folder: &Path) -> Result<Self, String> {
        let root = folder
            .canonicalize()
            .map_err(|error| format!("Could not resolve project folder: {error}"))?;
        if !root.is_dir() {
            return Err("The selected project folder does not exist.".into());
        }
        Ok(Self(root))
    }
    pub(crate) fn open(folder: &str) -> Result<Self, String> {
        project_root(folder).map(Self)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }

    pub(crate) fn existing(&self, relative: &str) -> Result<PathBuf, String> {
        let relative = normalize_project_path(relative)?;
        let target = self
            .0
            .join(relative)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        self.check_containment(&target)?;
        Ok(target)
    }

    /// Check each existing ancestor before creating the next component. Checking
    /// only after create_dir_all could already create directories outside the root.
    pub(crate) fn directory(&self, relative: &str) -> Result<PathBuf, String> {
        let relative = normalize_project_path(relative)?;
        let mut directory = self.0.clone();
        for component in relative.split('/') {
            directory.push(component);
            match std::fs::create_dir(&directory) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(format!("Could not prepare project directory: {error}")),
            }
            directory = directory
                .canonicalize()
                .map_err(|error| error.to_string())?;
            self.check_containment(&directory)?;
            if !directory.is_dir() {
                return Err("The project destination is not a directory.".into());
            }
        }
        Ok(directory)
    }

    fn check_containment(&self, target: &Path) -> Result<(), String> {
        if !target.starts_with(&self.0) {
            return Err("Project files must stay inside the project folder.".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_destinations_reject_traversal_and_redirected_ancestors() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(project.join("slopus.json"), "{}").unwrap();
        let root = ProjectRoot::open(project.to_str().unwrap()).unwrap();
        assert!(root.directory("../outside").is_err());
        assert!(root
            .directory("cache/frames")
            .unwrap()
            .starts_with(root.path()));

        let link = project.join("media");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let status = std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path $env:SLOPUS_TEST_LINK -Target $env:SLOPUS_TEST_TARGET | Out-Null"])
                .env("SLOPUS_TEST_LINK", &link)
                .env("SLOPUS_TEST_TARGET", &outside)
                .creation_flags(0x0800_0000)
                .status().unwrap();
            assert!(status.success());
        }
        assert!(root.directory("media/generated").is_err());
        assert!(!outside.join("generated").exists());
        std::fs::write(outside.join("frame.jpg"), b"outside").unwrap();
        assert!(root.existing("media/frame.jpg").is_err());
    }
}
pub(crate) fn normalize_project_path(value: &str) -> Result<String, String> {
    if value.is_empty() || value.contains('\0') {
        return Err("Project paths cannot be empty or contain null bytes.".into());
    }
    let scheme_or_drive_prefix = value
        .find(':')
        .map(|colon| {
            colon > 0
                && value.as_bytes()[0].is_ascii_alphabetic()
                && value.as_bytes()[..colon]
                    .iter()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'+' | b'-' | b'.'))
        })
        .unwrap_or(false);
    if value.starts_with('/') || value.starts_with('\\') || scheme_or_drive_prefix {
        return Err("Project paths must be relative to the project root.".into());
    }
    let mut normalized = Vec::new();
    let portable = value.replace('\\', "/");
    for component in portable.split('/') {
        match component {
            "" | "." => {}
            ".." => return Err("Project paths cannot traverse outside the project root.".into()),
            value => normalized.push(value),
        }
    }
    if normalized.is_empty() {
        return Err("Project paths must point to an item below the project root.".into());
    }
    Ok(normalized.join("/"))
}

/// The other kind of stored location: a file the project points at but does
/// NOT contain. Video and audio are never copied — a 40 GB rush is not going to
/// be duplicated into a project folder — so the project records where the user
/// already keeps it.
///
/// It must be ABSOLUTE, because it is resolved against nothing: no working
/// directory, no project root. `..` is refused so the recorded string is the
/// same string every comparison sees; canonicalised paths never contain one.
/// The separators are left exactly as the OS wrote them. This mirrors
/// `normalizeExternalPath` in src/lib/project.ts and must keep mirroring it in
/// both directions.
pub(crate) fn normalize_external_path(value: &str) -> Result<String, String> {
    if value.is_empty() || value.contains('\0') {
        return Err("External media paths cannot be empty or contain null bytes.".into());
    }
    let bytes = value.as_bytes();
    let windows_drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    if !(windows_drive || value.starts_with("\\\\") || value.starts_with('/')) {
        return Err(format!(
            "External media must be recorded as an absolute path, received '{value}'."
        ));
    }
    if value.split(['\\', '/']).any(|component| component == "..") {
        return Err("External media paths cannot contain '..'.".into());
    }
    Ok(value.to_string())
}

/// Every location a project can hold is one of two things and never both: a
/// file inside the folder, or a file outside it. `label` names the record so
/// the message points at the row the user has to fix.
pub(crate) fn check_one_location(
    label: &str,
    relative_path: Option<&String>,
    source_path: Option<&String>,
) -> Result<(), String> {
    match (relative_path, source_path) {
        (Some(_), Some(_)) => Err(format!(
            "{label} cannot have both a project-relative path and an external source path."
        )),
        (None, None) => Err(format!(
            "{label} must have either a project-relative path or an external source path."
        )),
        _ => Ok(()),
    }
}

/// `Path::canonicalize` returns a Windows *verbatim* path — the real prefix is
/// four characters, `\\?\`, and the previous version of this function looked
/// for a three-character `\?\` that no path has ever started with. Nothing was
/// stripped, so every project in the library rendered as
/// `\\?\D:\tmp\news\News broadcast`.
///
/// Strip it for any path that leaves this process. Every command
/// re-canonicalizes what it is given, so the stripped form is still a valid
/// round trip. A verbatim UNC path is `\\?\UNC\server\share`, whose ordinary
/// form is `\\server\share` — dropping only the `\\?\` would leave the bogus
/// `UNC\server\share`. Non-Windows paths carry neither prefix and come back
/// untouched.
pub(crate) fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

pub(crate) fn safe_folder_name(name: &str) -> String {
    let mut value: String = name
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            character if character.is_control() => '-',
            character => character,
        })
        .collect();
    value = value.trim().trim_matches('.').to_string();
    if value.is_empty() {
        "Untitled video".into()
    } else {
        value.chars().take(80).collect()
    }
}
/// The canonical folder of a folder that actually holds a Slopus project.
///
/// Every read command takes the folder from its caller, and "a folder" is not
/// the same claim as "a project". Requiring the settings file to be there means
/// a caller cannot aim a read at `C:\Users\NN\.ssh` and have the rest of the
/// command's checks — which only ever constrain the path *relative* to that
/// folder — do exactly what they promise while pointing at the wrong disk.
pub(crate) fn project_root(folder_path: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(folder_path)
        .canonicalize()
        .map_err(|error| format!("Could not resolve project folder: {error}"))?;
    if !root.is_dir() {
        return Err("The selected project folder does not exist.".into());
    }
    if !project_file_in(&root).is_file() {
        return Err(format!(
            "{} does not hold a Slopus project.",
            display_path(&root)
        ));
    }
    Ok(root)
}
