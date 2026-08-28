use anyhow::{Context, Result, anyhow, ensure};
use ck_core::builder::demo::{CompileProfile, compile_sketch_string, fqbn_cache_key};
use ck_core::sysroot::Sysroot;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const FQBN: &str = "arduino:avr:nano";
const CODE: &str = r#"
#include <Arduino.h>
#include <CK_AVR_Blink_Test.h>
#include <DHT.h>

DHT sensor(2, DHT11);

void setup() {
  ck_avr_pin_init(13);
  sensor.begin();
}

void loop() {
  float humidity = sensor.readHumidity();
  if (!isnan(humidity) && humidity > 50.0f) {
    ck_avr_blink_once(13, 2);
  }
}
"#;

fn resolve_ck_root() -> Result<PathBuf> {
    if let Some(root) = std::env::var_os("CK_ROOT") {
        return Ok(PathBuf::from(root));
    }
    let cwd = std::env::current_dir().context("read current directory")?;
    if cwd.join("packages").is_dir() && cwd.join("libraries").is_dir() {
        return Ok(cwd);
    }
    dirs::document_dir()
        .map(|dir| dir.join("CK"))
        .ok_or_else(|| anyhow!("cannot locate CK root; set CK_ROOT"))
}

fn copy_tree(source: &Path, target: &Path) -> Result<()> {
    std::fs::create_dir_all(target).with_context(|| format!("create {}", target.display()))?;
    for entry in std::fs::read_dir(source).with_context(|| format!("read {}", source.display()))? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_tree(&source_path, &target_path)?;
        } else if source_path.is_file() {
            std::fs::copy(&source_path, &target_path).with_context(|| {
                format!(
                    "copy {} to {}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn reset_quickfast_state() {
    let root = std::env::temp_dir().join("CK_Builds");
    let safe = fqbn_cache_key(FQBN);
    let _ = std::fs::remove_dir_all(root.join(format!("sketch_{safe}_qfast2")));
    let _ = std::fs::remove_dir_all(root.join("dep_obj_cache").join(&safe));
    let metadata = root.join("metadata");
    for name in [
        format!("meta_{safe}_qfast2.json"),
        format!("backup_{safe}_qfast2.ino"),
        format!("relink_props_{safe}_qfast2.json"),
    ] {
        let _ = std::fs::remove_file(metadata.join(name));
    }
}

async fn compile_and_capture(
    sysroot: &Arc<Sysroot>,
    libraries: &[PathBuf],
    label: &str,
) -> Result<String> {
    let captured = Arc::new(Mutex::new(String::new()));
    let captured_callback = captured.clone();
    let started = std::time::Instant::now();
    let (_, result_log) = compile_sketch_string(
        sysroot,
        CODE,
        FQBN,
        libraries,
        8,
        "test_lib_cache_invalidation_v2",
        Some("cache-invalidation"),
        CompileProfile::QuickFast,
        ck_core::builder::demo::CkExactReusePolicy::Allow,
        |_pct, _message| {},
        move |line| {
            if let Ok(mut log) = captured_callback.lock() {
                log.push_str(&line);
            }
        },
    )
    .await
    .with_context(|| format!("{label} compile failed"))?;
    let callback_log = captured.lock().map(|log| log.clone()).unwrap_or_default();
    let combined = format!("{callback_log}\n{result_log}");
    let fast_relink =
        combined.contains("Fast Relink completed") || combined.contains("Fast Relink path");
    if std::env::var_os("CK_TEST_DIAGNOSTICS").is_some() {
        for line in combined.lines().filter(|line| {
            line.contains("Fast Relink")
                || line.contains("dependency object")
                || line.contains("library_sources_changed")
                || line.contains("undefined reference")
                || line.contains("multiple definition")
                || line.contains("collect2")
                || line.contains("error:")
        }) {
            println!("  {line}");
        }
    }
    println!(
        "{label}: {}ms fast_relink={} exact={}",
        started.elapsed().as_millis(),
        fast_relink,
        exact_cache_hit(&combined)
    );
    Ok(combined)
}

fn exact_cache_hit(log: &str) -> bool {
    log.contains("Cached build (Exact Match)") || log.contains("Code unchanged (Exact Match)")
}

fn append_marker(path: &Path, marker: &str) -> Result<()> {
    let mut bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    bytes.extend_from_slice(format!("\n// {marker}\n").as_bytes());
    std::fs::write(path, bytes).with_context(|| format!("modify {}", path.display()))
}

#[tokio::main]
async fn main() -> Result<()> {
    let ck_root = resolve_ck_root()?;
    let blink = ck_root.join("libraries/arduino_avr_nano/ck_avr_blink_test");
    let source_dht = ck_root.join("sketchbook/libraries/DHT_sensor_library");
    ensure!(
        blink.is_dir(),
        "missing blink test library: {}",
        blink.display()
    );
    ensure!(
        source_dht.is_dir(),
        "missing DHT test library: {}",
        source_dht.display()
    );

    let temp = tempfile::tempdir().context("create temporary library workspace")?;
    let dht = temp.path().join("libraries/DHT_sensor_library");
    copy_tree(&source_dht, &dht)?;
    let libraries = vec![blink, dht.clone()];
    let sysroot = Arc::new(
        Sysroot::init(Some(ck_root), "CK")
            .await
            .context("initialize CK sysroot")?,
    );

    reset_quickfast_state();
    let initial = compile_and_capture(&sysroot, &libraries, "initial").await?;
    ensure!(!exact_cache_hit(&initial), "cold build hit exact cache");

    let exact_before_change =
        compile_and_capture(&sysroot, &libraries, "exact-before-change").await?;
    ensure!(
        exact_cache_hit(&exact_before_change),
        "unchanged project missed exact cache"
    );

    let dht_header = dht.join("DHT.h");
    let original_header = std::fs::read(&dht_header).context("read temporary DHT.h")?;
    append_marker(&dht_header, "CK_HEADER_CACHE_INVALIDATION_TEST")?;
    let after_header = compile_and_capture(&sysroot, &libraries, "after-header-change").await?;
    ensure!(
        !exact_cache_hit(&after_header),
        "header change incorrectly reused exact cache"
    );

    std::fs::write(&dht_header, &original_header).context("restore temporary DHT.h")?;
    let _ = compile_and_capture(&sysroot, &libraries, "header-restore-baseline").await?;
    let exact_after_restore =
        compile_and_capture(&sysroot, &libraries, "exact-after-restore").await?;
    ensure!(
        exact_cache_hit(&exact_after_restore),
        "restored project missed exact cache after rebaseline"
    );

    let dht_source = dht.join("DHT.cpp");
    append_marker(&dht_source, "CK_SOURCE_CACHE_INVALIDATION_TEST")?;
    let after_source = compile_and_capture(&sysroot, &libraries, "after-source-change").await?;
    ensure!(
        !exact_cache_hit(&after_source),
        "source change incorrectly reused exact cache"
    );

    println!("PASS: header and source changes invalidate the exact cache");
    Ok(())
}
