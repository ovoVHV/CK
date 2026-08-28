use anyhow::{Context, Result, anyhow, ensure};
use ck_core::builder::demo::{CompileProfile, compile_sketch_string, fqbn_cache_key};
use ck_core::sysroot::Sysroot;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const FQBN: &str = "arduino:avr:nano";

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

fn required_library(root: &Path, relative: &str) -> Result<PathBuf> {
    let path = root.join(relative);
    ensure!(
        path.is_dir(),
        "required test library missing: {}",
        path.display()
    );
    Ok(path)
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

struct Observation {
    elapsed_ms: u128,
    fast_relink: bool,
    exact_hit: bool,
}

async fn compile_case(
    sysroot: &Arc<Sysroot>,
    label: &str,
    code: &str,
    libraries: &[PathBuf],
    signature: &str,
) -> Result<Observation> {
    let captured = Arc::new(Mutex::new(String::new()));
    let captured_callback = captured.clone();
    let started = std::time::Instant::now();
    let (_, result_log) = compile_sketch_string(
        sysroot,
        code,
        FQBN,
        libraries,
        8,
        signature,
        Some(label),
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
    let observation = Observation {
        elapsed_ms: started.elapsed().as_millis(),
        fast_relink: combined.contains("Fast Relink completed")
            || combined.contains("Fast Relink path"),
        exact_hit: combined.contains("Cached build (Exact Match)")
            || combined.contains("Code unchanged (Exact Match)"),
    };
    println!(
        "{label}: {}ms fast_relink={} exact={}",
        observation.elapsed_ms, observation.fast_relink, observation.exact_hit
    );
    Ok(observation)
}

#[tokio::main]
async fn main() -> Result<()> {
    let ck_root = resolve_ck_root()?;
    let sysroot = Arc::new(
        Sysroot::init(Some(ck_root.clone()), "CK")
            .await
            .context("initialize CK sysroot")?,
    );
    let blink = required_library(&ck_root, "libraries/arduino_avr_nano/ck_avr_blink_test")?;
    let dht = required_library(&ck_root, "sketchbook/libraries/DHT_sensor_library")?;
    let timer = required_library(&ck_root, "sketchbook/libraries/MsTimer2")?;

    let blink_code = r#"
#include <Arduino.h>
#include <CK_AVR_Blink_Test.h>

void setup() {
  ck_avr_pin_init(13);
}

void loop() {
  ck_avr_blink_once(13, 2);
}
"#;
    let dht_code = r#"
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
    let timer_code = r#"
#include <Arduino.h>
#include <CK_AVR_Blink_Test.h>
#include <MsTimer2.h>

volatile bool ticked = false;

void timerTick() {
  ticked = true;
}

void setup() {
  ck_avr_pin_init(13);
  MsTimer2::set(10, timerTick);
  MsTimer2::start();
}

void loop() {
  if (ticked) {
    ticked = false;
    ck_avr_blink_once(13, 2);
  }
}
"#;

    reset_quickfast_state();
    let first = compile_case(
        &sysroot,
        "initial-blink",
        blink_code,
        std::slice::from_ref(&blink),
        "test_incremental_blink_v2",
    )
    .await?;
    ensure!(!first.exact_hit, "cold compile incorrectly hit exact cache");

    let second = compile_case(
        &sysroot,
        "add-dht",
        dht_code,
        &[blink.clone(), dht],
        "test_incremental_dht_v2",
    )
    .await?;
    ensure!(second.fast_relink, "adding DHT did not use fast relink");

    let third = compile_case(
        &sysroot,
        "switch-to-timer",
        timer_code,
        &[blink, timer],
        "test_incremental_timer_v2",
    )
    .await?;
    ensure!(
        third.fast_relink,
        "switching to MsTimer2 did not use fast relink"
    );

    let exact = compile_case(
        &sysroot,
        "timer-exact",
        timer_code,
        &[
            required_library(&ck_root, "libraries/arduino_avr_nano/ck_avr_blink_test")?,
            required_library(&ck_root, "sketchbook/libraries/MsTimer2")?,
        ],
        "test_incremental_timer_v2",
    )
    .await?;
    ensure!(
        exact.exact_hit,
        "unchanged timer project missed exact cache"
    );

    println!("PASS: incremental library transitions and exact cache are valid");
    Ok(())
}
