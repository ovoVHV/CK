//! Local assistant records, separate from projects, diagnostics and exports.
use serde_json::{json, Value};
use std::{fs, io::Write, path::{Path, PathBuf}, sync::Mutex};

static STORE_LOCK: Mutex<()> = Mutex::new(());
const CHAT_BYTES: usize = 24 * 1024 * 1024;

fn read(path: &Path) -> Result<Option<Value>, String> {
    if fs::metadata(path).map(|m|m.len()>CHAT_BYTES as u64).unwrap_or(false) { return Err("AI 记录超过大小限制，原文件已保留".into()); }
    match fs::read(path) {
        Ok(bytes) => {
            if bytes.len() > CHAT_BYTES { return Err("AI 记录超过大小限制，原文件已保留".into()); }
            serde_json::from_slice(&bytes).map(Some).map_err(|_| "AI 记录损坏，原文件已保留".into())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("无法读取 AI 记录：{e}")),
    }
}
fn write(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > CHAT_BYTES { return Err("聊天记录已达到 24 MB，请新建聊天；已有记录保留".into()); }
    let parent = path.parent().ok_or("AI 存储目录无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temp, path).map_err(|e| format!("AI 记录保存失败，原文件保留：{e}"))
}
fn chat_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id.len() < 16 || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err("聊天编号无效".into());
    }
    Ok(root.join("chats").join(format!("{id}.json")))
}
fn text<'a>(value: &'a Value, key: &str, limit: usize) -> Result<&'a str, String> {
    let value = value.get(key).and_then(Value::as_str).ok_or_else(|| format!("AI 记录缺少 {key}"))?;
    if value.len() > limit { return Err(format!("AI 记录 {key} 过长")); }
    Ok(value)
}
fn validate_chat(value: &Value) -> Result<(), String> {
    if value["schemaVersion"] != 1 { return Err("聊天记录版本不支持，原记录保留".into()); }
    text(value,"id",64)?; text(value,"projectKey",4096)?; text(value,"title",512)?;
    value["revision"].as_u64().ok_or("聊天版本无效")?;
    value["updatedAt"].as_u64().ok_or("聊天时间无效")?;
    let messages=value["messages"].as_array().filter(|v|v.len()<=10000).ok_or("聊天消息格式无效或数量过多")?;
    let mut ids=std::collections::HashSet::new();
    for message in messages {
        let id=text(message,"id",128)?;text(message,"text",128000)?;
        if id=="__draft__" || !ids.insert(id) || !matches!(message["role"].as_str(),Some("user"|"assistant")) { return Err("聊天消息编号或角色无效".into()); }
    }
    if let Some(memory)=value.get("memory").filter(|v|!v.is_null()) {
        text(memory,"summary",48000)?;
        let through=text(memory,"throughId",128)?;
        if !ids.contains(through) || memory["compressions"].as_u64().is_none() { return Err("聊天摘要记录无效".into()); }
    }
    Ok(())
}
fn preference_options(value:&Value)->Result<Value,String>{
    let apply=value.get("autoApply").cloned().unwrap_or(json!(true));
    let effort=value.get("reasoningEffort").and_then(Value::as_str).unwrap_or("auto");
    let protocol=value.get("reasoningProtocol").and_then(Value::as_str).unwrap_or("auto");
    let models=value.get("modelChoices").cloned().unwrap_or(json!([]));
    if !apply.is_boolean() || !matches!(effort,"auto"|"none"|"low"|"medium"|"high"|"max") || !matches!(protocol,"auto"|"standard"|"deepseek")
        || models.as_array().is_none_or(|rows|rows.len()>500 || rows.iter().any(|v|v.as_str().is_none_or(|s|s.is_empty()||s.len()>256))) {return Err("AI 应用模式或模型设置无效".into());}
    Ok(json!({"autoApply":apply,"reasoningEffort":effort,"reasoningProtocol":protocol,"modelChoices":models}))
}
fn attachment_records(messages:&Value)->Result<Vec<Value>,String>{
    let mut records=Vec::new();let mut total=0usize;
    for message in messages.as_array().ok_or("聊天消息无效")? {
        if let Some(files)=message.get("attachments").filter(|v|!v.is_null()) {
            let files=files.as_array().ok_or("附件记录无效")?;
            if files.len()>4 || message["role"]!="user" {return Err("附件数量或消息角色无效".into());}
            let mut ids=std::collections::HashSet::new();let mut bytes=0;
            for f in files {
                let id=text(f,"id",128)?;text(f,"name",960)?;text(f,"mime",64)?;
                if !ids.insert(id) || f["size"].as_u64().is_none() {return Err("附件元数据无效".into());}
                let content=text(f,"content",1_050_000)?;bytes+=content.len();
                match f["kind"].as_str(){
                    Some("text") if content.chars().count()<=128000 && !content.contains('\0')=>{},
                    Some("image")=>{super::ai_request_options::image_content("",&[content.to_string()])?;},
                    _=>return Err("附件内容不支持".into())
                }
            }
            if bytes>2_500_000{return Err("单条消息附件过大".into());}total+=bytes;
            records.push(json!({"messageId":message["id"],"files":files}));
        }
    }
    if total>8*1024*1024{return Err("当前聊天附件已达到 8 MB，请新建聊天；已有附件保留".into());}Ok(records)
}
pub fn load_preferences(root: &Path) -> Result<Value, String> {
    let _lock = STORE_LOCK.lock().map_err(|_| "AI 存储忙")?;
    let Some(mut value) = read(&root.join("preferences.json"))? else { return Ok(Value::Null); };
    let key = match value.get("encryptedKey").and_then(Value::as_array) {
        Some(bytes) => {
            let bytes = bytes.iter().map(|b| b.as_u64().filter(|b| *b < 256).map(|b| b as u8).ok_or("密钥记录无效"))
                .collect::<Result<Vec<_>, _>>()?;
            let plain = protect(&bytes, false)?;
            String::from_utf8(plain).map_err(|_| "无法读取保存的密钥")?
        }
        None => String::new(),
    };
    value.as_object_mut().ok_or("AI 设置无效")?.remove("encryptedKey");
    value["apiKey"] = Value::String(key);
    text(&value,"baseUrl",2048)?;text(&value,"model",256)?;
    let context=value["contextTokens"].as_u64().filter(|v|(16384..=262144).contains(v)).ok_or("保存的上下文设置无效")?;
    if value["responseTokens"].as_u64().filter(|v|(1024..=32768).contains(v)&&*v<=context/2).is_none()
        || value["rememberKey"].as_bool().is_none() || value["autoCompact"].as_bool().is_none() { return Err("保存的 AI 设置无效，请重新填写；原文件保留".into()); }
    let options=preference_options(&value)?;value.as_object_mut().unwrap().extend(options.as_object().unwrap().clone());
    Ok(value)
}
pub fn save_preferences(root: &Path, value: Value) -> Result<(), String> {
    let _lock = STORE_LOCK.lock().map_err(|_| "AI 存储忙")?;
    let base = text(&value, "baseUrl", 2048)?;
    let model = text(&value, "model", 256)?;
    let key = text(&value, "apiKey", 8192)?;
    let context = value["contextTokens"].as_u64().filter(|v| (16384..=262144).contains(v)).ok_or("上下文预算应为 16384–262144")?;
    let response = value["responseTokens"].as_u64().filter(|v| (1024..=32768).contains(v) && *v <= context / 2).ok_or("回复预算超出范围")?;
    let remember = value["rememberKey"].as_bool().ok_or("密钥保存选项无效")?;
    let auto = value["autoCompact"].as_bool().ok_or("自动压缩选项无效")?;
    let mut saved = json!({"schemaVersion":1,"baseUrl":base,"model":model,"rememberKey":remember,
        "contextTokens":context,"responseTokens":response,"autoCompact":auto});
    let options=preference_options(&value)?;saved.as_object_mut().unwrap().extend(options.as_object().unwrap().clone());
    if remember && !key.is_empty() { saved["encryptedKey"] = json!(protect(key.as_bytes(), true)?); }
    write(&root.join("preferences.json"), &saved)
}
pub fn list_chats(root: &Path, project: &str) -> Result<Value, String> {
    let _lock = STORE_LOCK.lock().map_err(|_| "AI 存储忙")?;
    let dir = root.join("chats");
    if !dir.exists() { return Ok(json!({"chats":[],"unreadable":0})); }
    let mut rows = Vec::new(); let mut unreadable = 0;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|v| v.to_str()) != Some("json") { continue; }
        match read(&path) {
            Ok(Some(v)) if validate_chat(&v).is_err() => unreadable += 1,
            Ok(Some(v)) if v["projectKey"].as_str() == Some(project) => rows.push(json!({
                "id":v["id"],"title":v["title"],"updatedAt":v["updatedAt"],"messages":v["messages"].as_array().map_or(0,Vec::len)})),
            Err(_) => unreadable += 1,
            _ => {}
        }
    }
    rows.sort_by(|a,b| b["updatedAt"].as_f64().unwrap_or(0.0).total_cmp(&a["updatedAt"].as_f64().unwrap_or(0.0)));
    Ok(json!({"chats":rows,"unreadable":unreadable}))
}
pub fn load_chat(root: &Path, id: &str, project: &str) -> Result<Value, String> {
    let _lock = STORE_LOCK.lock().map_err(|_| "AI 存储忙")?;
    let mut value = read(&chat_path(root, id)?)?.ok_or("聊天记录已不存在")?;
    validate_chat(&value)?;
    if value["projectKey"].as_str() != Some(project) || value["id"].as_str() != Some(id) { return Err("聊天不属于当前工程".into()); }
    if let Some(encrypted) = value.get("encryptedTask").filter(|v| !v.is_null()) {
        let restored = (|| -> Result<Value,String> {
            let bytes = encrypted.as_array().ok_or("任务加密数据格式无效")?.iter().map(|n| n.as_u64().filter(|n| *n < 256).map(|n| n as u8).ok_or("任务字节无效")).collect::<Result<Vec<_>,_>>()?;
            let plain = protect(&bytes, false)?;
            let task: Value = serde_json::from_slice(&plain).map_err(|_| "任务数据无法解码")?;
            validate_task(&task)?; Ok(task)
        })();
        match restored { Ok(task) => value["task"] = task, Err(error) => value["taskError"] = json!(format!("任务草稿无法恢复，聊天仍可读取；原文件保留：{error}")) }
    }
    if let Some(encrypted)=value.get("encryptedAttachments").and_then(Value::as_str) {
        let records:Vec<Value>=serde_json::from_slice(&protect(&hex::decode(encrypted).map_err(|_|"附件加密数据无效")?,false)?).map_err(|_|"附件记录无法恢复")?;
        for record in records {if record["messageId"]=="__draft__" {value["draftAttachments"]=record["files"].clone();continue;}if let Some(message)=value["messages"].as_array_mut().unwrap().iter_mut().find(|m|m["id"]==record["messageId"]){message["attachments"]=record["files"].clone();}}
        attachment_records(&value["messages"])?;
    }
    value.as_object_mut().unwrap().remove("encryptedAttachments");
    value.as_object_mut().unwrap().remove("encryptedTask");
    Ok(value)
}

