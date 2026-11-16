//! AI produces bounded declarative packages, never executable desktop scripts.
//! Compile authorization is in memory and binds source, target and full content.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, io::Write, path::{Path, PathBuf}, sync::{LazyLock, Mutex}};
use tauri::AppHandle;
use crate::package_quality::{hash_package_contents, validate_local_package_tree};

#[derive(Clone)]
struct Draft {
    directory: PathBuf, id: String, scope: String, fqbn: String, board_package_id: String,
    core_version: String, content: String, source: String, validated: bool, busy: bool, installed: bool,
}
static DRAFTS: LazyLock<Mutex<BTreeMap<String, Draft>>> = LazyLock::new(|| Mutex::new(BTreeMap::new()));
fn root() -> PathBuf { crate::ck_root_dir().join("state/ai-libraries-v1") }
fn lock() -> Result<std::sync::MutexGuard<'static, BTreeMap<String, Draft>>, String> { DRAFTS.lock().map_err(|_| "Library state unavailable".into()) }
fn bounded_tree(path: &Path) -> Result<(), String> { validate_local_package_tree(path, 48, 256_000, 512_000) }
fn intact(draft: &Draft) -> Result<(), String> {
    bounded_tree(&draft.directory.join("package"))?;
    if hash_package_contents(&draft.directory.join("package"))? != draft.content { return Err("库候选内容已经变化，请重新校验编译".into()); }
    Ok(())
}
fn validate_files(files: &BTreeMap<String,String>) -> Result<String,String> {
    if files.len() > 32 || files.values().map(String::len).sum::<usize>() > 480_000 { return Err("Library exceeds size limit".into()); }
    let native = regex::Regex::new(r"^src/[A-Za-z][A-Za-z0-9_]{0,80}\.(h|hpp|c|cpp)$").unwrap();
    let allowed = ["library.json", "library.properties", "ck-blocks.json", "blocks/blocks.json", "blocks/ck-generator.json", "blocks/toolbox.json", "README.md", "LICENSE", "examples/compile_check/compile_check.ino"];
    let mut folded = std::collections::BTreeSet::new();
    for (name, content) in files {
        if (!allowed.contains(&name.as_str()) && !native.is_match(name)) || content.len() > 256_000 || content.contains('\0') || !folded.insert(name.to_lowercase()) { return Err(format!("Invalid or duplicate library file: {name}")); }
    }
    for required in allowed.iter().filter(|name| **name != "library.properties") { if !files.contains_key(*required) { return Err(format!("Missing {required}")); } }
    let manifest: Value = serde_json::from_str(&files["library.json"]).map_err(|e|e.to_string())?;
    let id = manifest["id"].as_str().unwrap_or_default();
    if !regex::Regex::new(r"^ck_ai_[a-f0-9]{12}$").unwrap().is_match(id) { return Err("Invalid generated library namespace".into()); }
    let definitions: Value = serde_json::from_str(&files["blocks/blocks.json"]).map_err(|e|e.to_string())?;
    let definitions = definitions.as_array().ok_or("Expected block array")?;
    if definitions.is_empty() || definitions.len() > 24 { return Err("Invalid generated block count".into()); }
    for definition in definitions {
        if !definition["type"].as_str().is_some_and(|t|t.starts_with(&format!("{id}_"))) || ["extensions","mutator","onchange"].iter().any(|k|definition.get(k).is_some()) { return Err("Generated block cannot override or execute existing runtimes".into()); }
    }
    let contract: Value = serde_json::from_str(&files["ck-blocks.json"]).map_err(|e|e.to_string())?;
    if contract["entrypoints"] != json!({"blocks":"blocks/blocks.json","generator":"blocks/ck-generator.json","toolbox":"blocks/toolbox.json"}) { return Err("Generated runtime must be declarative JSON".into()); }
    Ok(id.to_string())
}

