//! Provider settings as projects store them and generation commands receive
//! them. The `slopfab` entry carries the model paths and engine options.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderSetting {
    pub enabled: bool,
    pub model: Option<String>,
    #[serde(default)]
    pub options: BTreeMap<String, ProviderOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProviderOption {
    String(String),
    Number(f64),
    Boolean(bool),
}
