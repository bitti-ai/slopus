use super::*;
use super::{paths::*, storage::*, validation::validate_and_normalize_config};
use crate::media::import::import_reference_file;
use std::{env, fs, path::{Path, PathBuf}};
pub(crate) const PROJECT_DIRECTORIES: [&str; 6] = [
    "media/imported",
    "media/generated",
    "references",
    "thumbnails",
    "cache",
    "exports",
];
pub(crate) const PROJECT_ROOT_DIRECTORIES: [&str; 5] =
    ["media", "references", "thumbnails", "cache", "exports"];
/** Permanently delete exactly one verified project folder.
 *
 * The UI supplies both coordinates it displayed in the confirmation: folder
 * and project id. Resolve the folder again at the destructive boundary and
 * require both to still agree. Broad filesystem roots, the user's home, the
 * process working directory, and symlink targets are never valid deletion
 * candidates even if somebody places a project file there. */
pub(crate) fn delete_project_folder(folder_path: &str, expected_project_id: &str) -> Result<(), String> {
    if expected_project_id.trim().is_empty() {
        return Err("The project id to delete cannot be empty.".into());
    }
    let requested = PathBuf::from(folder_path);
    let metadata = fs::symlink_metadata(&requested)
        .map_err(|error| format!("Could not inspect project folder: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("A project folder reached through a symbolic link cannot be deleted.".into());
    }

    let root = project_root(folder_path)?;
    if root.parent().is_none() {
        return Err("A filesystem root cannot be deleted as a project.".into());
    }
    let mut protected = Vec::new();
    if let Ok(current) = env::current_dir().and_then(|path| path.canonicalize()) {
        protected.push(current);
    }
    for variable in ["HOME", "USERPROFILE"] {
        if let Some(path) = env::var_os(variable) {
            if let Ok(path) = PathBuf::from(path).canonicalize() {
                protected.push(path);
            }
        }
    }
    if protected.iter().any(|path| path == &root) {
        return Err("This protected folder cannot be deleted as a project.".into());
    }

    let record = read_project(&root)?;
    if record.config.id != expected_project_id {
        return Err(format!(
            "The folder now holds project '{}', not the project selected for deletion.",
            record.config.name
        ));
    }
    fs::remove_dir_all(&root).map_err(|error| {
        format!(
            "Could not delete project folder {}: {error}",
            display_path(&root)
        )
    })
}
#[cfg(test)]
pub(crate) fn create_project_in(parent: &Path, config: &ProjectConfig) -> Result<ProjectRecord, String> {
    create_project_in_with_references(parent, config, &[])
}

#[cfg(test)]
pub(crate) fn create_project_in_with_references(
    parent: &Path,
    config: &ProjectConfig,
    reference_paths: &[PathBuf],
) -> Result<ProjectRecord, String> {
    let project_folder = parent.join(safe_folder_name(&config.name));
    fs::create_dir(&project_folder)
        .map_err(|error| format!("Could not create project folder: {error}"))?;
    create_project_at_with_references(&project_folder, config, reference_paths)
}

pub(crate) fn create_project_at_with_references(
    project_folder: &Path,
    config: &ProjectConfig,
    reference_paths: &[PathBuf],
) -> Result<ProjectRecord, String> {
    let mut config = validate_and_normalize_config(config.clone())?;
    if !project_folder.is_dir() {
        return Err("The selected project folder does not exist.".into());
    }
    let mut entries = fs::read_dir(project_folder)
        .map_err(|error| format!("Could not inspect the selected project folder: {error}"))?;
    match entries.next() {
        Some(Ok(_)) => {
            return Err(
                "The selected folder is not empty. Choose an empty folder for the new project."
                    .into(),
            );
        }
        Some(Err(error)) => {
            return Err(format!(
                "Could not inspect the selected project folder: {error}"
            ));
        }
        None => {}
    }
    let prepare_result = (|| -> Result<(), String> {
        for child in PROJECT_DIRECTORIES {
            fs::create_dir_all(project_folder.join(child))
                .map_err(|error| format!("Could not create {child} folder: {error}"))?;
        }
        for (index, source) in reference_paths.iter().enumerate() {
            let imported = import_reference_file(source, &project_folder)?;
            let mut reference_id = format!("ref-initial-{}", index + 1);
            let mut suffix = 2;
            while config
                .references
                .iter()
                .any(|reference| reference.id == reference_id)
            {
                reference_id = format!("ref-initial-{}-{suffix}", index + 1);
                suffix += 1;
            }
            config.references.push(ReusableReference {
                id: reference_id.clone(),
                // Whatever the file actually is. A video or sound reference is
                // recorded by path, not copied, so calling it an image here
                // would be a claim about a file nobody has looked at.
                kind: imported.kind.into(),
                name: imported.name,
                // MUST stay empty. The prompt compiler emits a reference's
                // description as the subject's own traits in the text sent to
                // the paid model, so any sentence written here is presented to
                // the model as if the user had described the image that way.
                // Same hazard the text path documents at src/lib/project.ts:87.
                description: String::new(),
                content: None,
                relative_path: imported.relative_path,
                source_path: imported.source_path,
                images: Vec::new(),
                refmods: Vec::new(),
                video: None,
                intended_use: vec!["style".into()],
                subcategory: None,
                icon_relative_path: None,
                created_at: config.created_at.clone(),
            });
            if let Some(job) = config.generation_jobs.first_mut() {
                job.reference_ids.push(reference_id);
            }
        }
        write_project(project_folder, &config)
    })();
    if let Err(error) = prepare_result {
        // The selected root belonged to the user before creation. Roll back
        // only paths Slopus could have created after the empty-folder check.
        let _ = fs::remove_file(project_folder.join(PROJECT_FILE_NAME));
        for child in PROJECT_ROOT_DIRECTORIES {
            let _ = fs::remove_dir_all(project_folder.join(child));
        }
        return Err(error);
    }
    read_project(project_folder)
}
