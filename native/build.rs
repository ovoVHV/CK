fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") { return; }
    let icon = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../desktop/apps/desktop/src-tauri/icons/icon.ico");
    println!("cargo:rerun-if-changed={}", icon.display());
    let resource = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("ck-launcher.rc");
    let icon_path = icon.canonicalize().unwrap().to_string_lossy().trim_start_matches(r"\\?\").replace('\\', "/");
    std::fs::write(&resource, format!("#pragma code_page(65001)\n1 ICON \"{icon_path}\"\n")).unwrap();
    embed_resource::compile_for(&resource, &["launcher"], embed_resource::NONE)
        .manifest_required().expect("compile the CK launcher icon");
}
