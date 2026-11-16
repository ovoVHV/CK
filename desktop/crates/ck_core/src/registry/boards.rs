use crate::registry::properties::Properties;
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct Board {
    pub id: String,
    pub name: String,
    pub properties: Properties,
    // Menus will map "menu_id" -> "selection_id" -> Properties
}

pub async fn parse_boards_txt(path: &Path) -> Result<HashMap<String, Board>> {
    let content = tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("Failed to read boards.txt at {:?}", path))?;
    let mut boards = HashMap::<String, Board>::new();
    let mut raw_props = HashMap::<String, HashMap<String, String>>::new();

    // First pass: group by board ID prefix (e.g. "uno.name=..." -> "uno")
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        if let Some((full_key, value)) = line.split_once('=') {
            let full_key = full_key.trim();
            if let Some((board_id, prop_key)) = full_key.split_once('.') {
                raw_props
                    .entry(board_id.to_string())
                    .or_default()
                    .insert(prop_key.to_string(), value.trim().to_string());
            }
        }
    }

    // Second pass: Construct Board objects
    for (id, props_map) in raw_props {
        // Must have a name to be a valid board entry
        if let Some(name) = props_map.get("name") {
            let mut properties = Properties::new();
            for (k, v) in &props_map {
                properties.insert(k, v);
            }

            boards.insert(
                id.clone(),
                Board {
                    id,
                    name: name.clone(),
                    properties,
                },
            );
        }
    }

    Ok(boards)
}
