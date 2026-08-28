use ck_core::registry::boards::parse_boards_txt;
use ck_core::registry::platform::Platform;
use ck_core::sysroot::Sysroot;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use ck_core::builder::context::BuildContext;
use ck_core::builder::graph::DependencyGraph;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    println!("🚀 CK Engine Benchmark");
    println!("========================");

    // 1. Setup Sysroot
    let start = Instant::now();
    let sysroot = Sysroot::init(None, "CK").await?;
    println!("[Init] Sysroot init: {:?}", start.elapsed());

    // 2. Locate ESP32 Core
    // Path: sysroot/packages/packages/esp32/hardware/esp32/3.3.1
    let esp32_dir = sysroot
        .root_dir
        .join("packages")
        .join("packages")
        .join("esp32")
        .join("hardware")
        .join("esp32")
        .join("3.3.1");
    if !esp32_dir.exists() {
        eprintln!(
            "❌ ESP32 core not found at {:?}. Please run install_esp32 first.",
            esp32_dir
        );
        return Ok(());
    }

    // 3. Bench: Platform Parsing
    let platform_txt = esp32_dir.join("platform.txt");
    let start = Instant::now();
    let platform = Platform::from_file(&platform_txt).await?;
    let duration = start.elapsed();
    println!(
        "[Bench] Parse platform.txt: {:?} (Version: {})",
        duration, platform.version
    );

    // 4. Bench: Boards Parsing
    let boards_txt = esp32_dir.join("boards.txt");
    let start = Instant::now();
    let boards = parse_boards_txt(&boards_txt).await?;
    let duration = start.elapsed();
    println!(
        "[Bench] Parse boards.txt: {:?} (Boards: {})",
        duration,
        boards.len()
    );

    // 5. Bench: Dependency Scanning (Synthetic)
    println!("[Bench] Generating synthetic project (100 files)...");
    let temp_dir = tempfile::tempdir()?;
    let project_dir = temp_dir.path();

    // Create 100 header files chain
    for i in 0..100 {
        let filename = format!("header_{}.h", i);
        let content = if i < 99 {
            format!("#include \"header_{}.h\"\n// Some payload", i + 1)
        } else {
            "// Leaf node".to_string()
        };
        fs::write(project_dir.join(filename), content)?;
    }
    // Main file
    fs::write(project_dir.join("main.cpp"), "#include \"header_0.h\"")?;

    let start = Instant::now();
    let mut context = BuildContext::new();
    context.add_include_path(project_dir);

    let mut graph = DependencyGraph::new();
    graph.scan(&project_dir.join("main.cpp"), &context)?; // Use Context from anyhow if needed, but here we use build context
    let duration = start.elapsed();

    println!("[Bench] Scan 100 files (deep chain): {:?}", duration);
    println!("    -> Nodes in graph: {}", graph.nodes.len());

    Ok(())
}
