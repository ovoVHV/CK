use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Manifest {
    pub tools: HashMap<String, ToolInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolInfo {
    pub version: String,
    pub download_url: String,
    pub filename: String,
    pub sha256: String,
}

impl Default for Manifest {
    fn default() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }
}
