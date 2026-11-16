use anyhow::{Context, Result, bail};
use ck_core::builder::demo::{CompileProfile, compile_sketch_string, fqbn_cache_key};
use ck_core::sysroot::Sysroot;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

const MIN_FIRST_COMPILE_IMPROVEMENT: f64 = 0.30;
const FIRST_COMPILE_SAMPLES: usize = 3;

fn first_compile_sensor_bus_project() -> &'static str {
    r#"
#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>
#include <EEPROM.h>
#include <DHT.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>

DHT dht(2, DHT11);
Adafruit_BME280 bme;

struct SensorFrame {
  uint16_t seq;
  float humidity;
  float dhtTemp;
  float bmeTemp;
  float pressure;
  uint16_t checksum;
};

SensorFrame frames[16];
uint8_t frameCursor = 0;
uint16_t sequenceNo = 0;

uint16_t foldByte(uint16_t acc, uint8_t value) {
  acc ^= value;
  acc = (uint16_t)((acc << 5) | (acc >> 11));
  return (uint16_t)(acc + 0x9E37);
}

uint16_t checksumFrame(const SensorFrame& frame) {
  const uint8_t* raw = reinterpret_cast<const uint8_t*>(&frame);
  uint16_t acc = 0xC0DE;
  for (uint8_t i = 0; i < sizeof(SensorFrame) - sizeof(uint16_t); ++i) {
    acc = foldByte(acc, raw[i]);
  }
  return acc;
}

void recordFrame(float humidity, float dhtTemp, float bmeTemp, float pressure) {
  SensorFrame& frame = frames[frameCursor];
  frame.seq = ++sequenceNo;
  frame.humidity = isnan(humidity) ? -1.0f : humidity;
  frame.dhtTemp = isnan(dhtTemp) ? -100.0f : dhtTemp;
  frame.bmeTemp = isnan(bmeTemp) ? -100.0f : bmeTemp;
  frame.pressure = isnan(pressure) ? 0.0f : pressure;
  frame.checksum = checksumFrame(frame);
  EEPROM.update(frameCursor, (uint8_t)(frame.checksum & 0xff));
  frameCursor = (uint8_t)((frameCursor + 1) % 16);
}

float rollingPressure() {
  float sum = 0.0f;
  uint8_t count = 0;
  for (uint8_t i = 0; i < 16; ++i) {
    if (frames[i].pressure > 0.0f) {
      sum += frames[i].pressure;
      ++count;
    }
  }
  return count == 0 ? 0.0f : sum / count;
}

void setup() {
  pinMode(13, OUTPUT);
  Wire.begin();
  SPI.begin();
  dht.begin();
  bme.begin(0x76);
  for (uint8_t i = 0; i < 16; ++i) {
    frames[i] = SensorFrame{0, 0, 0, 0, 0, 0};
  }
}

void loop() {
  float humidity = dht.readHumidity();
  float dhtTemp = dht.readTemperature();
  float bmeTemp = bme.readTemperature();
  float pressure = bme.readPressure() / 100.0f;
  recordFrame(humidity, dhtTemp, bmeTemp, pressure);
  digitalWrite(13, (((uint16_t)rollingPressure() ^ sequenceNo) & 1) ? HIGH : LOW);
}
"#
}

#[derive(Debug)]
struct CompileObservation {
    elapsed_ms: u128,
    fast_relink: bool,
    exact_hit: bool,
    timing_lines: Vec<String>,
}

#[cfg(target_os = "windows")]
fn hide_window(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000)
}

#[cfg(not(target_os = "windows"))]
fn hide_window(cmd: &mut Command) -> &mut Command {
    cmd
}

fn remove_file_if_exists(path: &Path) {
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
}

fn reset_nano_quickfast_state() {
    let root = std::env::temp_dir().join("CK_Builds");
    let safe = fqbn_cache_key("arduino:avr:nano");
    let _ = std::fs::remove_dir_all(root.join(format!("sketch_{safe}_qfast2")));
    let _ = std::fs::remove_dir_all(root.join(format!("sketch_{safe}_sfast2")));
    let _ = std::fs::remove_dir_all(root.join("dep_obj_cache").join(&safe));
    let metadata = root.join("metadata");
    remove_file_if_exists(&metadata.join(format!("meta_{safe}_qfast2.json")));
    remove_file_if_exists(&metadata.join(format!("backup_{safe}_qfast2.ino")));
    remove_file_if_exists(&metadata.join(format!("relink_props_{safe}_qfast2.json")));
    remove_file_if_exists(&metadata.join(format!("warmup_meta_{safe}_qfast2.json")));
    remove_file_if_exists(&metadata.join(format!("warmup_success_{safe}_qfast2")));
}