fn validate_task(task: &Value) -> Result<(),String> {
    if task.to_string().len() > 600000 || task["version"] != 1 || !matches!(task["status"].as_str(),Some("working"|"paused"|"ready")) { return Err("任务草稿大小或版本无效".into()); }
    let allowed = ["version","id","updatedAt","status","prompt","workspaceSha256","target","libraries","plan","acceptance","edits","variables","nodes","placements","checkedTypes","observed","libraryDraft","installedLibraries","projectAttempts","libraryAttempts","lastFailure","repairScope"];
    if task.as_object().ok_or("任务草稿不是对象")?.keys().any(|k|!allowed.contains(&k.as_str())) { return Err("任务草稿含未知字段".into()); }
    text(task,"id",64)?; text(task,"prompt",48000)?; text(task,"workspaceSha256",64)?;
    text(task,"target",16000)?; text(task,"libraries",128000)?;
    for key in ["plan","edits","variables","nodes","placements","checkedTypes","observed","installedLibraries"] {
        if task[key].as_array().is_none_or(|v|v.len()>2000) { return Err("任务草稿列表无效".into()); }
    }
    for key in ["projectAttempts","libraryAttempts"] {
        if task[key].as_u64().is_none_or(|n|n>3) { return Err("任务尝试预算无效".into()); }
    }
    if let Some(scope) = task.get("repairScope") {
        if scope["version"] != 1 || scope["mode"] != "fields" || scope["workspaceSha256"] != task["workspaceSha256"]
            || scope.as_object().is_none_or(|v|v.keys().any(|k|!["version","mode","workspaceSha256","fields"].contains(&k.as_str()))) {
            return Err("任务修复范围无效".into());
        }
        let fields = scope["fields"].as_array().ok_or("修复字段无效")?;
        if fields.is_empty() || fields.len()>80 { return Err("修复字段数量无效".into()); }
        let mut keys=std::collections::HashSet::new();
        for field in fields {
            if field.as_object().is_none_or(|v|v.keys().any(|k|!["blockId","field"].contains(&k.as_str()))) { return Err("修复字段含未知数据".into()); }
            let block=text(field,"blockId",1024)?; let name=text(field,"field",512)?;
            if !keys.insert((block,name)) { return Err("修复字段重复".into()); }
        }
    }
    if let Some(failure) = task.get("lastFailure") {
        if failure.to_string().len()>120000 || failure.as_object().is_none_or(|v|v.keys().any(|k|!["tool","result","note"].contains(&k.as_str())))
            || !matches!(failure["tool"].as_str(),Some("propose_change"|"submit_library")) { return Err("任务失败资料无效".into()); }
        text(failure,"note",960)?;
        let fields = ["compiled","behavior","fixedAcceptance","attempt","repairsRemaining","diagnostics","logTail","instruction","_budget","error","repairScope"];
        if failure["result"].as_object().is_none_or(|v|v.keys().any(|k|!fields.contains(&k.as_str()))) { return Err("失败资料不能包含可执行授权".into()); }
    }
    // Structural checks are repeated by the renderer before any continuation.
    // This data grants neither installation nor compile/cache authorization.
    Ok(())
}
pub fn save_chat(root: &Path, value: Value) -> Result<u64, String> {
    let _lock = STORE_LOCK.lock().map_err(|_| "AI 存储忙")?;
    validate_chat(&value)?;
    let id = text(&value,"id",64)?;
    let path = chat_path(root,id)?;
    let project = text(&value,"projectKey",4096)?;
    text(&value,"title",512)?;
    let revision = value["revision"].as_u64().ok_or("聊天版本无效")?;
    let messages = value["messages"].as_array().ok_or("聊天消息无效")?;
    if messages.len() > 10000 { return Err("当前聊天已满，请新建聊天".into()); }
    for message in messages {
        text(message,"id",128)?; text(message,"text",128000)?;
        if !matches!(message["role"].as_str(),Some("user"|"assistant")) { return Err("聊天角色无效".into()); }
    }
    let old = read(&path)?;
    if old.as_ref().map_or(0,|v|v["revision"].as_u64().unwrap_or(u64::MAX)) != revision {
        return Err("聊天已在另一个窗口更新，请重新打开聊天后继续；未覆盖原记录".into());
    }
    if old.as_ref().is_some_and(|v|v["projectKey"].as_str()!=Some(project)) { return Err("聊天工程不匹配".into()); }
    let mut saved = json!({"schemaVersion":1,"id":id,"projectKey":project,"title":value["title"],"updatedAt":value["updatedAt"],
        "messages":messages,"memory":value["memory"],"draft":value["draft"],"revision":revision+1});
    if let Some(task) = value.get("task").filter(|v|!v.is_null()) {
        validate_task(task)?;
        // Local drafts can contain project values. Encrypt them for the current
        // Windows user; never serialize tool tokens, firmware or API credentials.
        saved["encryptedTask"] = json!(protect(&serde_json::to_vec(task).map_err(|e|e.to_string())?, true)?);
    } else if value.get("taskError").is_some_and(|v|!v.is_null()) {
        if let Some(encrypted) = old.as_ref().and_then(|v|v.get("encryptedTask")) { saved["encryptedTask"] = encrypted.clone(); }
    }
    let mut attachment_messages=saved["messages"].clone();
    if let Some(files)=value.get("draftAttachments").filter(|v|!v.is_null()) {attachment_messages.as_array_mut().unwrap().push(json!({"id":"__draft__","role":"user","attachments":files}));}
    let attachments=attachment_records(&attachment_messages)?;
    if !attachments.is_empty(){
        saved["encryptedAttachments"]=json!(hex::encode(protect(&serde_json::to_vec(&attachments).map_err(|e|e.to_string())?,true)?));
        for message in saved["messages"].as_array_mut().unwrap(){message.as_object_mut().unwrap().remove("attachments");}
    }
    // No executable preview or reusable compile/install authorization is saved.
    if saved["draft"].as_str().map_or(true,|v|v.len()>24000) { saved["draft"] = json!(""); }
    write(&path,&saved)?; Ok(revision+1)
}
pub fn delete_chat(root: &Path, id: &str, project: &str, revision: u64) -> Result<(),String> {
    let _lock = STORE_LOCK.lock().map_err(|_| "AI 存储忙")?;
    let path = chat_path(root,id)?;
    let value = read(&path)?.ok_or("聊天记录已不存在")?;
    if value["projectKey"].as_str()!=Some(project) || value["revision"].as_u64()!=Some(revision) { return Err("聊天已变化，请重新打开后删除".into()); }
    fs::remove_file(path).map_err(|e|e.to_string())
}

