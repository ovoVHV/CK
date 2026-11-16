use serde_json::Value;
fn root() -> std::path::PathBuf { super::ck_root_dir().join("state").join("ai-assistant-v1") }
#[tauri::command] pub fn ai_load_preferences() -> Result<Value,String> { super::ai_store::load_preferences(&root()) }
#[tauri::command] pub fn ai_save_preferences(value:Value) -> Result<(),String> { super::ai_store::save_preferences(&root(),value) }
#[tauri::command] pub fn ai_list_chats(project_key:String) -> Result<Value,String> { super::ai_store::list_chats(&root(),&project_key) }
#[tauri::command] pub fn ai_load_chat(id:String,project_key:String) -> Result<Value,String> { super::ai_store::load_chat(&root(),&id,&project_key) }
#[tauri::command] pub fn ai_save_chat(value:Value) -> Result<u64,String> { super::ai_store::save_chat(&root(),value) }
#[tauri::command] pub fn ai_delete_chat(id:String,project_key:String,revision:u64) -> Result<(),String> { super::ai_store::delete_chat(&root(),&id,&project_key,revision) }