#[tauri::command]
pub async fn ai_prepare_library(app: AppHandle, files: BTreeMap<String,String>, fqbn: String, board_package_id: String, core_version: String, source_sha256: String) -> Result<Value,String> {
    let _gate = crate::managed_package_mutation_gate().read().await;
    let id = validate_files(&files)?;
    let source = files.get("examples/compile_check/compile_check.ino").ok_or("Missing compile check")?;
    if crate::sha256_text(source) != source_sha256 || core_version.is_empty() { return Err("Library compile source identity mismatch".into()); }
    let scope = crate::lib_custom_registry::library_install_scope_id(&app,&fqbn,Some(&board_package_id))?;
    if crate::ck_root_dir().join("libraries").join(&scope).join(&id).exists() { return Err("库标识已经存在，未覆盖；请新建制作任务，已有库升级请使用库管理器".into()); }
    let mut state = lock()?;
    if state.len() >= 12 { return Err("待处理库过多，请关闭旧候选或重启后重试".into()); }
    let token = uuid::Uuid::new_v4().simple().to_string();
    let directory = root().join("drafts").join(&token);
    let package = directory.join("package");
    let prepared = (|| -> Result<Draft,String> {
        fs::create_dir_all(&package).map_err(|e|e.to_string())?;
        for (name, source) in &files {
            let path = package.join(name);
            fs::create_dir_all(path.parent().unwrap()).map_err(|e|e.to_string())?;
            fs::write(path, source).map_err(|e|e.to_string())?;
        }
        bounded_tree(&package)?;
        let report = crate::lib_custom_registry::inspect_library_package(&package,true);
        report.enforce()?;
        crate::package_quality::write_quality_report(&package,&report)?;
        let content = hash_package_contents(&package)?;
        Ok(Draft { directory: directory.clone(), id: id.clone(), scope, fqbn, board_package_id, core_version, content, source: source_sha256, validated:false, busy:false, installed:false })
    })();
    match prepared {
        Ok(draft) => { let response=json!({"token":token,"packageId":id,"contentSha256":draft.content}); state.insert(token,draft); Ok(response) }
        Err(e) => { let _=fs::remove_dir_all(directory); Err(e) }
    }
}

pub struct CompileLease { token: String, draft: Draft }
impl CompileLease {
    pub fn path(&self) -> PathBuf { self.draft.directory.join("package") }
    pub fn complete(&self, ok: bool) -> Result<(),String> {
        intact(&self.draft)?;
        if let Some(draft)=lock()?.get_mut(&self.token) { draft.validated=ok; }
        Ok(())
    }
}
impl Drop for CompileLease { fn drop(&mut self) { if let Ok(mut state)=lock() { if let Some(draft)=state.get_mut(&self.token) {draft.busy=false;} } } }
pub fn compile_lease(token:&str,source:&str,fqbn:&str,board_package_id:&str,core_version:&str)->Result<CompileLease,String>{
    let mut state=lock()?; let draft=state.get_mut(token).ok_or("库候选授权已失效，请重新生成")?;
    if draft.busy || draft.installed || draft.source!=crate::sha256_text(source) || draft.fqbn!=fqbn || draft.board_package_id!=board_package_id || draft.core_version!=core_version {return Err("库候选编译身份不匹配或正在使用".into());}
    intact(draft)?; draft.validated=false; draft.busy=true;
    Ok(CompileLease{token:token.into(),draft:draft.clone()})
}

