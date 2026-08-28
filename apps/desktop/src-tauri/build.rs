fn main() {
    // Windows GUI executables default to a 1 MiB main-thread stack. Tauri may
    // initially poll an async command on that thread, and the optimized
    // compile/diagnostic call chain can cross that reserve even though its
    // measured Future is small (tens of KiB). Reserve 8 MiB of virtual address
    // space while keeping the PE commit size at the platform default, so pages
    // consume physical memory only when they are actually touched.
    #[cfg(target_os = "windows")]
    println!("cargo:rustc-link-arg-bin=appsdesktop=/STACK:8388608");
    tauri_build::build()
}
