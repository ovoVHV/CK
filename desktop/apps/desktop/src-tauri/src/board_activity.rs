//! Informational local success history. Never consumed by build/cache authorization,
//! board passport qualification, or hardware verification.
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Mutex};

static IO_LOCK: Mutex<()> = Mutex::new(());
const MAX_RECORDS: usize = 256;
const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Success {
    pub board_package_id: String,
    pub fqbn: String,
    pub core_version: String,
    pub operation: Operation,
    pub completed_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Operation { Compile, Upload }

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct History { schema_version: u32, records: Vec<Success> }

fn canonical_fqbn(value: &str) -> Option<String> {
    let parts: Vec<_> = value.trim().split(':').collect();
    if !(3..=4).contains(&parts.len()) || parts[..3].iter().any(|p| p.is_empty()) {
        return None;
    }
    let mut target = parts[..3].join(":");
    if let Some(options) = parts.get(3).filter(|s| !s.is_empty()) {
        let mut entries: Vec<_> = options.split(',').collect();
        if entries.iter().any(|s| !s.split_once('=').is_some_and(|(k,v)| !k.is_empty() && !v.is_empty())) { return None; }
        entries.sort_unstable();
        if entries.windows(2).any(|p| p[0].split('=').next() == p[1].split('=').next()) { return None; }
        target.push(':');
        target.push_str(&entries.join(","));
    }
    Some(target)
}

impl Success {
    pub fn observed(package: Option<&str>, fqbn: &str, core: Option<&str>, operation: Operation) -> Option<Self> {
        let fqbn = canonical_fqbn(fqbn)?;
        let core = core?.trim();
        if core.is_empty() || core == "unknown" { return None; }
        let package = package.map(str::trim).filter(|s| !s.is_empty())?;
        if package.len() > 512 || fqbn.len() > 4096 || core.len() > 128 { return None; }
        Some(Self { board_package_id: package.into(), fqbn, core_version: core.into(), operation,
            completed_at: chrono::Utc::now().to_rfc3339() })
    }
    fn valid(&self) -> bool {
        Self::observed(Some(&self.board_package_id), &self.fqbn, Some(&self.core_version), self.operation).is_some()
            && chrono::DateTime::parse_from_rfc3339(&self.completed_at).is_ok()
    }
}

fn load(root: &Path) -> History {
    let path = root.join("board-success-history.v1.json");
    if std::fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(true) { return History::default(); }
    let mut state: History = std::fs::read(&path).ok().and_then(|s| serde_json::from_slice(&s).ok()).unwrap_or_default();
    if state.schema_version != 1 || state.records.len() > MAX_RECORDS { return History::default(); }
    state.records.retain(Success::valid);
    state
}

pub fn read(root: &Path) -> Vec<Success> {
    let Ok(_guard) = IO_LOCK.lock() else { return Vec::new(); };
    load(root).records
}

pub fn record(root: &Path, success: Success) -> Result<(), String> {
    if !success.valid() { return Err("invalid board success observation".into()); }
    let _guard = IO_LOCK.lock().map_err(|e| e.to_string())?;
    let mut state = load(root);
    state.schema_version = 1;
    state.records.retain(|old| !(old.board_package_id == success.board_package_id
        && old.fqbn == success.fqbn && old.core_version == success.core_version && old.operation == success.operation));
    state.records.push(success);
    let excess = state.records.len().saturating_sub(MAX_RECORDS);
    state.records.drain(..excess);
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let path = root.join("board-success-history.v1.json");
    let temporary = root.join(format!("board-success-history.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        std::fs::write(&temporary, serde_json::to_vec(&state).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        crate::compile_accel::replace_hotset_file(&temporary, &path).map_err(|e| e.to_string())
    })();
    if result.is_err() { let _ = std::fs::remove_file(temporary); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(package: &str, fqbn: &str, core: &str, op: Operation) -> Success {
        Success::observed(Some(package), fqbn, Some(core), op).unwrap()
    }
    #[test]
    fn persists_successes_separately_by_full_configuration_package_core_and_operation() {
        let dir = tempfile::tempdir().unwrap();
        for (package,fqbn,core,op) in [
            ("arduino:avr:nano","arduino:avr:nano:cpu=atmega328","1.8.8",Operation::Compile),
            ("arduino:avr:nano","arduino:avr:nano:cpu=atmega168","1.8.8",Operation::Compile),
            ("arduino:avr:nano","arduino:avr:nano:cpu=atmega328","1.8.7",Operation::Compile),
            ("custom-nano","arduino:avr:nano:cpu=atmega328","1.8.8",Operation::Compile),
            ("arduino:avr:nano","arduino:avr:nano:cpu=atmega328","1.8.8",Operation::Upload),
        ] { record(dir.path(), entry(package,fqbn,core,op)).unwrap(); }
        record(dir.path(), entry("arduino:avr:nano","arduino:avr:nano:cpu=atmega328","1.8.8",Operation::Compile)).unwrap();
        assert_eq!(read(dir.path()).len(), 5);
        assert_eq!(read(dir.path()).iter().filter(|e| e.operation == Operation::Upload).count(), 1);
    }
    #[test]
    fn corrupt_unknown_and_oversize_history_never_grant_a_pass() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("board-success-history.v1.json");
        for invalid in ["bad json".to_string(), "{\"schemaVersion\":2,\"records\":[]}".into(), "x".repeat(MAX_BYTES as usize + 1)] {
            std::fs::write(&path, invalid).unwrap(); assert!(read(dir.path()).is_empty());
        }
        record(dir.path(), entry("arduino:avr:uno","arduino:avr:uno","1.8.8",Operation::Compile)).unwrap();
        assert_eq!(read(dir.path()).len(), 1);
    }
    #[test]
    fn requires_identity_and_normalizes_option_order_without_collapsing_cpu() {
        assert!(Success::observed(None,"arduino:avr:uno",Some("1.8.8"),Operation::Compile).is_none());
        assert!(Success::observed(Some("id"),"arduino:avr:uno",None,Operation::Compile).is_none());
        assert_eq!(canonical_fqbn("v:a:b:z=2,a=1"),Some("v:a:b:a=1,z=2".into()));
        assert!(canonical_fqbn("v:a:b:cpu=1,cpu=2").is_none());
    }
    #[test]
    fn history_remains_bounded() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..260 { record(dir.path(), entry("v:a:b",&format!("v:a:b:cpu={i}"),"1",Operation::Compile)).unwrap(); }
        assert_eq!(read(dir.path()).len(),MAX_RECORDS);
    }
}
