#![windows_subsystem = "windows"]
use std::{
    fs,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use windows_sys::Win32::{Foundation::*, System::Threading::*, UI::WindowsAndMessaging::*};
#[path = "../storage_ui.rs"]
mod storage_ui;

#[link(name = "kernel32")]
extern "system" {
    fn GetUserDefaultUILanguage() -> u16;
}

fn is_chinese_ui() -> bool {
    // Primary language ID 0x04 == LANG_CHINESE (covers zh-CN, zh-TW, zh-HK, zh-SG)
    unsafe { (GetUserDefaultUILanguage() & 0x03FF) == 0x04 }
}

fn tr<'a>(zh: &'a str, en: &'a str) -> &'a str {
    if is_chinese_ui() { zh } else { en }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn message(text: &str, flags: u32) -> i32 {
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            wide(text).as_ptr(),
            wide("CK LAB").as_ptr(),
            flags,
        )
    }
}

fn normalize_launch_args(raw_args: Vec<String>, initial_cwd: Option<&Path>) -> Vec<String> {
    let Some(cwd) = initial_cwd else {
        return raw_args;
    };
    raw_args
        .into_iter()
        .map(|arg| {
            let trimmed = arg.trim();
            if trimmed.is_empty()
                || trimmed.starts_with('-')
                || trimmed.starts_with("ck://")
                || trimmed.starts_with("file://")
            {
                return arg;
            }
            let p = Path::new(trimmed);
            if p.is_absolute() {
                return arg;
            }
            let lower = trimmed.to_ascii_lowercase();
            let looks_like_project = lower.ends_with(".ck") || lower.ends_with(".maker");
            let joined = cwd.join(p);
            if looks_like_project || joined.exists() {
                joined.to_string_lossy().into_owned()
            } else {
                arg
            }
        })
        .collect()
}

fn open_launcher_log(data: &Path, already_running: bool) -> Result<fs::File, String> {
    if !already_running {
        if let Ok(file) = fs::File::create(data.join("launcher.log")) {
            return Ok(file);
        }
    }
    fs::File::create(data.join(format!("launcher-{}.log", std::process::id())))
        .map_err(|e| e.to_string())
}

