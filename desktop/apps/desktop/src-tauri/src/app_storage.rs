use std::{fs,path::PathBuf,process::Command};
use serde_json::{json,Value};
use tauri::{Manager,State};

pub(crate) fn product_dir()->Result<PathBuf,String>{
    std::env::var_os("CK_V91_PRODUCT_ROOT").map(PathBuf::from)
        .or_else(||dirs::data_local_dir().map(|p|p.join("CKBuildEngineV91")))
        .ok_or_else(||"无法定位数据目录".into())
}
pub(crate) fn desktop_dir(app:&tauri::AppHandle)->Result<PathBuf,String>{
    if let Some(root)=std::env::var_os("CK_V91_DESKTOP_DATA_ROOT"){
        let path=PathBuf::from(root);if !path.is_absolute(){return Err("桌面数据目录无效".into());}return Ok(path);
    }
    app.path().app_data_dir().map_err(|e|e.to_string())
}
fn locator()->Result<PathBuf,String>{
    std::env::var_os("CK_STORAGE_CONFIG_PATH").map(PathBuf::from).ok_or_else(||"请从安装版 CK 启动器打开软件后管理数据目录".into())
}
pub(crate) fn pending()->bool{locator().ok().and_then(|p|p.parent().map(|d|d.join("storage-pending.json"))).is_some_and(|p|p.exists())}
fn install_root()->Result<PathBuf,String>{
    std::env::var_os("CK_INSTALL_ROOT").map(PathBuf::from).ok_or_else(||"缺少安装目录".into())
}
async fn storage_command(op:&str,target:Option<String>,include_external:bool)->Result<Value,String>{
    let locator=locator()?;let install=install_root()?;let op=op.to_owned();
    tauri::async_runtime::spawn_blocking(move||{
        let mut command=Command::new(install.join("engine/runtime/node.exe"));
        command.arg(install.join("engine/scripts/storage-cli.mjs")).arg(op).env("CK_STORAGE_LOCATOR",locator);
        if let Some(target)=target{command.arg(target).arg(&install).arg(if include_external{"true"}else{"false"});}
        #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
        let out=command.output().map_err(|e|e.to_string())?;
        if !out.status.success(){return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());}
        serde_json::from_slice(&out.stdout).map_err(|e|e.to_string())
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub fn app_storage_status()->Result<Value,String>{
    let file=locator()?;let mut result:Value=serde_json::from_slice(&fs::read(&file).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    result["externalAssets"]=json!(result["assets"]!=result["root"]);
    result["pending"]=json!(pending());
    Ok(result)
}
#[tauri::command]
pub async fn app_storage_plan(target:String,include_external:bool,state:State<'_,crate::app_update::UpdateState>)->Result<Value,String>{
    let _guard=crate::app_update::start(&state)?;
    storage_command("plan",Some(target),include_external).await
}
#[tauri::command]
pub async fn app_storage_schedule(app:tauri::AppHandle,target:String,include_external:bool,state:State<'_,crate::app_update::UpdateState>)->Result<Value,String>{
    let _guard=crate::app_update::start(&state)?;
    if !app.state::<crate::ForegroundBuildState>().registry.lock().map_err(|e|e.to_string())?.active.is_empty()
        || app.state::<crate::UploadState>().inner.session.lock().map_err(|e|e.to_string())?.is_some()
        || app.state::<crate::InstallState>().active_process_count()>0 {
        return Err("请等待编译、上传及核心包/库安装完成后迁移".into());
    }
    let result=storage_command("schedule",Some(target),include_external).await?;
    tauri::async_runtime::spawn(async move{tokio::time::sleep(std::time::Duration::from_millis(400)).await;app.exit(0);});
    Ok(result)
}
#[tauri::command]
pub async fn app_storage_cancel()->Result<Value,String>{storage_command("cancel",None,false).await}
