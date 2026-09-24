use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageScene {
    pub nodes: Vec<ImageNode>,
    pub background: String,
    pub style: ImageStyle,
    pub steps: u32,
    pub seed: i64,
    pub reference_ids: Vec<String>,
    pub output_asset_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub name: String,
    pub description: String,
    pub text: String,
    pub r#box: Option<ImageBox>,
    pub colors: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageStyle {
    pub mode: String,
    pub aesthetics: String,
    pub lighting: String,
    pub medium: String,
    pub detail: String,
}

impl ImageScene {
    pub fn validate(&self) -> Result<(), String> {
        if self.nodes.is_empty()
            || self.nodes.len() > 500
            || !(2..=1000).contains(&self.steps)
            || !(-1..=9_007_199_254_740_991).contains(&self.seed)
            || !matches!(self.style.mode.as_str(), "photo" | "art")
            || self.reference_ids.len() > 100
            || self.reference_ids.iter().any(String::is_empty)
            || self.output_asset_id.as_ref().is_some_and(String::is_empty)
        {
            return Err("Invalid image generation settings.".into());
        }
        let nodes: HashMap<_, _> = self
            .nodes
            .iter()
            .map(|node| (node.id.as_str(), node))
            .collect();
        let roots: Vec<_> = self
            .nodes
            .iter()
            .filter(|node| node.kind == "root")
            .collect();
        if nodes.len() != self.nodes.len() || roots.len() != 1 || roots[0].parent_id.is_some() {
            return Err("Image nodes must form one connected tree with unique IDs.".into());
        }
        for node in &self.nodes {
            if node.id.is_empty()
                || node.name.is_empty()
                || node.name.chars().count() > 120
                || !matches!(
                    node.kind.as_str(),
                    "root" | "group" | "object" | "text" | "background"
                )
                || node.colors.len() > 16
                || node.colors.iter().any(|color| {
                    color.len() != 7
                        || !color.starts_with('#')
                        || !color[1..].bytes().all(|c| c.is_ascii_hexdigit())
                })
            {
                return Err("Invalid image node.".into());
            }
            if let Some(b) = &node.r#box {
                if ![b.x, b.y, b.width, b.height].iter().all(|v| v.is_finite())
                    || b.x < 0.0
                    || b.y < 0.0
                    || b.x > 999.0
                    || b.y > 999.0
                    || b.width <= 0.0
                    || b.height <= 0.0
                    || b.x + b.width > 1000.0
                    || b.y + b.height > 1000.0
                {
                    return Err("Image placement must stay inside the image.".into());
                }
            }
            let mut seen = HashSet::from([node.id.as_str()]);
            let mut parent = node.parent_id.as_deref();
            while let Some(id) = parent {
                if !seen.insert(id) {
                    return Err("Image hierarchy contains a cycle.".into());
                }
                parent = nodes
                    .get(id)
                    .ok_or("Image parent does not exist.")?
                    .parent_id
                    .as_deref();
            }
            if !seen.contains(roots[0].id.as_str()) {
                return Err("Image node is disconnected from the root.".into());
            }
        }
        Ok(())
    }
}