fn main() {
    let initial_cwd = std::env::current_dir().ok();
    let args = normalize_launch_args(std::env::args().skip(1).collect(), initial_cwd.as_deref());
    let qualify = args.iter().any(|a| a == "--qualify");
    let setup = args.iter().any(|a| a == "--install-assets");
    let doctor = args.iter().any(|a| a == "--doctor");
    let wifi_check = args.iter().any(|a| a == "--wifi-check");
    let wait_check = args.iter().any(|a| a == "--wifi-wait-check");
    let cold_check = args.iter().any(|a| a == "--cold-discovery-check");
    let silent = args.iter().any(|a| a == "--silent");
    let exclusive_mode = qualify
        || setup
        || doctor
        || wifi_check
        || wait_check
        || cold_check
        || args.iter().any(|a| {
            matches!(
                a.as_str(),
                "--update-check"
                    | "--unicode-path-check"
                    | "--smoke"
                    | "--lifecycle"
                    | "--configuration-check"
                    | "--avr-performance-check"
                    | "--avr-workflow-check"
                    | "--button-cold-check"
            )
        });

    if (qualify || setup) && !silent {
        let prompt = if setup {
            tr(
                "将检查现有 Arduino 工具链；缺失时下载 ESP32 Core 3.3.6 到所选数据目录。无需管理员权限，首次下载可能较大。继续？",
                "CK LAB will check your existing Arduino toolchains and download missing ESP32/AVR cores to your data folder. No administrator rights required. Continue?",
            )
        } else {
            tr(
                "将在本机运行完整桌面资格测试（30 次新编辑、20 次历史恢复、20 次相同源码），另含冷构建和官方对照，可能持续约一小时。请先关闭其他 CK LAB 窗口；所有样本都会保留。继续？",
                "This will run the full desktop qualification suite (may take around an hour). Please close all other CK LAB windows first; all raw samples will be retained. Continue?",
            )
        };
        if message(prompt, MB_YESNO | MB_ICONINFORMATION) != IDYES {
            return;
        }
    }

    unsafe {
        let updating = OpenMutexW(
            SYNCHRONIZATION_SYNCHRONIZE,
            0,
            wide("Local\\CK-V91-Update-Install").as_ptr(),
        );
        if !updating.is_null() {
            CloseHandle(updating);
            message(
                tr(
                    "CK LAB 正在安装更新，请稍候再打开。",
                    "CK LAB is currently installing an update. Please try again shortly.",
                ),
                MB_OK | MB_ICONINFORMATION,
            );
            return;
        }

        // Check whether an exclusive maintenance/qualification session is currently active.
        let active_exclusive = OpenMutexW(
            SYNCHRONIZATION_SYNCHRONIZE,
            0,
            wide("Local\\CK-V91-Exclusive-Session").as_ptr(),
        );
        if !active_exclusive.is_null() {
            CloseHandle(active_exclusive);
            message(
                tr(
                    "CK LAB 正在执行测试、工具链准备或数据迁移，请等待当前任务结束后再打开。",
                    "CK LAB is currently running a setup, migration, or verification task. Please wait until it finishes.",
                ),
                MB_OK | MB_ICONINFORMATION,
            );
            return;
        }

        // Shared presence handle: stays alive in Windows kernel as long as ANY CK LAB
        // window is running, so installers and update-helper still reliably detect active
        // sessions while allowing unlimited normal multi-instance windows.
        let presence_mutex = CreateMutexW(
            std::ptr::null(),
            0,
            wide("Local\\CK-V91-Product-Launcher").as_ptr(),
        );
        if presence_mutex.is_null() {
            message(
                tr("无法建立启动器会话句柄。", "Failed to create launcher session handle."),
                MB_OK | MB_ICONERROR,
            );
            return;
        }
        let already_running = GetLastError() == ERROR_ALREADY_EXISTS;

        let mut exclusive_mutex: HANDLE = std::ptr::null_mut();
        if exclusive_mode {
            if already_running {
                CloseHandle(presence_mutex);
                message(
                    tr(
                        "请先关闭所有已打开的 CK LAB 窗口，再运行此测试或工具链准备任务。",
                        "Please close all open CK LAB windows before running this check or toolchain setup.",
                    ),
                    MB_OK | MB_ICONINFORMATION,
                );
                return;
            }
            exclusive_mutex = CreateMutexW(
                std::ptr::null(),
                0,
                wide("Local\\CK-V91-Exclusive-Session").as_ptr(),
            );
            if exclusive_mutex.is_null() || GetLastError() == ERROR_ALREADY_EXISTS {
                if !exclusive_mutex.is_null() {
                    CloseHandle(exclusive_mutex);
                }
                CloseHandle(presence_mutex);
                message(
                    tr(
                        "已有测试或工具链准备任务正在运行，请等待其完成。",
                        "Another setup or verification task is already running.",
                    ),
                    MB_OK | MB_ICONINFORMATION,
                );
                return;
            }
        }

        let outcome = (|| -> Result<i32, String> {
            let root = std::env::current_exe()
                .map_err(|e| e.to_string())?
                .parent()
                .unwrap()
                .to_path_buf();
            let locator = std::env::var_os("CK_STORAGE_LOCATOR")
                .map(PathBuf::from)
                .unwrap_or(
                    PathBuf::from(
                        std::env::var_os("LOCALAPPDATA")
                            .ok_or_else(|| tr("缺少当前用户目录", "Missing LOCALAPPDATA directory"))?,
                    )
                    .join("CKBuildEngineV91/storage.json"),
                );
            if !locator.is_file() {
                let output = Command::new(root.join("engine/runtime/node.exe"))
                    .arg(root.join("engine/scripts/storage-cli.mjs"))
                    .arg("init")
                    .arg(&root)
                    .env("CK_STORAGE_LOCATOR", &locator)
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
                    .map_err(|e| e.to_string())?;
                if !output.status.success() {
                    return Err(String::from_utf8_lossy(&output.stderr).into_owned());
                }
            }
            loop {
                if locator.parent().unwrap().join("storage-pending.json").is_file() {
                    if already_running {
                        message(
                            tr(
                                "检测到待执行的数据目录迁移，请先关闭其他 CK LAB 窗口后再重新打开。",
                                "A pending data folder migration was found. Please close all other CK LAB windows and reopen CK LAB.",
                            ),
                            MB_OK | MB_ICONWARNING,
                        );
                        return Ok(0);
                    }
                    if exclusive_mutex.is_null() {
                        exclusive_mutex = CreateMutexW(
                            std::ptr::null(),
                            0,
                            wide("Local\\CK-V91-Exclusive-Session").as_ptr(),
                        );
                    }
                    if let Err(error) = storage_ui::migrate(&root, &locator) {
                        message(&error, MB_OK | MB_ICONWARNING);
                    }
                    if !exclusive_mode && !exclusive_mutex.is_null() {
                        CloseHandle(exclusive_mutex);
                        exclusive_mutex = std::ptr::null_mut();
                    }
                }
                let config: serde_json::Value =
                    serde_json::from_slice(&fs::read(&locator).map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                let data = PathBuf::from(
                    config["root"]
                        .as_str()
                        .ok_or_else(|| tr("数据目录配置无效", "Invalid data folder configuration"))?,
                );
                if !data.is_absolute() {
                    return Err(tr("数据目录不是绝对路径", "Data folder path is not absolute").into());
                }
                std::env::set_var("CK_V91_PRODUCT_ROOT", &data);
                if let Some(temp) = config["temp"].as_str() {
                    fs::create_dir_all(temp).map_err(|e| e.to_string())?;
                    std::env::set_var("TEMP", temp);
                    std::env::set_var("TMP", temp);
                }
                if args.iter().any(|a| a == "--open-data") {
                    Command::new("explorer.exe")
                        .arg(&data)
                        .spawn()
                        .map_err(|e| e.to_string())?;
                    return Ok(0);
                }
                std::env::set_var("CK_STORAGE_CONFIG_PATH", &locator);
                std::env::set_var("CK_STORAGE_LOCATOR", &locator);
                fs::create_dir_all(&data).map_err(|e| e.to_string())?;
                let update_dir = data.join("updates").join(format!(
                    "launch-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_err(|e| e.to_string())?
                        .as_nanos()
                ));
                fs::create_dir_all(&update_dir).map_err(|e| e.to_string())?;
                let update_request = update_dir.join("request.json");
                let log = open_launcher_log(&data, already_running)?;
                let status = Command::new(root.join("engine/runtime/node.exe"))
                    .arg(root.join("engine/scripts/bootstrap.mjs"))
                    .args(&args)
                    .env("CK_UPDATE_REQUEST_PATH", &update_request)
                    .current_dir(&root)
                    .creation_flags(CREATE_NO_WINDOW)
                    .stdin(Stdio::null())
                    .stdout(log.try_clone().map_err(|e| e.to_string())?)
                    .stderr(log)
                    .status()
                    .map_err(|e| e.to_string())?;
                if status.success() && update_request.is_file() {
                    let helper = update_dir.join("update-helper.exe");
                    fs::copy(root.join("engine/bin/update-helper.exe"), &helper).map_err(|e| {
                        format!(
                            "{}{e}",
                            tr("无法准备更新安装器：", "Failed to stage update installer: ")
                        )
                    })?;
                    Command::new(helper)
                        .arg(&update_request)
                        .arg(std::process::id().to_string())
                        .creation_flags(CREATE_NO_WINDOW)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .map_err(|e| {
                            format!(
                                "{}{e}",
                                tr("无法安排更新安装：", "Failed to schedule update install: ")
                            )
                        })?;
                } else if !update_request.exists() {
                    let _ = fs::remove_dir(&update_dir);
                }
                if status.success() && locator.parent().unwrap().join("storage-pending.json").is_file() {
                    continue;
                }
                return Ok(status.code().unwrap_or(1));
            }
        })();

        let exit_code = match &outcome {
            Ok(code) => *code,
            Err(_) => 1,
        };
        match outcome {
            Ok(0) if cold_check && !silent => {
                message(
                    tr(
                        "首编桌面对照已完成。结果位于 所选数据目录\\cold-discovery-result.json。全部样本均保留；正确性通过不等于性能达标。",
                        "Cold-build desktop comparison completed. Results are saved in <DataFolder>\\cold-discovery-result.json.",
                    ),
                    MB_OK | MB_ICONINFORMATION,
                );
            }
            Ok(0) if wait_check && !silent => {
                message(
                    tr(
                        "WiFi 等待积木 A/B 检查已完成。结果位于 所选数据目录\\wifi-wait-result.json。该检查不等于完整发布性能资格。",
                        "WiFi wait-block A/B check completed. Results are saved in <DataFolder>\\wifi-wait-result.json.",
                    ),
                    MB_OK | MB_ICONINFORMATION,
                );
            }
            Ok(0) if wifi_check && !silent => {
                message(
                    tr(
                        "WiFi 增量检查已完成。结果位于 所选数据目录\\wifi-check-result.json。该检查不等于完整发布性能资格。",
                        "WiFi incremental check completed. Results are saved in <DataFolder>\\wifi-check-result.json.",
                    ),
                    MB_OK | MB_ICONINFORMATION,
                );
            }
            Ok(0) if (qualify || setup || doctor) && !silent => {
                message(
                    tr(
                        "已完成。结果与日志位于 所选数据目录。资格结论请查看 qualification-summary.txt；未达标不会显示为发布通过。",
                        "Operation completed. Results and logs are saved in your data folder.",
                    ),
                    MB_OK | MB_ICONINFORMATION,
                );
            }
            Ok(0) => {}
            Ok(code) => {
                if !silent {
                    let msg = if is_chinese_ui() {
                        format!("操作未完成（代码 {code}）。请查看数据目录下的 launcher.log。缺少工具链时，请运行开始菜单中的“准备工具链”。已采集样本保留。")
                    } else {
                        format!("Operation did not complete (exit code {code}). Please check launcher.log in your data folder.")
                    };
                    message(&msg, MB_OK | MB_ICONERROR);
                }
            }
            Err(e) => {
                if !silent {
                    let msg = format!("{}{e}", tr("无法启动：", "Failed to launch: "));
                    message(&msg, MB_OK | MB_ICONERROR);
                }
            }
        }
        if !exclusive_mutex.is_null() {
            CloseHandle(exclusive_mutex);
        }
        CloseHandle(presence_mutex);
        std::process::exit(exit_code);
    }
}