#[cfg(windows)]
fn protect(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use std::ffi::c_void;
    #[repr(C)] struct Blob { len: u32, data: *mut u8 }
    #[link(name="Crypt32")]
    extern "system" {
        fn CryptProtectData(input:*const Blob,description:*const u16,entropy:*const Blob,reserved:*mut c_void,prompt:*mut c_void,flags:u32,output:*mut Blob)->i32;
        fn CryptUnprotectData(input:*const Blob,description:*mut *mut u16,entropy:*const Blob,reserved:*mut c_void,prompt:*mut c_void,flags:u32,output:*mut Blob)->i32;
    }
    #[link(name="Kernel32")] extern "system" { fn LocalFree(memory:*mut c_void)->*mut c_void; }
    let input=Blob{len:bytes.len() as u32,data:bytes.as_ptr() as *mut u8};
    let mut output=Blob{len:0,data:std::ptr::null_mut()};
    let ok=unsafe { if encrypt { CryptProtectData(&input,std::ptr::null(),std::ptr::null(),std::ptr::null_mut(),std::ptr::null_mut(),1,&mut output) }
        else { CryptUnprotectData(&input,std::ptr::null_mut(),std::ptr::null(),std::ptr::null_mut(),std::ptr::null_mut(),1,&mut output) } };
    if ok==0 { return Err("Windows 无法读写当前用户的加密密钥，请重新填写；原记录已保留".into()); }
    let result=unsafe { std::slice::from_raw_parts(output.data,output.len as usize).to_vec() };
    unsafe { std::ptr::write_bytes(output.data,0,output.len as usize); LocalFree(output.data.cast()); }
    Ok(result)
}
#[cfg(not(windows))]
fn protect(_: &[u8], _: bool) -> Result<Vec<u8>,String> { Err("此平台暂不支持保存密钥，可取消记住密钥后使用".into()) }

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> PathBuf { let dir=std::env::temp_dir().join(format!("ck-ai-store-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())); fs::create_dir_all(&dir).unwrap();dir }
    fn chat() -> Value { json!({"schemaVersion":1,"id":"01234567-89ab-cdef-0123-456789abcdef","projectKey":"project-A","title":"测试聊天","revision":0,"updatedAt":1,"messages":[{"id":"m1","role":"user","text":"保留需求"}],"draft":"草稿","memory":null,"preview":{"execute":true}}) }
    #[cfg(windows)] #[test] fn attachments_and_options_roundtrip_and_delete(){
        let r=root();let mut c=chat();
        c["messages"][0]["attachments"]=json!([{"id":"file-a","name":"资料.txt","kind":"text","mime":"text/plain","size":20,"content":"附件秘密-PRIVATE-CONTENT"},{"id":"image-a","name":"图.png","kind":"image","mime":"image/png","size":8,"content":"data:image/png;base64,iVBORw=="}]);
        c["draftAttachments"]=c["messages"][0]["attachments"].clone();
        save_chat(&r,c.clone()).unwrap();
        let path=chat_path(&r,c["id"].as_str().unwrap()).unwrap();let raw=fs::read_to_string(&path).unwrap();assert!(!raw.contains("PRIVATE-CONTENT"));assert!(!raw.contains("data:image"));
        let loaded=load_chat(&r,c["id"].as_str().unwrap(),"project-A").unwrap();assert_eq!(loaded["messages"],c["messages"]);assert_eq!(loaded["draftAttachments"],c["draftAttachments"]);
        c["revision"]=json!(1);c["messages"][0]["attachments"][1]["content"]=json!("https://example.test/private");assert!(save_chat(&r,c.clone()).is_err());assert_eq!(fs::read_to_string(&path).unwrap(),raw);
        delete_chat(&r,c["id"].as_str().unwrap(),"project-A",1).unwrap();assert!(!path.exists());
        let prefs=json!({"baseUrl":"https://example.test/v1","model":"test","apiKey":"","contextTokens":32768,"responseTokens":8192,"autoCompact":true,"rememberKey":false});
        save_preferences(&r,prefs.clone()).unwrap();assert_eq!(load_preferences(&r).unwrap()["autoApply"],true);assert_eq!(load_preferences(&r).unwrap()["reasoningEffort"],"auto");
        let mut prefs=prefs;prefs["autoApply"]=json!(false);prefs["reasoningEffort"]=json!("high");prefs["reasoningProtocol"]=json!("standard");prefs["modelChoices"]=json!(["test","other"]);save_preferences(&r,prefs).unwrap();
        let loaded=load_preferences(&r).unwrap();assert_eq!(loaded["autoApply"],false);assert_eq!(loaded["reasoningEffort"],"high");assert_eq!(loaded["modelChoices"][1],"other");fs::remove_dir_all(r).unwrap();
    }
    #[test] fn field_repair_scope_native_schema_preserves_restriction() {
        let mut task: Value=serde_json::from_str(include_str!("../../../../../tests/fixtures/ai-phase4/checkpoint.json")).unwrap();
        task["repairScope"]=json!({"version":1,"mode":"fields","workspaceSha256":task["workspaceSha256"],"fields":[{"blockId":"existing","field":"NUM"}]});
        assert!(validate_task(&task).is_ok());
        let good=task.clone(); task["repairScope"]["token"]=json!("forbidden");assert!(validate_task(&task).is_err());
        task=good.clone();task["repairScope"]["fields"][0]["value"]=json!(650);assert!(validate_task(&task).is_err());
        task=good.clone();task["repairScope"]["workspaceSha256"]=json!("wrong");assert!(validate_task(&task).is_err());
        task=good;task["repairScope"]["fields"]=json!([]);assert!(validate_task(&task).is_err());
    }
    #[cfg(windows)] #[test] fn actual_renderer_failure_checkpoint_roundtrips_without_authority() {
        let task: Value = serde_json::from_str(include_str!("../../../../../tests/fixtures/ai-phase4/checkpoint.json")).unwrap();
        let r=root();let mut c=chat();c["task"]=task.clone();save_chat(&r,c.clone()).unwrap();
        assert_eq!(load_chat(&r,c["id"].as_str().unwrap(),"project-A").unwrap()["task"],task);
        let raw=fs::read_to_string(chat_path(&r,c["id"].as_str().unwrap()).unwrap()).unwrap();assert!(!raw.contains("lastFailure"));
        c["revision"]=json!(1);c["task"]["lastFailure"]["result"]["token"]=json!("forbidden");assert!(save_chat(&r,c.clone()).is_err());
        c["task"]=task;c["task"]["projectAttempts"]=json!(4);assert!(save_chat(&r,c).is_err());fs::remove_dir_all(r).unwrap();
    }
    #[cfg(windows)] #[test] fn task_draft_is_encrypted_and_does_not_persist_executable_authority() {
        let r=root();let mut c=chat();
        c["task"]=json!({"version":1,"id":"draft-one","status":"paused","updatedAt":1,"prompt":"task-secret-value","workspaceSha256":"a".repeat(64),"target":"{}","libraries":"[]","plan":[],"edits":[],"variables":[],"nodes":[],"placements":[],"checkedTypes":[],"observed":[],"installedLibraries":[],"projectAttempts":0,"libraryAttempts":0});
        save_chat(&r,c.clone()).unwrap();
        let raw=fs::read_to_string(chat_path(&r,c["id"].as_str().unwrap()).unwrap()).unwrap();assert!(!raw.contains("task-secret-value"));assert!(!raw.contains("workspaceSha256"));
        let saved=load_chat(&r,c["id"].as_str().unwrap(),"project-A").unwrap();assert_eq!(saved["task"]["prompt"],"task-secret-value");assert!(saved.get("encryptedTask").is_none());
        c["revision"]=json!(1);c["task"]["authorization"]=json!("forbidden");assert!(save_chat(&r,c).is_err());fs::remove_dir_all(r).unwrap();
    }
    #[test] fn transcript_roundtrip_conflict_isolation_and_delete() {
        let r=root();let mut c=chat();let rev=save_chat(&r,c.clone()).unwrap();assert_eq!(rev,1);
        assert!(save_chat(&r,c.clone()).is_err());assert!(load_chat(&r,c["id"].as_str().unwrap(),"project-B").is_err());
        let saved=load_chat(&r,c["id"].as_str().unwrap(),"project-A").unwrap();assert!(saved.get("preview").is_none());assert_eq!(saved["draft"],"草稿");
        assert_eq!(list_chats(&r,"project-A").unwrap()["chats"].as_array().unwrap().len(),1);
        c["revision"]=json!(1);c["title"]=json!("重命名");assert_eq!(save_chat(&r,c.clone()).unwrap(),2);
        assert!(delete_chat(&r,c["id"].as_str().unwrap(),"project-A",1).is_err());delete_chat(&r,c["id"].as_str().unwrap(),"project-A",2).unwrap();fs::remove_dir_all(r).unwrap();
    }
    #[test] fn damaged_records_and_invalid_paths_never_overwrite() {
        let r=root();assert!(load_chat(&r,"../../outside","project-A").is_err());let c=chat();let p=chat_path(&r,c["id"].as_str().unwrap()).unwrap();fs::create_dir_all(p.parent().unwrap()).unwrap();fs::write(&p,b"broken").unwrap();
        assert!(save_chat(&r,c).is_err());assert_eq!(fs::read(&p).unwrap(),b"broken");assert_eq!(list_chats(&r,"project-A").unwrap()["unreadable"],1);fs::remove_dir_all(r).unwrap();
    }
    #[test] fn valid_json_with_invalid_chat_shape_is_rejected_without_losing_file() {
        let r=root();let mut c=chat();c["messages"]=json!("not an array");let p=chat_path(&r,c["id"].as_str().unwrap()).unwrap();write(&p,&c).unwrap();
        assert!(load_chat(&r,c["id"].as_str().unwrap(),"project-A").is_err());assert_eq!(list_chats(&r,"project-A").unwrap()["unreadable"],1);assert_eq!(read(&p).unwrap().unwrap(),c);fs::remove_dir_all(r).unwrap();
    }
    #[cfg(windows)] #[test] fn key_is_encrypted_replaced_and_forgotten() {
        let r=root();let mut p=json!({"baseUrl":"https://example.com/v1","model":"test","apiKey":"fixture-secret-one","rememberKey":true,"contextTokens":32768,"responseTokens":8192,"autoCompact":true});
        save_preferences(&r,p.clone()).unwrap();assert!(!fs::read_to_string(r.join("preferences.json")).unwrap().contains("fixture-secret-one"));assert_eq!(load_preferences(&r).unwrap()["apiKey"],"fixture-secret-one");
        p["apiKey"]=json!("fixture-secret-two");save_preferences(&r,p.clone()).unwrap();assert_eq!(load_preferences(&r).unwrap()["apiKey"],"fixture-secret-two");
        p["rememberKey"]=json!(false);save_preferences(&r,p).unwrap();assert_eq!(load_preferences(&r).unwrap()["apiKey"],"");assert!(read(&r.join("preferences.json")).unwrap().unwrap().get("encryptedKey").is_none());fs::remove_dir_all(r).unwrap();
    }
}