fn zip_package(package:&Path, output:&Path)->Result<(),String>{
    bounded_tree(package)?;
    let mut archive=zip::ZipWriter::new(fs::File::create(output).map_err(|e|e.to_string())?);
    for entry in walkdir::WalkDir::new(package).sort_by_file_name() {
        let entry=entry.map_err(|e|e.to_string())?;
        if !entry.file_type().is_file(){continue;}
        let name=entry.path().strip_prefix(package).map_err(|e|e.to_string())?.to_string_lossy().replace('\\',"/");
        if name.starts_with(".ck-"){continue;}
        archive.start_file(name,zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).map_err(|e|e.to_string())?;
        archive.write_all(&fs::read(entry.path()).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    }
    archive.finish().map_err(|e|e.to_string())?; Ok(())
}
#[derive(Serialize,Deserialize)]
struct Pending { id:String,scope:String,content:String }
fn pending_path(token:&str)->PathBuf{root().join("pending").join(format!("{token}.json"))}
fn rollback_pending(path:&Path)->Result<(),String>{
    let pending:Pending=serde_json::from_slice(&fs::read(path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    if !regex::Regex::new(r"^ck_ai_[a-f0-9]{12}$").unwrap().is_match(&pending.id) || !crate::package_quality::valid_package_id(&pending.scope,false){return Err("Invalid pending library record".into());}
    let target=crate::ck_root_dir().join("libraries").join(&pending.scope).join(&pending.id);
    if target.exists(){
        bounded_tree(&target)?;
        if hash_package_contents(&target)?!=pending.content{return Err("待回滚库已被外部修改，保留内容供恢复，未删除".into());}
        // Retain in recovery, never erase independently changed packages.
        let recovery=root().join("recovery"); fs::create_dir_all(&recovery).map_err(|e|e.to_string())?;
        fs::rename(&target,recovery.join(format!("{}-{}",pending.id,uuid::Uuid::new_v4()))).map_err(|e|e.to_string())?;
    }
    fs::remove_file(path).map_err(|e|e.to_string())?; Ok(())
}
pub fn recover()->Result<(),String>{
    let pending=root().join("pending");
    if pending.is_dir(){for entry in fs::read_dir(&pending).map_err(|e|e.to_string())?{let path=entry.map_err(|e|e.to_string())?.path();if path.extension().is_some_and(|e|e=="json"){rollback_pending(&path)?;}}}
    Ok(())
}
#[tauri::command]
pub async fn ai_install_library(token:String)->Result<(),String>{
    let _gate=crate::managed_package_mutation_gate().write().await;
    let mut state=lock()?; let draft=state.get_mut(&token).ok_or("Library authorization expired")?;
    if !draft.validated || draft.busy || draft.installed {return Err("库尚未通过编译或正在安装".into());}
    intact(draft)?;
    let target=crate::ck_root_dir().join("libraries").join(&draft.scope).join(&draft.id);
    if target.exists(){return Err("同名库已经存在，未覆盖".into());}
    let archive=draft.directory.join("library.zip"); zip_package(&draft.directory.join("package"),&archive)?;
    let pending=pending_path(&token); fs::create_dir_all(pending.parent().unwrap()).map_err(|e|e.to_string())?;
    fs::write(&pending,serde_json::to_vec(&Pending{id:draft.id.clone(),scope:draft.scope.clone(),content:draft.content.clone()}).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    if let Err(e)=crate::lib_custom_registry::install_library_from_zip(&archive,&draft.scope,None,true){rollback_pending(&pending)?;return Err(e);}
    draft.installed=true;
    if let Ok(mut cache)=crate::library_candidates_cache().lock(){*cache=None;}
    Ok(())
}
#[tauri::command]
pub async fn ai_finish_library(token:String, loaded:bool)->Result<(),String>{
    let _gate=crate::managed_package_mutation_gate().write().await;
    let mut state=lock()?;let draft=state.get_mut(&token).ok_or("Library authorization expired")?;
    if !draft.installed{return Err("Library is not awaiting activation".into());}
    let pending=pending_path(&token);
    if loaded{
        let target=crate::ck_root_dir().join("libraries").join(&draft.scope).join(&draft.id);
        if hash_package_contents(&target)?!=draft.content{return Err("Installed library content changed".into());}
        fs::remove_file(pending).map_err(|e|e.to_string())?;
    }else{rollback_pending(&pending)?;draft.installed=false;}
    if let Ok(mut cache)=crate::library_candidates_cache().lock(){*cache=None;}
    Ok(())
}
#[tauri::command]
pub async fn ai_discard_library(token:String)->Result<(),String>{
    let _gate=crate::managed_package_mutation_gate().write().await;
    let mut state=lock()?;
    if let Some(draft)=state.get(&token){
        if draft.busy{return Err("Library compile is still running".into());}
        if pending_path(&token).exists(){rollback_pending(&pending_path(&token))?;}
        fs::remove_dir_all(&draft.directory).map_err(|e|e.to_string())?;
    }
    state.remove(&token); Ok(())
}
#[tauri::command]
pub fn ai_export_library(token:String,destination:String)->Result<(),String>{
    let state=lock()?;let draft=state.get(&token).ok_or("Library export session expired")?;
    if !draft.validated || draft.busy{return Err("Library not verified".into());} intact(draft)?;
    let destination=PathBuf::from(destination);
    if destination.extension().is_none_or(|ext|!ext.eq_ignore_ascii_case("zip")) || destination.exists(){return Err("请选择尚不存在的 ZIP 文件名".into());}
    let archive=draft.directory.join("export.zip");zip_package(&draft.directory.join("package"),&archive)?;
    let bytes=fs::read(&archive).map_err(|e|e.to_string())?;
    let mut output=fs::OpenOptions::new().write(true).create_new(true).open(destination).map_err(|e|e.to_string())?;
    output.write_all(&bytes).map_err(|e|e.to_string())?;Ok(())
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn rejects_path_traversal_and_scripts(){for name in ["../escape.h","src/../escape.h","src/evil.js","C:/evil.h",".ck-quality-report.json","src/A.h:evil"]{let files=BTreeMap::from([(name.to_string(),"x".into())]);assert!(validate_files(&files).is_err(),"{name}");}}
    #[test] fn rejects_empty_or_foreign_runtime(){assert!(validate_files(&BTreeMap::new()).is_err());}
    #[test] fn disk_files_do_not_authorize_compilation(){assert!(compile_lease("disk-only","void setup(){}","arduino:avr:uno","arduino:avr:uno","1.8.6").is_err());}
}
