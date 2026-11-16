use std::{fs,path::Path,process::{Command,Stdio},os::windows::process::CommandExt,time::Duration};
use windows_sys::Win32::{System::Threading::CREATE_NO_WINDOW,UI::WindowsAndMessaging::*};
fn wide(s:&str)->Vec<u16>{s.encode_utf16().chain(Some(0)).collect()}

// Migration runs only while the launcher owns its single-instance mutex and
// both the desktop and build controller have exited. It never removes sources.
pub fn migrate(install:&Path,locator:&Path)->Result<(),String>{
    let control=locator.parent().ok_or("数据目录定位文件无效")?;
    let cancel=control.join("storage-cancel");
    if cancel.exists(){fs::remove_file(&cancel).map_err(|e|e.to_string())?;}
    let progress=control.join("storage-progress.json");
    if progress.exists(){fs::remove_file(&progress).map_err(|e|e.to_string())?;}
    let log=fs::File::create(control.join("storage-migration.log")).map_err(|e|e.to_string())?;
    unsafe{
        let window=CreateWindowExW(WS_EX_APPWINDOW,wide("STATIC").as_ptr(),wide("CK 数据迁移 — 原目录会保留").as_ptr(),WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_VISIBLE, CW_USEDEFAULT,CW_USEDEFAULT,610,195,std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null());
        if window.is_null(){return Err("无法显示迁移进度，原目录未修改".into());}
        let label=CreateWindowExW(0,wide("STATIC").as_ptr(),wide("正在统计文件，请稍候……\r\n关闭此窗口可取消迁移。").as_ptr(),WS_CHILD|WS_VISIBLE,20,22,560,110,window,std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null());
        let child=Command::new(install.join("engine/runtime/node.exe")).arg(install.join("engine/scripts/storage-cli.mjs")).arg("migrate").env("CK_STORAGE_LOCATOR",locator).creation_flags(CREATE_NO_WINDOW).stdin(Stdio::null()).stdout(log.try_clone().map_err(|e|e.to_string())?).stderr(log).spawn();
        let mut child=match child{Ok(c)=>c,Err(e)=>{DestroyWindow(window);return Err(e.to_string());}};
        loop{
            let mut msg:MSG=std::mem::zeroed();
            while PeekMessageW(&mut msg,std::ptr::null_mut(),0,0,PM_REMOVE)!=0{TranslateMessage(&msg);DispatchMessageW(&msg);}
            if IsWindow(window)==0{let _=fs::write(&cancel,b"cancel");}
            if let Ok(bytes)=fs::read(&progress){if let Ok(p)=serde_json::from_slice::<serde_json::Value>(&bytes){
                let phase=if p["phase"]=="verify"{"校验文件"}else{"复制文件"};
                let text=format!("{}：{} / {} 个文件，已复制 {:.1} MB\r\n{}\r\n关闭此窗口可取消；不会删除原目录。",phase,p["completed"],p["total"],p["bytes"].as_f64().unwrap_or(0.0)/1048576.0,p["current"].as_str().unwrap_or(""));
                SetWindowTextW(label,wide(&text).as_ptr());
            }}
            if let Some(status)=child.try_wait().map_err(|e|e.to_string())?{
                if IsWindow(window)!=0{DestroyWindow(window);}
                if status.success(){return Ok(());}
                let details=fs::read(control.join("storage-last-error.json")).ok().and_then(|b|serde_json::from_slice::<serde_json::Value>(&b).ok()).and_then(|v|v["error"].as_str().map(str::to_owned)).unwrap_or_else(||"迁移未完成".into());
                return Err(format!("{details}\n原数据仍保留，CK 将继续使用原位置。"));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}
