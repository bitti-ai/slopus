use crate::commands::{artifacts::*, media::*};
use crate::media::{access::*, artifacts::*, import::*};
use crate::project::{lifecycle::*, paths::*, storage::*, validation::*, *};
use crate::slopfab;
use std::{
    collections::BTreeMap,
    env, fs, io,
    path::{Path, PathBuf},
};

pub(super) fn fixture() -> ProjectConfig {
    serde_json::from_str(include_str!("../../../fixtures/project-v1-complete.json")).unwrap()
}

// A project created BEFORE scenes existed, and the shape every project on
// disk today still has: one generation job with no `shots`, no
// `durationSeconds` and no sound fields, holding its words in `prompt` and
// `creativeBrief` alone. It was the byte-exact output of
// `createProjectConfig`, which now opens a scene instead — the file is kept
// exactly as it was because that is the point of it. The complete fixture
// cannot stand in for it: it has no draft job without a clip, which is the
// shape that broke every create and open.
pub(super) fn created_fixture() -> ProjectConfig {
    serde_json::from_str(include_str!("../../../fixtures/project-v1-created.json")).unwrap()
}

pub(super) fn without_derived_project_state(mut config: ProjectConfig) -> ProjectConfig {
    for job in &mut config.generation_jobs {
        job.compiled_prompt.clear();
    }
    config.agent_conversation = AgentConversation::default();
    config
}

// A project whose video and audio live OUTSIDE the folder, alongside a
// copied image — every shape the two location fields can take, in one
// file both validators read.
pub(super) fn external_fixture() -> ProjectConfig {
    serde_json::from_str(include_str!(
        "../../../fixtures/project-v1-external-media.json"
    ))
    .unwrap()
}

// A SCENE: three shots with their own start times, settings and reference
// tokens, plus the two per-prompt sound fields. Every key scenes added is
// present here, so a struct that forgets `skip_serializing_if` shows up in
// `rust-serialized-scene.json` and fails on the frontend's real zod.
pub(super) fn scene_fixture() -> ProjectConfig {
    serde_json::from_str(include_str!("../../../fixtures/project-v1-scene.json")).unwrap()
}

// The keys the frontend schema spells `.optional()` with NO `.nullable()`
// (src/lib/project.ts lines 42-44, 56, 109). zod's `.optional()` rejects
// `null`, so an explicit null under any of these names makes the whole
// config unparseable in the UI — the key has to be absent instead.
//
// This list is hand-maintained and therefore NOT the authority: a new
// `Option` field missing `skip_serializing_if` is invisible here until
// someone remembers to add its name. The authority is the generated
// `fixtures/rust-serialized-*.json` written by
// `serialized_wire_format_matches_frontend_fixtures`,
// which the frontend test suite parses with the real zod schema — a
// forgotten field fails there without anyone editing this array.
const NON_NULLABLE_OPTIONAL_KEYS: [&str; 5] = ["clipId", "durationMs", "width", "height", "color"];

pub(super) fn collect_forbidden_nulls(
    value: &serde_json::Value,
    path: &str,
    found: &mut Vec<String>,
) {
    match value {
        serde_json::Value::Object(fields) => {
            for (key, child) in fields {
                let child_path = format!("{path}.{key}");
                if child.is_null() && NON_NULLABLE_OPTIONAL_KEYS.contains(&key.as_str()) {
                    found.push(child_path.clone());
                }
                collect_forbidden_nulls(child, &child_path, found);
            }
        }
        serde_json::Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                collect_forbidden_nulls(item, &format!("{path}[{index}]"), found);
            }
        }
        _ => {}
    }
}

pub(super) fn forbidden_nulls(config: &ProjectConfig) -> Vec<String> {
    let json = serde_json::to_string_pretty(config).unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    let mut found = Vec::new();
    collect_forbidden_nulls(&value, "config", &mut found);
    found
}

pub(super) fn object_of<'a>(
    value: &'a serde_json::Value,
    path: &str,
) -> &'a serde_json::Map<String, serde_json::Value> {
    value
        .as_object()
        .unwrap_or_else(|| panic!("{path} is not a JSON object"))
}

fn project_folder_at(path: &Path) -> PathBuf {
    fs::create_dir_all(path).unwrap();
    write_project(path, &created_fixture()).unwrap();
    path.to_path_buf()
}

fn project_folder() -> tempfile::TempDir {
    let folder = tempfile::tempdir().unwrap();
    fs::write(
        folder.path().join(PROJECT_FILE_NAME),
        serde_json::to_vec(&created_fixture()).unwrap(),
    )
    .unwrap();
    folder
}

mod artifacts;
mod media_access;
mod persistence;
mod references;
mod scenes;
mod schema;
