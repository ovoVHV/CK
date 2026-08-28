/// Direct Compilation Engine benchmark binary.
/// Tests property resolution, source discovery, and (optionally) full compilation.
///
/// Usage: cargo run --release --bin bench_dce
use anyhow::Result;
use ck_core::builder::direct_engine;
use std::path::PathBuf;
use std::time::Instant;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    println!("=== Direct Compilation Engine Benchmark ===");

    let args: Vec<String> = std::env::args().collect();
    let sysroot = args
        .iter()
        .position(|arg| arg == "--sysroot")
        .and_then(|index| args.get(index + 1))
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);

    // --fqbn <fqbn> (default: esp32:esp32:esp32s3:PartitionScheme=huge_app)
    let fqbn = args
        .iter()
        .position(|a| a == "--fqbn")
        .and_then(|i| args.get(i + 1))
        .map(|s| s.as_str())
        .unwrap_or("esp32:esp32:esp32s3:PartitionScheme=huge_app");

    // --sketch <dir_name> (default: smart_cup)
    let sketch_name_arg = args
        .iter()
        .position(|a| a == "--sketch")
        .and_then(|i| args.get(i + 1))
        .map(|s| s.as_str())
        .unwrap_or("smart_cup");
    let sketch_dir = sysroot.join("tmp_sketch").join(sketch_name_arg);
    let sketch_file = sketch_dir.join(format!("{}.ino", sketch_name_arg));
    let build_path = sysroot
        .join("tmp")
        .join(format!("bench_dce_{}", sketch_name_arg));

    if !sketch_file.exists() {
        eprintln!("Sketch not found: {}", sketch_file.display());
        return Ok(());
    }

    let sketch_code = std::fs::read_to_string(&sketch_file)?;
    let sketch_name = format!("{}.ino", sketch_name_arg);

    // Discover library paths based on FQBN
    let extra_libs = discover_sketch_libraries(&sysroot, &sketch_dir, fqbn);
    println!("Libraries: {} paths", extra_libs.len());
    for lib in &extra_libs {
        println!("  {}", lib.display());
    }

    // === Phase 1: Property Resolution Benchmark ===
    let t1 = Instant::now();

    // Build extra props based on architecture
    let is_esp32 = fqbn.starts_with("esp32:");
    let extra_props_esp32 = vec![
        ("compiler.optimization_flags".to_string(), "-O1".to_string()),
        (
            "compiler.c.extra_flags".to_string(),
            "-pipe -g0".to_string(),
        ),
        (
            "compiler.cpp.extra_flags".to_string(),
            "-pipe -g0".to_string(),
        ),
        ("compiler.S.extra_flags".to_string(), "-pipe".to_string()),
    ];
    let extra_props_avr: Vec<(String, String)> = vec![];
    let extra_props: &[(String, String)] = if is_esp32 {
        &extra_props_esp32
    } else {
        &extra_props_avr
    };

    let resolved = direct_engine::resolve_properties(
        &sysroot,
        fqbn,
        &build_path,
        &sketch_dir,
        &sketch_name,
        extra_props,
    )
    .await?;
    println!(
        "\n[Phase 1] Property Resolution: {:.1}ms ({} properties)",
        t1.elapsed().as_secs_f64() * 1000.0,
        resolved.props.len()
    );

    // Print some key properties for verification
    let check_keys = [
        "compiler.path",
        "compiler.cpp.cmd",
        "compiler.sdk.path",
        "build.mcu",
        "build.tarch",
        "build.project_name",
        "recipe.cpp.o.pattern",
        "recipe.c.combine.pattern",
    ];
    for key in &check_keys {
        let val = resolved
            .props
            .get(*key)
            .map(|s| s.as_str())
            .unwrap_or("(missing)");
        let display_val = if val.len() > 120 { &val[..120] } else { val };
        println!("  {} = {}", key, display_val);
    }

    // === Phase 2: Full Compilation ===
    let do_compile = std::env::args().any(|a| a == "--compile");
    let incremental = std::env::args().any(|a| a == "--incremental");
    let no_artifacts = std::env::args().any(|a| a == "--no-artifacts");
    if do_compile || incremental {
        println!(
            "\n=== Full Compilation ({}{}) ===",
            if incremental { "INCREMENTAL" } else { "CLEAN" },
            if no_artifacts { ", no-artifacts" } else { "" }
        );
        if !incremental {
            let _ = std::fs::remove_dir_all(&build_path);
        }

        let result = direct_engine::direct_compile(
            &sysroot,
            fqbn,
            &sketch_code,
            &sketch_dir,
            &sketch_name,
            &extra_libs,
            &build_path,
            8,
            !no_artifacts,
            &|msg| print!("{}", msg),
        )
        .await?;

        println!(
            "\nELF: {} ({} bytes)",
            result.elf_path.display(),
            std::fs::metadata(&result.elf_path)
                .map(|m| m.len())
                .unwrap_or(0)
        );
        println!("Total: {:.1}s", result.elapsed_secs);
    } else if !do_compile && !incremental {
        println!("\nRun with --compile (clean) or --incremental to build.");
    }

    Ok(())
}