fn existing_libs(ck_root: &Path, rels: &[&str]) -> Vec<PathBuf> {
    rels.iter()
        .map(|rel| ck_root.join(rel))
        .filter(|path| path.exists())
        .collect()
}

fn arduino_cli_path(sysroot: &Sysroot) -> PathBuf {
    let cli_path = sysroot.get_bin_path().join("arduino-cli");
    let cli_exe = if cfg!(target_os = "windows") {
        cli_path.with_extension("exe")
    } else {
        cli_path
    };
    if cli_exe.exists() {
        cli_exe
    } else {
        PathBuf::from("arduino-cli")
    }
}

fn toolchain_bin_paths(sysroot: &Sysroot) -> Vec<PathBuf> {
    let mut bins = Vec::new();
    let packages_dir = sysroot.root_dir.join("packages");
    let Ok(vendors) = std::fs::read_dir(&packages_dir) else {
        return bins;
    };
    for vendor in vendors.flatten() {
        let tools_dir = vendor.path().join("tools");
        let Ok(tools) = std::fs::read_dir(&tools_dir) else {
            continue;
        };
        for tool in tools.flatten() {
            let Ok(versions) = std::fs::read_dir(tool.path()) else {
                continue;
            };
            for version in versions.flatten() {
                let bin = version.path().join("bin");
                if bin.is_dir() {
                    bins.push(bin);
                }
            }
        }
    }
    bins
}

fn run_standard_arduino_first_compile(
    sysroot: &Sysroot,
    code: &str,
    _libs: &[PathBuf],
) -> Result<u128> {
    let temp_root = std::env::temp_dir()
        .join("CK_Baseline_Builds")
        .join(format!("arduino_first_{}", std::process::id()));
    let sketch_dir = temp_root.join("first_compile_sensor_bus");
    let build_dir = temp_root.join("build");
    let sketch_path = sketch_dir.join("first_compile_sensor_bus.ino");

    let _ = std::fs::remove_dir_all(&temp_root);
    std::fs::create_dir_all(&sketch_dir).context("create Arduino baseline sketch dir")?;
    std::fs::create_dir_all(&build_dir).context("create Arduino baseline build dir")?;
    std::fs::write(&sketch_path, code).context("write Arduino baseline sketch")?;

    let mut cmd = Command::new(arduino_cli_path(sysroot));
    hide_window(&mut cmd);
    cmd.arg("--config-file")
        .arg(sysroot.root_dir.join("arduino-cli.yaml"))
        .arg("compile")
        .arg("-b")
        .arg("arduino:avr:nano")
        .arg("--build-path")
        .arg(&build_dir);
    let tool_bins = toolchain_bin_paths(sysroot);
    if !tool_bins.is_empty() {
        let ccache_path =
            std::env::join_paths(&tool_bins).context("join toolchain paths for CCACHE_PATH")?;
        let mut path_entries = tool_bins;
        path_entries.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        let path = std::env::join_paths(path_entries).context("join baseline PATH")?;
        cmd.env("CCACHE_PATH", ccache_path).env("PATH", path);
    }

    cmd.arg("--no-color")
        .arg(&sketch_dir)
        .env("CCACHE_DISABLE", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let start = std::time::Instant::now();
    let output = cmd.output().context("run Arduino baseline compile")?;
    let elapsed_ms = start.elapsed().as_millis();
    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "Arduino baseline failed after {elapsed_ms} ms:\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}"
        );
    }
    Ok(elapsed_ms)
}

