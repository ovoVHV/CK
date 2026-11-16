
#[tauri::command]
async fn search_cloud_libraries(app: AppHandle, query: String) -> Result<String, String> {
    let sysroot = get_app_sysroot().await?.root_dir;
    let identifier = "arduino-cli";
    let cmd_path = match app.path().resolve(
        format!("bin/{}", identifier),
        tauri::path::BaseDirectory::Resource
    ) {
        Ok(p) => p,
        Err(_) => std::path::PathBuf::from(if cfg!(target_os = "windows") { "arduino-cli.exe" } else { "arduino-cli" })
    };

    // Construct command
    // arduino-cli lib search <query> --format json
    let mut binding = std::process::Command::new(&cmd_path);
    let cmd = binding
        .arg("--config-file")
        .arg(sysroot.join("arduino-cli.yaml"))
        .arg("lib")
        .arg("search")
        .arg(&query)
        .arg("--format")
        .arg("json");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
async fn update_library_index(app: AppHandle) -> Result<(), String> {
    let sysroot = get_app_sysroot().await?.root_dir;
    
    // Ensure index URL is correct before updating
    let _ = ensure_index_url_and_sync(&sysroot, None, false); // Smart clean logic reuse

    let identifier = "arduino-cli";
    let cmd_path = match app.path().resolve(
        format!("bin/{}", identifier),
        tauri::path::BaseDirectory::Resource
    ) {
        Ok(p) => p,
        Err(_) => std::path::PathBuf::from(if cfg!(target_os = "windows") { "arduino-cli.exe" } else { "arduino-cli" })
    };

    let mut binding = std::process::Command::new(&cmd_path);
    let cmd = binding
        .arg("--config-file")
        .arg(sysroot.join("arduino-cli.yaml"))
        .arg("lib")
        .arg("update-index");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

#[tauri::command]
async fn install_cloud_library(app: AppHandle, name: String, version: Option<String>) -> Result<(), String> {
    let sysroot = get_app_sysroot().await?.root_dir;
    let identifier = "arduino-cli";
    let cmd_path = match app.path().resolve(
        format!("bin/{}", identifier),
        tauri::path::BaseDirectory::Resource
    ) {
        Ok(p) => p,
        Err(_) => std::path::PathBuf::from(if cfg!(target_os = "windows") { "arduino-cli.exe" } else { "arduino-cli" })
    };

    let install_target = if let Some(v) = version {
        format!("{}@{}", name, v)
    } else {
        name
    };

    let mut binding = std::process::Command::new(&cmd_path);
    let cmd = binding
        .arg("--config-file")
        .arg(sysroot.join("arduino-cli.yaml"))
        .arg("lib")
        .arg("install")
        .arg(&install_target)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    let stdout = child.stdout.take().ok_or("Failed to open stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to open stderr")?;

    // Store child for cancellation
    let state: State<InstallState> = app.state();
    *state.child.lock().unwrap() = Some(child);

    let app_handle_out = app.clone();
    let app_handle_err = app.clone();

    // Spawn thread to read stdout
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(l) = line {
                 let _ = app_handle_out.emit("library-install-progress", &l);
            }
        }
    });

    // Spawn thread to read stderr
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
             if let Ok(l) = line {
                 let _ = app_handle_err.emit("library-install-progress", format!("Error: {}", l));
            }
        }
    });

    // Poll process
    let state: State<InstallState> = app.state();
    loop {
        let mut finished_status = None;
        {
            let mut guard = state.child.lock().unwrap();
            if let Some(child) = guard.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => finished_status = Some(Ok(status)),
                    Ok(None) => { 
                        // Still running
                    },
                    Err(e) => finished_status = Some(Err(e)),
                }
            } else {
                return Err("Process cancelled".to_string());
            }
        }
        
        if let Some(result) = finished_status {
            let _ = state.child.lock().unwrap().take();
            match result {
                Ok(status) => {
                    if !status.success() {
                        return Err("Install failed (check logs)".to_string());
                    }
                    return Ok(());
                },
                Err(e) => return Err(e.to_string()),
            }
        }
        
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}
