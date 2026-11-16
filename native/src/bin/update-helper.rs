#![windows_subsystem = "windows"]
use std::{fs, path::PathBuf, process::{Command, Stdio}, os::windows::process::CommandExt};
use windows_sys::Win32::{Foundation::*, System::Threading::*, UI::WindowsAndMessaging::*};
use ck_update_protocol as protocol;
fn wide(s:&str)->Vec<u16>{s.encode_utf16().chain(Some(0)).collect()}
fn show(s:&str){unsafe{MessageBoxW(std::ptr::null_mut(),wide(s).as_ptr(),wide("CK 软件升级").as_ptr(),MB_OK|MB_ICONERROR);}}
struct UpgradeLock(HANDLE);
impl Drop for UpgradeLock { fn drop(&mut self){unsafe{ReleaseMutex(self.0);CloseHandle(self.0);}} }
fn install(args:&[String])->Result<(),String>{
    if args.len()!=3 {return Err("升级请求参数无效".into());}
    let request_file=PathBuf::from(&args[1]);
    if fs::metadata(&request_file).map_err(|e|e.to_string())?.len()>128*1024 {return Err("升级请求过大".into());}
    let request:protocol::InstallRequest=serde_json::from_slice(&fs::read(&request_file).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    if request.schema!=1 {return Err("升级请求版本不支持".into());}
    let manifest=protocol::verify_manifest(request.envelope.as_bytes(),&protocol::channel()?)?;
    if !protocol::is_newer(&manifest,&request.current_version)? {return Err("拒绝相同版本或降级安装".into());}
    let root=PathBuf::from(&request.install_root);
    if !root.is_absolute() || fs::read_to_string(root.join("package-id.txt")).unwrap_or_default().trim()!=protocol::PACKAGE_MARKER {return Err("CK 安装目录验证失败".into());}
    let package:serde_json::Value=serde_json::from_slice(&fs::read(root.join("engine/package.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    if package.get("version").and_then(|v|v.as_str())!=Some(request.current_version.as_str()) {return Err("已安装版本发生变化，请重新检查更新".into());}
    let installer=PathBuf::from(&request.installer);
    let _verified_file=protocol::open_verified_package(&installer,&manifest)?;
    let parent:u32=args[2].parse().map_err(|_|"启动器进程号无效")?;
    let upgrade_lock=unsafe {
        let update_mutex=CreateMutexW(std::ptr::null(),1,wide("Local\\CK-V91-Update-Install").as_ptr());
        if update_mutex.is_null(){return Err("无法建立升级锁".into());}
        if GetLastError()==ERROR_ALREADY_EXISTS{CloseHandle(update_mutex);return Err("已有升级正在进行".into());}
        let lock=UpgradeLock(update_mutex);
        let process=OpenProcess(PROCESS_SYNCHRONIZE,0,parent);
        if !process.is_null(){let result=WaitForSingleObject(process,60000);CloseHandle(process);if result!=WAIT_OBJECT_0{return Err("CK 尚未完全退出，已停止安装".into());}}
        let running=OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE,0,wide("Local\\CK-V91-Product-Launcher").as_ptr());
        if !running.is_null(){CloseHandle(running);return Err("CK 仍在运行，已停止安装".into());}
        lock
    };
    // NSIS requires /D to be last and unquoted, including paths with spaces.
    // This is passed directly to CreateProcess, never through a shell.
    if request.install_root.contains(['"','\r','\n']) {return Err("安装目录包含无效字符".into());}
    let status=Command::new(&installer).arg("/S").raw_arg(format!("/D={}",root.display()))
        .creation_flags(CREATE_NO_WINDOW).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .status().map_err(|e|format!("无法启动安装器：{e}"))?;
    if !status.success(){return Err(format!("安装器返回 {}，安装包已保留在 {}",status.code().unwrap_or(-1),installer.display()));}
    let installed:serde_json::Value=serde_json::from_slice(&fs::read(root.join("engine/package.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    if installed.get("version").and_then(|v|v.as_str())!=Some(manifest.version.as_str()){return Err("安装后版本验证失败，未自动启动".into());}
    // Rename the one-shot request before restarting; failed requests are never
    // consumed on a later normal launch because each launch uses a new path.
    fs::rename(&request_file,request_file.with_extension("completed.json")).map_err(|e|e.to_string())?;
    drop(upgrade_lock);
    Command::new(root.join("CK-V9.1.exe"))
        .creation_flags(CREATE_NO_WINDOW).spawn().map_err(|e|e.to_string())?;
    Ok(())
}
fn main(){
    let args:Vec<String>=std::env::args().collect();
    if let Err(error)=install(&args){
        if let Some(root)=std::env::var_os("CK_V91_PRODUCT_ROOT").map(PathBuf::from).or_else(||std::env::var_os("LOCALAPPDATA").map(|p|PathBuf::from(p).join("CKBuildEngineV91"))){let dir=root.join("updates");let _=fs::create_dir_all(&dir);let _=fs::write(dir.join("last-install-error.txt"),&error);}
        show(&error);std::process::exit(1);
    }
}
