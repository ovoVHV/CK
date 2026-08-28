use crate::registry::properties::Properties;
use anyhow::{Context, Result};
use std::path::Path;
use tokio::io::AsyncBufReadExt;

#[derive(Debug, Clone)]
pub struct Platform {
    pub name: String,
    pub version: String,
    pub properties: Properties,
    // We will add menus, tools dependencies etc later
}

impl Platform {
    pub async fn from_file(path: &Path) -> Result<Self> {
        let content = tokio::fs::read_to_string(path)
            .await
            .with_context(|| format!("Failed to read platform.txt at {:?}", path))?;

        let mut props = Properties::new();
        let mut name = String::new();
        let mut version = String::new();

        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            if let Some((key, value)) = line.split_once('=') {
                let key = key.trim();
                let value = value.trim();

                match key {
                    "name" => name = value.to_string(),
                    "version" => version = value.to_string(),
                    _ => props.insert(key, value),
                }
            }
        }

        Ok(Self {
            name,
            version,
            properties: props,
        })
    }
}
