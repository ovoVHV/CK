use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProjectBuildTarget {
    pub schema_version: u32,
    pub board: String,
    pub board_package_id: String,
    pub core_id: String,
    pub core_version: Option<String>,
    pub fqbn: String,
    pub options: BTreeMap<String, String>,
    pub options_complete: bool,
}

fn token(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
}

pub(crate) fn validate(raw: &str, board: &str, package: &str, options: &str) -> Result<(), String> {
    let target: ProjectBuildTarget = serde_json::from_str(raw)
        .map_err(|e| format!("Invalid project build target: {e}"))?;
    let parts: Vec<_> = target.board.split(':').collect();
    let actual_options: BTreeMap<String, String> = serde_json::from_str(options)
        .map_err(|e| format!("Invalid project board options: {e}"))?;
    if target.schema_version != 1 || parts.len() != 3 || !parts.iter().all(|part| token(part))
        || target.board != board.split(':').take(3).collect::<Vec<_>>().join(":")
        || target.core_id != parts[..2].join(":")
        || target.board_package_id != (if package.is_empty() { board } else { package })
        || target.core_version.as_ref().is_some_and(|v| v.trim().is_empty())
        || target.options != actual_options
        || !target.options.iter().all(|(k, v)| token(k) && token(v)) {
        return Err("Project build target does not match the saved board/options".into());
    }
    let mut options = target.options.clone();
    if options.is_empty() {
        let cpu = match target.board.as_str() {
            "arduino:avr:nano" | "arduino:avr:diecimila" => Some("atmega328"),
            "arduino:avr:mega" => Some("atmega2560"),
            _ => None,
        };
        if let Some(cpu) = cpu { options.insert("cpu".into(), cpu.into()); }
    }
    // Compare maps instead of locale-dependent ordering of option names.
    let fqbn_parts: Vec<_> = target.fqbn.split(':').collect();
    let parsed: Option<BTreeMap<String, String>> = fqbn_parts.get(3).map(|suffix| {
        suffix.split(',').map(|entry| {
            entry.split_once('=').map(|(k, v)| (k.to_string(), v.to_string()))
        }).collect()
    }).unwrap_or_else(|| Some(BTreeMap::new()));
    if fqbn_parts.len() > 4 || fqbn_parts[..fqbn_parts.len().min(3)].join(":") != target.board
        || parsed.as_ref() != Some(&options)
        || fqbn_parts.get(3).is_some_and(|s| s.split(',').count() != options.len()) {
        return Err("Project build target FQBN does not match its options".into());
    }
    Ok(())
}

pub(crate) fn validate_optional(raw: Option<&str>, board: &str, package: &str, options: &str) -> Result<(), String> {
    raw.map(|raw| validate(raw, board, package, options)).unwrap_or(Ok(()))
}
