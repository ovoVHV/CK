use std::{fs, io::Read, path::Path, sync::Mutex};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use crate::project_build_target::ProjectBuildTarget;

// JSON escaping can expand a valid 1 MiB source by up to six times.
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const ANNOTATION: &str = "// CK build configuration (select the matching board and Core in your IDE):";
static SAVES: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceDocument { format: String, schema_version: u32, code: String, target: Option<ProjectBuildTarget> }
#[derive(Debug, Serialize)]
pub(crate) struct LoadedSource { path: String, revision: String, document: SourceDocument }

fn extension(path: &Path) -> Result<String, String> {
    let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
    if !["ino", "cksrc"].contains(&ext.as_str()) { return Err("仅支持 .ino 源码和 .cksrc 源码工程".into()); }
    Ok(ext)
}
fn validate(doc: &SourceDocument) -> Result<(), String> {
    if doc.format != "ck-source-project" || doc.schema_version != 1 { return Err("不支持的源码工程版本".into()); }
    if doc.code.len() > 1024 * 1024 || doc.code.contains('\0') { return Err("源码限 1 MiB，且不能包含空字符".into()); }
    if let Some(target) = &doc.target {
        crate::project_build_target::validate(&serde_json::to_string(target).map_err(|e| e.to_string())?,
            &target.board, &target.board_package_id, &serde_json::to_string(&target.options).map_err(|e| e.to_string())?)?;
    }
    Ok(())
}
fn decode(ext: &str, bytes: &[u8]) -> Result<SourceDocument, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "源码必须使用 UTF-8 编码")?.trim_start_matches('\u{feff}');
    let doc = if ext == "cksrc" { serde_json::from_str(text).map_err(|e| format!("源码工程损坏：{e}"))? }
    else {
        let mut code = text.to_string(); let mut target = None;
        let mut parts = text.splitn(4, '\n');
        if parts.next().unwrap_or("").trim_end_matches('\r') == ANNOTATION {
            let config = parts.next().unwrap_or("").trim_end_matches('\r');
            let blank = parts.next().unwrap_or("").trim_end_matches('\r');
            if !blank.is_empty() { return Err("源码中的 CK 板卡配置注释损坏".into()); }
            target = Some(serde_json::from_str(config.strip_prefix("// ").ok_or("源码板卡配置格式错误")?)
                .map_err(|e| format!("源码板卡配置损坏：{e}"))?);
            code = parts.next().unwrap_or("").to_string();
        }
        SourceDocument { format: "ck-source-project".into(), schema_version: 1, code, target }
    };
    validate(&doc)?; Ok(doc)
}
fn read(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_BYTES { return Err("文件超过 8 MiB 上限".into()); }
    let mut bytes = Vec::new(); file.take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES { return Err("文件超过 8 MiB 上限".into()); } Ok(bytes)
}
#[tauri::command]
pub(crate) fn open_source_project(path: String) -> Result<LoadedSource, String> {
    let ext = extension(Path::new(&path))?; let bytes = read(Path::new(&path))?;
    let document = decode(&ext, &bytes)?;
    Ok(LoadedSource { path, revision: hex::encode(Sha256::digest(&bytes)), document })
}
#[tauri::command]
pub(crate) fn save_source_project(path: String, document: SourceDocument, expected_revision: Option<String>) -> Result<LoadedSource, String> {
    let _guard = SAVES.lock().map_err(|_| "源码保存状态不可用")?;
    let destination = Path::new(&path); let ext = extension(destination)?; validate(&document)?;
    if destination.exists() {
        let revision = hex::encode(Sha256::digest(read(destination)?));
        if expected_revision.as_deref() != Some(&revision) { return Err("文件已存在或被外部修改。请重新打开核对，或另存为新文件，避免覆盖。".into()); }
    } else if expected_revision.is_some() { return Err("原文件已被移动或删除，请另存为新文件".into()); }
    let bytes = if ext == "cksrc" { serde_json::to_vec_pretty(&document).map_err(|e| e.to_string())? }
    else if let Some(target) = &document.target { format!("{ANNOTATION}\n// {}\n\n{}", serde_json::to_string(target).map_err(|e| e.to_string())?, document.code).into_bytes() }
    else { document.code.as_bytes().to_vec() };
    if bytes.len() as u64 > MAX_BYTES { return Err("序列化工程超过 8 MiB 上限".into()); }
    crate::project::atomic_write_project_file(destination, &bytes)?;
    Ok(LoadedSource { path, revision: hex::encode(Sha256::digest(&bytes)), document })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn source_is_not_regenerated_and_target_roundtrips() {
        let code = "#include <WiFi.h>\nvoid setup() { /* 中文 */ }\nvoid loop() {}\n";
        let raw = format!("{ANNOTATION}\n// {{\"schemaVersion\":1,\"board\":\"esp32:esp32:esp32s3\",\"boardPackageId\":\"esp32:esp32:esp32s3\",\"coreId\":\"esp32:esp32\",\"coreVersion\":\"3.3.6-cn\",\"fqbn\":\"esp32:esp32:esp32s3:FlashSize=8M\",\"options\":{{\"FlashSize\":\"8M\"}},\"optionsComplete\":true}}\n\n{code}");
        let doc = decode("ino", raw.as_bytes()).unwrap(); assert_eq!(doc.code, code);
        assert_eq!(doc.target.as_ref().unwrap().core_version.as_deref(), Some("3.3.6-cn"));
        assert_eq!(decode("cksrc", &serde_json::to_vec(&doc).unwrap()).unwrap().code, code);
        assert!(decode("ino", raw.replace("FlashSize=8M", "FlashSize=4M").as_bytes()).is_err());
    }
    #[test] fn invalid_and_unsupported_documents_fail_closed() {
        assert!(extension(Path::new("a.exe")).is_err());
        assert!(decode("ino", &[255]).is_err()); assert!(decode("ino", b"a\0b").is_err());
        assert!(decode("cksrc", br#"{"format":"ck-source-project","schemaVersion":2,"code":"","target":null}"#).is_err());
    }
    #[test] fn saves_preserve_external_changes() {
        let dir = std::env::temp_dir().join(format!("ck-source-{}", uuid::Uuid::new_v4())); fs::create_dir_all(&dir).unwrap();
        let path = dir.join("中文工程.cksrc").to_string_lossy().to_string();
        let doc = decode("ino", b"void setup() {}\nvoid loop() {}\n").unwrap();
        let saved = save_source_project(path.clone(), doc.clone(), None).unwrap();
        assert!(save_source_project(path.clone(), doc.clone(), None).is_err());
        let updated = save_source_project(path.clone(), doc.clone(), Some(saved.revision)).unwrap();
        fs::write(&path, "external changes").unwrap();
        assert!(save_source_project(path.clone(), doc, Some(updated.revision)).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "external changes");
        fs::remove_file(&path).unwrap(); fs::remove_dir(&dir).unwrap();
    }
}