async fn run_ck_first_compile(
    sysroot: &Arc<Sysroot>,
    code: &str,
    libs: &[PathBuf],
    signature: &str,
) -> Result<CompileObservation> {
    let captured = Arc::new(Mutex::new(String::new()));
    let captured_cb = captured.clone();
    let start = std::time::Instant::now();
    let result = compile_sketch_string(
        sysroot,
        code,
        "arduino:avr:nano",
        libs,
        8,
        signature,
        Some("verify-first-compile"),
        CompileProfile::QuickFast,
        ck_core::builder::demo::CkExactReusePolicy::Allow,
        |_pct, _msg| {},
        move |line| {
            if let Ok(mut guard) = captured_cb.lock() {
                guard.push_str(&line);
            }
        },
    )
    .await;
    let elapsed_ms = start.elapsed().as_millis();
    let log = captured.lock().map(|g| g.clone()).unwrap_or_default();
    match result {
        Ok((_path, result_log)) => {
            let combined = format!("{log}\n{result_log}");
            let timing_lines = combined
                .lines()
                .filter(|line| {
                    line.contains("[Timing")
                        || line.contains("Fast Relink")
                        || line.contains("Dependency cache")
                        || line.contains("Full Build")
                        || line.contains("Build completed")
                        || line.contains("ccache")
                        || line.contains("compiled ")
                        || line.contains("restored ")
                        || line.contains("error:")
                })
                .map(|line| line.to_string())
                .collect();
            Ok(CompileObservation {
                elapsed_ms,
                fast_relink: combined.contains("Fast Relink completed")
                    || combined.contains("Fast Relink path"),
                exact_hit: combined.contains("Cached build (Exact Match)")
                    || combined.contains("Code unchanged"),
                timing_lines,
            })
        }
        Err(err) => bail!("CK first compile failed after {elapsed_ms} ms:\n{log}\n{err}"),
    }
}

fn print_ck_observation(obs: &CompileObservation) {
    println!(
        "ck_first_ms={} fast_relink={} exact={}",
        obs.elapsed_ms, obs.fast_relink, obs.exact_hit
    );
    for line in &obs.timing_lines {
        println!("  {line}");
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let ck_root = dirs::document_dir()
        .context("Documents directory")?
        .join("CK");
    let sysroot = Arc::new(
        Sysroot::init(Some(ck_root.clone()), "CK")
            .await
            .context("sysroot init")?,
    );

    let libs = existing_libs(
        &ck_root,
        &[
            "sketchbook/libraries/DHT_sensor_library",
            "sketchbook/libraries/Adafruit_BME280_Library",
            "sketchbook/libraries/Adafruit_Unified_Sensor",
            "sketchbook/libraries/Adafruit_BusIO",
        ],
    );
    if libs.len() != 4 {
        bail!("Expected 4 sensor libraries, found {}", libs.len());
    }

    let code = first_compile_sensor_bus_project();
    let mut improvements = Vec::with_capacity(FIRST_COMPILE_SAMPLES);
    for sample in 1..=FIRST_COMPILE_SAMPLES {
        let arduino_ms = run_standard_arduino_first_compile(&sysroot, code, &libs)?;
        reset_nano_quickfast_state();
        let ck_obs = run_ck_first_compile(
            &sysroot,
            code,
            &libs,
            &format!("verify_first_compile_sensor_bus_v{sample}"),
        )
        .await?;
        print_ck_observation(&ck_obs);
        if ck_obs.fast_relink {
            bail!("First compile sample {sample} should not be reported as fast relink.");
        }
        if ck_obs.exact_hit {
            bail!("First compile sample {sample} incorrectly hit exact cache.");
        }
        let improvement = 1.0 - (ck_obs.elapsed_ms as f64 / arduino_ms as f64);
        println!(
            "first_compile_sample={sample} arduino_ms={arduino_ms} ck_ms={} improvement_pct={:.1}",
            ck_obs.elapsed_ms,
            improvement * 100.0
        );
        improvements.push(improvement);
    }
    improvements
        .sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let median_improvement = improvements[improvements.len() / 2];
    println!(
        "first_compile_median_improvement_pct={:.1}",
        median_improvement * 100.0
    );
    if median_improvement < MIN_FIRST_COMPILE_IMPROVEMENT {
        bail!(
            "First compile median improvement below target: {:.1}% < {:.1}%",
            median_improvement * 100.0,
            MIN_FIRST_COMPILE_IMPROVEMENT * 100.0
        );
    }
    Ok(())
}
