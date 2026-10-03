use super::{batch::ensure_any, patch::Patch, types::ProjectCommand};
use crate::project::{
    image::{ImageBox, ImageNode, ImageScene, ImageStyle},
    ProjectConfig,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageStylePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aesthetics: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lighting: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub medium: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

fn new_scene(prompt: &str) -> ImageScene {
    ImageScene {
        root_type: None,
        source_image: None,
        nodes: vec![ImageNode {
            id: "image-root".into(),
            parent_id: None,
            kind: "root".into(),
            name: "Image".into(),
            description: prompt.into(),
            text: String::new(),
            reference_ids: None,
            r#box: None,
            colors: vec![],
        }],
        background: String::new(),
        style: ImageStyle {
            mode: "photo".into(),
            aesthetics: String::new(),
            lighting: String::new(),
            medium: String::new(),
            detail: String::new(),
        },
        steps: 20,
        seed: -1,
        reference_ids: vec![],
        output_asset_id: None,
    }
}

fn index(scene: &ImageScene, id: &str) -> Result<usize, String> {
    scene
        .nodes
        .iter()
        .position(|node| node.id == id)
        .ok_or_else(|| format!("Image node '{id}' was not found."))
}
fn non_root(scene: &ImageScene, id: &str) -> Result<usize, String> {
    let at = index(scene, id)?;
    if scene.nodes[at].kind == "root" {
        return Err("The image root cannot be moved, duplicated or removed.".into());
    }
    Ok(at)
}
fn descendants(scene: &ImageScene, id: &str) -> HashSet<String> {
    let mut ids = HashSet::from([id.to_string()]);
    loop {
        let previous = ids.len();
        for node in &scene.nodes {
            if node
                .parent_id
                .as_ref()
                .is_some_and(|parent| ids.contains(parent))
            {
                ids.insert(node.id.clone());
            }
        }
        if ids.len() == previous {
            return ids;
        }
    }
}
fn insert(
    scene: &mut ImageScene,
    nodes: Vec<ImageNode>,
    parent: &str,
    before: Option<&str>,
) -> Result<(), String> {
    index(scene, parent)?;
    let at = if let Some(before) = before {
        scene
            .nodes
            .iter()
            .position(|node| node.id == before && node.parent_id.as_deref() == Some(parent))
            .ok_or("The before node must be a child of the destination parent.")?
    } else {
        scene.nodes.len()
    };
    scene.nodes.splice(at..at, nodes);
    Ok(())
}
fn resize(scene: &mut ImageScene, id: &str, new_box: &ImageBox) -> Result<(), String> {
    let at = index(scene, id)?;
    let old = scene.nodes[at].r#box.clone();
    let ids = descendants(scene, id);
    scene.nodes[at].r#box = Some(new_box.clone());
    if let Some(old) = old {
        for node in &mut scene.nodes {
            if node.id == id || !ids.contains(&node.id) {
                continue;
            }
            if let Some(b) = node.r#box.as_mut() {
                b.x = (new_box.x + (b.x - old.x) * new_box.width / old.width)
                    .round()
                    .clamp(0.0, 999.0);
                b.y = (new_box.y + (b.y - old.y) * new_box.height / old.height)
                    .round()
                    .clamp(0.0, 999.0);
                b.width = (b.width * new_box.width / old.width)
                    .round()
                    .clamp(1.0, 1000.0 - b.x);
                b.height = (b.height * new_box.height / old.height)
                    .round()
                    .clamp(1.0, 1000.0 - b.y);
            }
        }
    }
    Ok(())
}

