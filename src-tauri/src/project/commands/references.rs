use crate::project::*;
use super::{types::ProjectCommand, batch::*, effects::Effects};
pub(super) fn apply(project: &mut ProjectConfig, command: &ProjectCommand, timestamp: &str, _effects: &mut Effects) -> Result<(), String> {
    match command {
        ProjectCommand::ReferenceAdd {
            id,
            name,
            description,
            intended_use,
        } => {
            if project
                .references
                .iter()
                .any(|reference| reference.id == *id)
            {
                return Err(format!("reference '{id}' already exists"));
            }
            project.references.push(ReusableReference {
                id: id.clone(),
                kind: "text".into(),
                name: name.clone(),
                description: description.clone(),
                content: None,
                relative_path: None,
                source_path: None,
                images: Vec::new(),
                refmods: Vec::new(),
                video: None,
                intended_use: intended_use.clone(),
                subcategory: None,
                icon_relative_path: None,
                created_at: timestamp.into(),
            });
        }
        ProjectCommand::ReferenceSet {
            id,
            name,
            description,
            intended_use,
        } => {
            ensure_any(
                [
                    name.is_some(),
                    description.is_some(),
                    intended_use.is_some(),
                ],
                "has no fields to change",
            )?;
            let reference = project
                .references
                .iter_mut()
                .find(|reference| reference.id == *id)
                .ok_or_else(|| format!("reference '{id}' was not found"))?;
            if let Some(value) = name {
                reference.name = value.clone();
            }
            if let Some(value) = description {
                reference.description = value.clone();
                reference.content = None;
            }
            if let Some(value) = intended_use {
                if reference.intended_use != *value {
                    reference.subcategory = None;
                }
                reference.intended_use = value.clone();
            }
        }
        ProjectCommand::ReferenceRemove { id } => {
            let at = project
                .references
                .iter()
                .position(|reference| reference.id == *id)
                .ok_or_else(|| format!("reference '{id}' was not found"))?;
            let token = format!("@[ref:{id}]");
            if project.generation_jobs.iter().any(|job| {
                job.start_frame_reference_id.as_deref() == Some(id)
                    || job.end_frame_reference_id.as_deref() == Some(id)
                    || job
                        .shots
                        .as_ref()
                        .is_some_and(|shots| shots.iter().any(|shot| shot.action.contains(&token)))
            }) {
                return Err(format!(
                    "reference '{id}' is still used by a scene; update that scene before removing it"
                ));
            }
            project.references.remove(at);
            for job in &mut project.generation_jobs {
                job.reference_ids.retain(|reference_id| reference_id != id);
            }
        }
        _ => unreachable!("command dispatched to the wrong domain"),
    }
    Ok(())
}
