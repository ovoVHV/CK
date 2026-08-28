use ck_core::builder::demo::{CompileProfile, compile_sketch_string, fqbn_cache_key};
use ck_core::sysroot::Sysroot;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const BIG_SWITCH_BUDGET_MS: u128 = 2_500;

fn project_sensor_bus() -> &'static str {
    r#"
#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>
#include <EEPROM.h>
#include <DHT.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <CK_AVR_Blink_Test.h>

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
  ck_avr_pin_init(13);
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
  if (((uint16_t)rollingPressure() ^ sequenceNo) & 1) {
    ck_avr_blink_once(13, 2);
  }
}
"#
}

fn project_scheduler_json() -> &'static str {
    r#"
#include <Arduino.h>
#include <SoftwareSerial.h>
#include <MsTimer2.h>
#include <SimpleTimer.h>
#include <ArduinoJson.h>

SoftwareSerial telemetry(10, 11);
SimpleTimer emitTimer(250);
volatile uint16_t timerTicks = 0;

struct LaneState {
  uint8_t id;
  uint16_t pulses;
  uint16_t missed;
  uint32_t lastMicros;
};

LaneState lanes[8];
StaticJsonDocument<256> doc;

void timerPulse() {
  ++timerTicks;
  for (uint8_t i = 0; i < 8; ++i) {
    lanes[i].pulses += (uint16_t)(i + 1);
    lanes[i].lastMicros = micros();
    if ((timerTicks + i) % 7 == 0) {
      ++lanes[i].missed;
    }
  }
}

uint16_t weightedScore() {
  uint16_t score = timerTicks;
  for (uint8_t i = 0; i < 8; ++i) {
    score ^= (uint16_t)(lanes[i].pulses * (i + 3));
    score += (uint16_t)(lanes[i].missed << (i % 4));
  }
  return score;
}

void emitTelemetry() {
  doc.clear();
  doc["ticks"] = timerTicks;
  doc["score"] = weightedScore();
  JsonArray arr = doc.createNestedArray("lanes");
  for (uint8_t i = 0; i < 8; ++i) {
    JsonObject lane = arr.createNestedObject();
    lane["id"] = lanes[i].id;
    lane["p"] = lanes[i].pulses;
    lane["m"] = lanes[i].missed;
  }
  serializeJson(doc, telemetry);
  telemetry.println();
}

void setup() {
  telemetry.begin(9600);
  for (uint8_t i = 0; i < 8; ++i) {
    lanes[i] = LaneState{i, 0, 0, 0};
  }
  MsTimer2::set(10, timerPulse);
  MsTimer2::start();
  emitTimer.setInterval(250);
}

void loop() {
  if (emitTimer.isReady()) {
    emitTelemetry();
    emitTimer.reset();
  }
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

async fn run_compile(
    sysroot: &Arc<Sysroot>,
    code: &str,
    libs: &[PathBuf],
    signature: &str,
    label: &str,
) -> Result<CompileObservation, String> {
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
        Some(label),
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
                        || line.contains("dependency object")
                        || line.contains("compiled ")
                        || line.contains("restored ")
                        || line.contains("link failed")
                        || line.contains("undefined reference")
                        || line.contains("collect2")
                        || line.contains("No such file")
                        || line.contains("error:")
                        || line.contains("STDERR:")
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
        Err(err) => Err(format!(
            "{label} failed after {elapsed_ms} ms:\n{log}\n{err}"
        )),
    }
}

fn print_observation(label: &str, obs: &CompileObservation) {
    println!(
        "{}_ms={} fast_relink={} exact={}",
        label, obs.elapsed_ms, obs.fast_relink, obs.exact_hit
    );
    for line in &obs.timing_lines {
        println!("  {}", line);
    }
}

#[tokio::main]
async fn main() {
    let ck_root = dirs::document_dir()
        .expect("Documents directory")
        .join("CK");
    let sysroot = Arc::new(
        Sysroot::init(Some(ck_root.clone()), "CK")
            .await
            .expect("sysroot init"),
    );

    let sensor_libs = existing_libs(
        &ck_root,
        &[
            "libraries/arduino_avr_nano/ck_avr_blink_test",
            "sketchbook/libraries/DHT_sensor_library",
            "sketchbook/libraries/Adafruit_BME280_Library",
            "sketchbook/libraries/Adafruit_Unified_Sensor",
            "sketchbook/libraries/Adafruit_BusIO",
        ],
    );
    let scheduler_libs = existing_libs(
        &ck_root,
        &[
            "sketchbook/libraries/MsTimer2",
            "sketchbook/libraries/SimpleTimer",
            "sketchbook/libraries/ArduinoJson",
        ],
    );

    reset_nano_quickfast_state();

    let sensor_first = match run_compile(
        &sysroot,
        project_sensor_bus(),
        &sensor_libs,
        "verify_big_sensor_bus_v1",
        "sensor-first",
    )
    .await
    {
        Ok(obs) => obs,
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    };
    print_observation("sensor_first", &sensor_first);

    let scheduler_switch = match run_compile(
        &sysroot,
        project_scheduler_json(),
        &scheduler_libs,
        "verify_big_scheduler_json_v1",
        "scheduler-switch",
    )
    .await
    {
        Ok(obs) => obs,
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    };
    print_observation("scheduler_switch", &scheduler_switch);
    if scheduler_switch.exact_hit {
        eprintln!("Large project switch incorrectly hit exact cache.");
        std::process::exit(1);
    }
    if scheduler_switch.elapsed_ms > BIG_SWITCH_BUDGET_MS {
        eprintln!(
            "Large project switch exceeded budget: {} ms > {} ms",
            scheduler_switch.elapsed_ms, BIG_SWITCH_BUDGET_MS
        );
        std::process::exit(1);
    }

    let sensor_switch_back = match run_compile(
        &sysroot,
        project_sensor_bus(),
        &sensor_libs,
        "verify_big_sensor_bus_v1",
        "sensor-switch-back",
    )
    .await
    {
        Ok(obs) => obs,
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    };
    print_observation("sensor_switch_back", &sensor_switch_back);
    if sensor_switch_back.exact_hit {
        eprintln!("Switching back should rebuild/relink, not reuse the previous project blindly.");
        std::process::exit(1);
    }
    if sensor_switch_back.elapsed_ms > BIG_SWITCH_BUDGET_MS {
        eprintln!(
            "Large switch-back exceeded budget: {} ms > {} ms",
            sensor_switch_back.elapsed_ms, BIG_SWITCH_BUDGET_MS
        );
        std::process::exit(1);
    }

    let sensor_exact = match run_compile(
        &sysroot,
        project_sensor_bus(),
        &sensor_libs,
        "verify_big_sensor_bus_v1",
        "sensor-exact",
    )
    .await
    {
        Ok(obs) => obs,
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    };
    print_observation("sensor_exact", &sensor_exact);
    if !sensor_exact.exact_hit {
        eprintln!("Exact cache did not trigger after switching back to the same complex project.");
        std::process::exit(1);
    }
}