/// Find the platform libraries directory dynamically based on FQBN.
fn find_platform_libraries(sysroot: &std::path::Path, fqbn: &str) -> PathBuf {
    let parts: Vec<&str> = fqbn.split(':').collect();
    let (package, arch) = if parts.len() >= 2 {
        (parts[0], parts[1])
    } else {
        ("esp32", "esp32")
    };
    let hw_dir = sysroot
        .join("packages")
        .join(package)
        .join("hardware")
        .join(arch);
    // Find the latest version directory
    if let Ok(entries) = std::fs::read_dir(&hw_dir) {
        let mut best: Option<(Vec<u32>, PathBuf)> = None;
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            let name = p
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let parts: Vec<u32> = name.split('.').filter_map(|s| s.parse().ok()).collect();
            if !parts.is_empty() && (best.is_none() || parts > best.as_ref().unwrap().0) {
                best = Some((parts, p));
            }
        }
        if let Some((_, version_dir)) = best {
            return version_dir.join("libraries");
        }
    }
    hw_dir.join("3.3.6").join("libraries") // fallback
}

/// Recursively discover library dependencies by scanning #include directives.
/// This replaces arduino-cli's library resolver (~360s) with direct scanning (~50ms).
fn discover_sketch_libraries(sysroot: &PathBuf, sketch_dir: &PathBuf, fqbn: &str) -> Vec<PathBuf> {
    let parts: Vec<&str> = fqbn.split(':').collect();
    let (package, arch, board) = if parts.len() >= 3 {
        (
            parts[0],
            parts[1],
            parts[2].split(':').next().unwrap_or(parts[2]),
        )
    } else {
        ("esp32", "esp32", "esp32s3")
    };

    // Build index: header_name -> library_path
    let mut lib_roots = vec![
        find_platform_libraries(sysroot, fqbn),
        sysroot.join("empty_sketchbook").join("libraries"),
        sysroot.join("sketchbook").join("libraries"),
    ];

    // Add board-specific library overrides if they exist
    let board_lib = sysroot
        .join("libraries")
        .join(format!("{}_{}_{}", package, arch, board));
    if board_lib.exists() {
        lib_roots.push(board_lib);
    }

    let mut header_to_lib: std::collections::HashMap<String, PathBuf> =
        std::collections::HashMap::new();
    for root in &lib_roots {
        if !root.exists() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let lib_path = entry.path();
                if !lib_path.is_dir() {
                    continue;
                }
                // Index by library name
                let lib_name = entry.file_name().to_string_lossy().to_string();
                // Don't overwrite if already found (priority: earlier roots win)
                if header_to_lib
                    .values()
                    .any(|p| p.file_name().unwrap_or_default().to_string_lossy() == lib_name)
                {
                    continue;
                }
                // Scan for headers in src/ or root
                let src_dir = lib_path.join("src");
                let scan_dir = if src_dir.exists() {
                    &src_dir
                } else {
                    &lib_path
                };
                index_library_headers(scan_dir, &lib_path, &mut header_to_lib);
            }
        }
    }

    // BFS: start from sketch includes, discover transitive deps
    let mut resolved: Vec<PathBuf> = Vec::new();
    let mut resolved_set: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    let mut pending_includes: Vec<String> = Vec::new();
    let mut scanned_files: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();

    // Seed from sketch files
    scan_includes_in_dir(sketch_dir, &mut pending_includes, &mut scanned_files);

    while !pending_includes.is_empty() {
        let batch: Vec<String> = pending_includes.drain(..).collect();
        for header in batch {
            if let Some(lib_path) = header_to_lib.get(&header) {
                if resolved_set.insert(lib_path.clone()) {
                    resolved.push(lib_path.clone());
                    // Scan this library's sources for more includes
                    let src_dir = lib_path.join("src");
                    let scan_dir = if src_dir.exists() {
                        src_dir
                    } else {
                        lib_path.clone()
                    };
                    scan_includes_in_dir(&scan_dir, &mut pending_includes, &mut scanned_files);
                }
            }
        }
    }

    resolved
}

/// Index headers in a library directory: map header filename -> library path.
fn index_library_headers(
    dir: &std::path::Path,
    lib_path: &std::path::Path,
    map: &mut std::collections::HashMap<String, PathBuf>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            index_library_headers(&p, lib_path, map);
            continue;
        }
        if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
            if ext == "h" || ext == "hpp" {
                let fname = p
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                map.entry(fname).or_insert_with(|| lib_path.to_path_buf());
            }
        }
    }
}

/// Extract #include <header> from all source files in a directory.
fn scan_includes_in_dir(
    dir: &std::path::Path,
    includes: &mut Vec<String>,
    scanned: &mut std::collections::HashSet<PathBuf>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            scan_includes_in_dir(&p, includes, scanned);
            continue;
        }
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !matches!(ext.as_str(), "ino" | "h" | "hpp" | "cpp" | "c" | "cc") {
            continue;
        }
        if !scanned.insert(p.clone()) {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(&p) {
            for line in content.lines() {
                let trimmed = line.trim();
                if !trimmed.starts_with("#include") {
                    continue;
                }
                // Extract header file name from #include <...> or #include "..."
                let after = trimmed.strip_prefix("#include").unwrap_or("").trim();
                let (start_ch, end_ch) = if after.starts_with('<') {
                    ('<', '>')
                } else if after.starts_with('"') {
                    ('"', '"')
                } else {
                    continue;
                };
                if let Some(rest) = after.strip_prefix(start_ch) {
                    if let Some(end) = rest.find(end_ch) {
                        let header_path = &rest[..end];
                        // Get just the filename (for Fonts/FreeSans9pt7b.h -> FreeSans9pt7b.h)
                        let fname = header_path.rsplit('/').next().unwrap_or(header_path);
                        includes.push(fname.to_string());
                    }
                }
            }
        }
    }
}
