#![windows_subsystem = "windows"]
use std::{fs,path::PathBuf,process::{Command,Stdio},os::windows::process::CommandExt};
use windows_sys::Win32::{Foundation::*,System::Threading::*,UI::WindowsAndMessaging::*};
#[path = "../storage_ui.rs"]
mod storage_ui;
fn wide(s:&str)->Vec<u16>{s.encode_utf16().chain(Some(0)).collect()}
fn message(text:&str,flags:u32)->i32{unsafe{MessageBoxW(std::ptr::null_mut(),wide(text).as_ptr(),wide("CK V9.1 测试版").as_ptr(),flags)}}
fn main(){
 let args:Vec<_>=std::env::args().skip(1).collect();
 let qualify=args.iter().any(|a|a=="--qualify");
 let setup=args.iter().any(|a|a=="--install-assets");
 let doctor=args.iter().any(|a|a=="--doctor");
 let wifi_check=args.iter().any(|a|a=="--wifi-check");
 let wait_check=args.iter().any(|a|a=="--wifi-wait-check");
 let cold_check=args.iter().any(|a|a=="--cold-discovery-check");
 let silent=args.iter().any(|a|a=="--silent");
 if (qualify||setup)&&!args.iter().any(|a|a=="--silent"){
  let prompt=if setup{"将检查现有 Arduino 工具链；缺失时下载 ESP32 Core 3.3.6 到所选数据目录。无需管理员权限，首次下载可能较大。继续？"}else{"将在本机运行完整桌面资格测试（30 次新编辑、20 次历史恢复、20 次相同源码），另含冷构建和官方对照，可能持续约一小时。请先关闭其他 CK V9.1 窗口；所有样本都会保留。继续？"};
  if message(prompt,MB_YESNO|MB_ICONINFORMATION)!=IDYES{return;}
 }
 unsafe{
  let updating=OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE,0,wide("Local\\CK-V91-Update-Install").as_ptr());
  if !updating.is_null(){CloseHandle(updating);message("CK 正在安装更新，请稍候再打开。",MB_OK|MB_ICONINFORMATION);return;}
  let mutex=CreateMutexW(std::ptr::null(),1,wide("Local\\CK-V91-Product-Launcher").as_ptr());
  if mutex.is_null(){message("无法建立启动器锁。",MB_OK|MB_ICONERROR);return;}
  if GetLastError()==ERROR_ALREADY_EXISTS{CloseHandle(mutex);message("CK V9.1 已在运行或测试中，请先关闭当前会话。",MB_OK|MB_ICONINFORMATION);return;}
  let outcome=(||->Result<i32,String>{
   let root=std::env::current_exe().map_err(|e|e.to_string())?.parent().unwrap().to_path_buf();
   let locator=std::env::var_os("CK_STORAGE_LOCATOR").map(PathBuf::from).unwrap_or(PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("缺少当前用户目录")?).join("CKBuildEngineV91/storage.json"));
   if !locator.is_file(){
    let output=Command::new(root.join("engine/runtime/node.exe")).arg(root.join("engine/scripts/storage-cli.mjs")).arg("init").arg(&root).env("CK_STORAGE_LOCATOR",&locator).creation_flags(CREATE_NO_WINDOW).output().map_err(|e|e.to_string())?;
    if !output.status.success(){return Err(String::from_utf8_lossy(&output.stderr).into_owned());}
   }
   loop {
   if locator.parent().unwrap().join("storage-pending.json").is_file(){
    if let Err(error)=storage_ui::migrate(&root,&locator){message(&error,MB_OK|MB_ICONWARNING);}
   }
   let config:serde_json::Value=serde_json::from_slice(&fs::read(&locator).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
   let data=PathBuf::from(config["root"].as_str().ok_or("数据目录配置无效")?);
   if !data.is_absolute(){return Err("数据目录不是绝对路径".into());}
   std::env::set_var("CK_V91_PRODUCT_ROOT",&data);
   if let Some(temp)=config["temp"].as_str(){fs::create_dir_all(temp).map_err(|e|e.to_string())?;std::env::set_var("TEMP",temp);std::env::set_var("TMP",temp);}
   if args.iter().any(|a|a=="--open-data"){Command::new("explorer.exe").arg(&data).spawn().map_err(|e|e.to_string())?;return Ok(0);}
   std::env::set_var("CK_STORAGE_CONFIG_PATH",&locator);
   std::env::set_var("CK_STORAGE_LOCATOR",&locator);
   fs::create_dir_all(&data).map_err(|e|e.to_string())?;
   let update_dir=data.join("updates").join(format!("launch-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e|e.to_string())?.as_nanos()));
   fs::create_dir_all(&update_dir).map_err(|e|e.to_string())?;
   let update_request=update_dir.join("request.json");
   let log=fs::File::create(data.join("launcher.log")).map_err(|e|e.to_string())?;
   let status=Command::new(root.join("engine/runtime/node.exe")).arg(root.join("engine/scripts/bootstrap.mjs")).args(&args)
    .env("CK_UPDATE_REQUEST_PATH",&update_request)
    .current_dir(&root).creation_flags(CREATE_NO_WINDOW).stdin(Stdio::null()).stdout(log.try_clone().map_err(|e|e.to_string())?).stderr(log).status().map_err(|e|e.to_string())?;
   if status.success()&&update_request.is_file(){
    let helper=update_dir.join("update-helper.exe");
    fs::copy(root.join("engine/bin/update-helper.exe"),&helper).map_err(|e|format!("无法准备更新安装器：{e}"))?;
    Command::new(helper).arg(&update_request).arg(std::process::id().to_string()).creation_flags(CREATE_NO_WINDOW).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e|format!("无法安排更新安装：{e}"))?;
   }else if !update_request.exists(){let _=fs::remove_dir(&update_dir);}
   if status.success() && locator.parent().unwrap().join("storage-pending.json").is_file(){continue;}
   return Ok(status.code().unwrap_or(1));
   }
  })();
  let exit_code=match &outcome{Ok(code)=>*code,Err(_)=>1};
  match outcome{
   Ok(0) if cold_check&&!silent=>{message("首编桌面对照已完成。结果位于 所选数据目录\\cold-discovery-result.json。全部样本均保留；正确性通过不等于性能达标。",MB_OK|MB_ICONINFORMATION);},
   Ok(0) if wait_check&&!silent=>{message("WiFi 等待积木 A/B 检查已完成。结果位于 所选数据目录\\wifi-wait-result.json。该检查不等于完整发布性能资格。",MB_OK|MB_ICONINFORMATION);},
   Ok(0) if wifi_check&&!silent=>{message("WiFi 增量检查已完成。结果位于 所选数据目录\\wifi-check-result.json。该检查不等于完整发布性能资格。",MB_OK|MB_ICONINFORMATION);},
   Ok(0) if (qualify||setup||doctor)&&!silent=>{message("已完成。结果与日志位于 所选数据目录。资格结论请查看 qualification-summary.txt；未达标不会显示为发布通过。",MB_OK|MB_ICONINFORMATION);},
   Ok(0)=>{},
   Ok(code)=>{if !silent{message(&format!("操作未完成（代码 {code}）。请查看 所选数据目录\\launcher.log。缺少工具链时，请运行开始菜单中的“准备工具链”。已采集样本保留。"),MB_OK|MB_ICONERROR);}},
   Err(e)=>{if !silent{message(&format!("无法启动：{e}"),MB_OK|MB_ICONERROR);}}
  }
  ReleaseMutex(mutex);CloseHandle(mutex);
  std::process::exit(exit_code);
 }
}
