// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// A release binary without Tauri's application protocol still points its
// WebView at the development URL (http://localhost:1420). Such an executable
// looks like a valid production artifact but opens a "connection refused"
// screen on machines where Vite is not running. Refuse to create it.
#[cfg(all(not(debug_assertions), not(feature = "custom-protocol")))]
compile_error!(
    "CK production builds require the `custom-protocol` feature. Run `npm run desktop:build` for installers or `npm run desktop:build:exe` for the standalone production executable."
);

fn main() {
    if let Some(exit_code) =
        appsdesktop_lib::maybe_run_prebuild_restore_from_args(std::env::args_os())
    {
        std::process::exit(exit_code);
    }
    // Registration is an optional capability handshake. Failure simply keeps
    // PortableFast on its native (slower) prebuild path.
    let _ = appsdesktop_lib::register_current_exe_as_prebuild_restore_helper();
    appsdesktop_lib::run()
}
