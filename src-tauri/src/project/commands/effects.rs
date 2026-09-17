use crate::project::{reference_tokens::action_reference_ids, ProjectConfig};
use std::collections::BTreeSet;

pub(super) struct Effects {
    changed_shots: BTreeSet<String>,
    pub(super) defaults: crate::generation::models::SceneDefaults,
}
impl Effects {
    pub(super) fn new(defaults: crate::generation::models::SceneDefaults) -> Self {
        Self {
            changed_shots: BTreeSet::new(),
            defaults,
        }
    }
    pub(super) fn shots_changed(&mut self, scene: &str) {
        self.changed_shots.insert(scene.to_string());
    }
    pub(super) fn synchronize(self, project: &mut ProjectConfig) -> Result<(), String> {
        let reference_ids = project
            .references
            .iter()
            .map(|reference| reference.id.clone())
            .collect::<Vec<_>>();
        for job in &mut project.generation_jobs {
            if !self.changed_shots.contains(job.id.as_str()) {
                continue;
            }
            let Some(shots) = job.shots.as_mut() else {
                continue;
            };
            shots.sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
            let text = shots
                .iter()
                .map(|shot| shot.action.trim())
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            job.prompt = text.clone();
            job.creative_brief = text;
            job.shot_tags = None;
            for shot in shots {
                for reference_id in action_reference_ids(&shot.action)? {
                    if reference_ids.iter().any(|id| id == reference_id)
                        && !job.reference_ids.iter().any(|id| id == reference_id)
                    {
                        job.reference_ids.push(reference_id.to_string());
                    }
                }
            }
        }
        Ok(())
    }
}