pub(super) fn apply(
    project: &mut ProjectConfig,
    command: &ProjectCommand,
    timestamp: &str,
) -> Result<(), String> {
    let mut scene = project
        .image_scene
        .clone()
        .unwrap_or_else(|| new_scene(&project.brief.prompt));
    match command {
        ProjectCommand::ImageSet {
            nodes,
            background,
            style,
            steps,
            seed,
            reference_ids,
        } => {
            scene = ImageScene {
                root_type: scene.root_type,
                source_image: scene.source_image,
                nodes: nodes.clone(),
                background: background.clone(),
                style: style.clone(),
                steps: *steps,
                seed: *seed,
                reference_ids: reference_ids.clone(),
                output_asset_id: scene.output_asset_id,
            };
        }
        ProjectCommand::ImageConfigure {
            prompt,
            background,
            style,
            steps,
            seed,
            reference_ids,
        } => {
            ensure_any(
                [
                    prompt.is_some(),
                    background.is_some(),
                    style
                        .as_ref()
                        .is_some_and(|s| s != &ImageStylePatch::default()),
                    steps.is_some(),
                    seed.is_some(),
                    reference_ids.is_some(),
                ],
                "Image settings have no fields to change.",
            )?;
            if let Some(value) = prompt {
                scene
                    .nodes
                    .iter_mut()
                    .find(|node| node.kind == "root")
                    .ok_or("Image root was not found.")?
                    .description = value.clone();
            }
            if let Some(value) = background {
                scene.background = value.clone();
            }
            if let Some(value) = steps {
                scene.steps = *value;
            }
            if let Some(value) = seed {
                scene.seed = *value;
            }
            if let Some(value) = reference_ids {
                scene.reference_ids = value.clone();
            }
            if let Some(value) = style {
                if let Some(value) = &value.mode {
                    scene.style.mode = value.clone();
                }
                if let Some(value) = &value.aesthetics {
                    scene.style.aesthetics = value.clone();
                }
                if let Some(value) = &value.lighting {
                    scene.style.lighting = value.clone();
                }
                if let Some(value) = &value.medium {
                    scene.style.medium = value.clone();
                }
                if let Some(value) = &value.detail {
                    scene.style.detail = value.clone();
                }
            }
        }
        ProjectCommand::ImageNodeAdd {
            id,
            parent,
            kind,
            name,
            description,
            text,
            r#box,
            colors,
            before,
            reference_ids,
        } => {
            if !matches!(kind.as_str(), "object" | "text" | "group" | "background") {
                return Err("New image nodes must be objects, text, groups or backgrounds.".into());
            }
            let node = ImageNode {
                id: id.clone(),
                parent_id: Some(parent.clone()),
                kind: kind.clone(),
                name: name.clone(),
                description: description.clone().unwrap_or_default(),
                text: text.clone().unwrap_or_default(),
                reference_ids: reference_ids.clone(),
                r#box: r#box.clone(),
                colors: colors.clone().unwrap_or_default(),
            };
            insert(&mut scene, vec![node], parent, before.as_deref())?;
        }
        ProjectCommand::ImageNodeSet {
            id,
            name,
            description,
            text,
            r#box,
            colors,
            reference_ids,
        } => {
            let at = index(&scene, id)?;
            ensure_any(
                [
                    name.is_some(),
                    description.is_some(),
                    text.is_some(),
                    r#box.is_changed(),
                    colors.is_some(),
                    reference_ids.is_some(),
                ],
                "Image node update has no fields to change.",
            )?;
            match r#box {
                Patch::Set(value) => resize(&mut scene, id, value)?,
                Patch::Clear => scene.nodes[at].r#box = None,
                Patch::Unchanged => {}
            }
            if let Some(value) = name {
                scene.nodes[at].name = value.clone();
            }
            if let Some(value) = description {
                scene.nodes[at].description = value.clone();
            }
            if let Some(value) = text {
                scene.nodes[at].text = value.clone();
            }
            if let Some(value) = colors {
                scene.nodes[at].colors = value.clone();
            }
            if let Some(value) = reference_ids {
                scene.nodes[at].reference_ids = Some(value.clone());
            }
        }
        ProjectCommand::ImageNodeMove { id, parent, before } => {
            let at = non_root(&scene, id)?;
            if descendants(&scene, id).contains(parent) {
                return Err("An image node cannot move inside its own subtree.".into());
            }
            if before.as_ref() == Some(id) {
                return Err("An image node cannot be placed before itself.".into());
            }
            let mut node = scene.nodes.remove(at);
            node.parent_id = Some(parent.clone());
            insert(&mut scene, vec![node], parent, before.as_deref())?;
        }
        ProjectCommand::ImageNodeDuplicate {
            id,
            new_id,
            parent,
            before,
        } => {
            let source = scene.nodes[non_root(&scene, id)?].clone();
            let parent = parent
                .as_ref()
                .or(source.parent_id.as_ref())
                .ok_or("Missing image parent.")?;
            let ids = descendants(&scene, id);
            let renamed = |old: &str| {
                if old == id {
                    new_id.clone()
                } else {
                    format!("{new_id}--{old}")
                }
            };
            let copies = scene
                .nodes
                .iter()
                .filter(|node| ids.contains(&node.id))
                .map(|node| {
                    let mut copy = node.clone();
                    copy.id = renamed(&node.id);
                    copy.parent_id = Some(if node.id == *id {
                        parent.clone()
                    } else {
                        renamed(node.parent_id.as_deref().unwrap_or_default())
                    });
                    copy
                })
                .collect();
            insert(&mut scene, copies, parent, before.as_deref())?;
        }
        ProjectCommand::ImageNodeRemove { id } => {
            non_root(&scene, id)?;
            let ids = descendants(&scene, id);
            scene.nodes.retain(|node| !ids.contains(&node.id));
        }
        _ => unreachable!("command dispatched to the wrong domain"),
    }
    scene.validate()?;
    for id in scene.cited_reference_ids()? {
        if !project.references.iter().any(|reference| {
            reference.id == id && matches!(reference.kind.as_str(), "image" | "text")
        }) {
            return Err(format!(
                "The image cites '@[ref:{id}]', which must name an existing image or text reference."
            ));
        }
    }
    for id in &scene.reference_ids {
        if !project.references.iter().any(|reference| {
            &reference.id == id && matches!(reference.kind.as_str(), "image" | "text")
        }) {
            return Err(format!(
                "Image reference '{id}' must name an existing image or text reference."
            ));
        }
    }
    project.image_scene = Some(scene);
    project.updated_at = timestamp.into();
    Ok(())
}
