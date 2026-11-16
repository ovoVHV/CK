use anyhow::{Context, Result};
use ck_core::builder::accel::CompileAccelSettings;
use ck_core::builder::demo::{
    CompileProfile, build_signature_for_code, canonical_prewarm_spec, compile_sketch_string,
    fqbn_cache_key, has_warm_build_cache, warmup_sketch_with_cancel,
};
use ck_core::sysroot::Sysroot;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

#[derive(Clone, Copy)]
struct VariantConfig {
    key: &'static str,
    use_spi: bool,
    use_extra_lib: bool,
    lane_count: usize,
    history_window: usize,
    diag_stride: usize,
    predictive_gain: u16,
    route_plan: &'static [u8],
    pulse_weights: &'static [u16],
}

#[derive(Clone, Copy)]
struct BoardTarget {
    fqbn: &'static str,
    label: &'static str,
}

#[derive(Debug, Serialize)]
struct ScenarioResult {
    key: String,
    label: String,
    elapsed_ms: u128,
    success: bool,
    exact_hit: bool,
    fast_relink: bool,
    metadata_present: bool,
    error: Option<String>,
    log_excerpt: Option<String>,
}

#[derive(Debug, Serialize)]
struct WarmupResult {
    elapsed_ms: u128,
    success: bool,
    metadata_present: bool,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct BoardBenchResult {
    fqbn: String,
    label: String,
    budget_ms: Option<u128>,
    cold_compile: ScenarioResult,
    startup_prewarm: WarmupResult,
    compile_after_startup_prewarm: ScenarioResult,
    warmup: WarmupResult,
    compile_after_warmup: ScenarioResult,
    logic_edit: ScenarioResult,
    topology_shift: ScenarioResult,
    rewrite_after_shift: ScenarioResult,
    upload_compile: ScenarioResult,
    cold_upload_compile: ScenarioResult,
    newlib_upload_compile: ScenarioResult,
}

#[derive(Debug, Serialize)]
struct BenchReport {
    generated_at_ms: u128,
    max_jobs: u32,
    boards: Vec<BoardBenchResult>,
}

fn bench_targets() -> Vec<BoardTarget> {
    vec![
        BoardTarget {
            fqbn: "arduino:avr:uno",
            label: "Arduino Uno",
        },
        BoardTarget {
            fqbn: "arduino:avr:nano",
            label: "Arduino Nano",
        },
        BoardTarget {
            fqbn: "arduino:avr:nano:cpu=atmega328old",
            label: "Arduino Nano (Old Bootloader)",
        },
        BoardTarget {
            fqbn: "arduino:avr:leonardo",
            label: "Arduino Leonardo",
        },
        BoardTarget {
            fqbn: "arduino:avr:mini",
            label: "Arduino Mini",
        },
        BoardTarget {
            fqbn: "arduino:avr:diecimila",
            label: "Arduino Diecimila",
        },
        BoardTarget {
            fqbn: "esp8266:esp8266:generic",
            label: "ESP8266 Generic",
        },
        BoardTarget {
            fqbn: "esp32:esp32:esp32",
            label: "ESP32 Dev Module",
        },
        BoardTarget {
            fqbn: "esp32:esp32:esp32c3",
            label: "ESP32-C3 Dev Module",
        },
        BoardTarget {
            fqbn: "esp32:esp32:esp32c5",
            label: "ESP32-C5 Dev Module",
        },
        BoardTarget {
            fqbn: "esp32:esp32:esp32c6",
            label: "ESP32-C6 Dev Module",
        },
        BoardTarget {
            fqbn: "esp32:esp32:esp32s3",
            label: "ESP32-S3 Dev Module",
        },
    ]
}

fn selected_targets() -> Vec<BoardTarget> {
    let args: Vec<String> = std::env::args().collect();
    let mut requested: HashSet<String> = HashSet::new();
    let mut idx = 1usize;
    while idx < args.len() {
        if args[idx] == "--boards" && idx + 1 < args.len() {
            for token in args[idx + 1].split(',') {
                let key = token.trim().to_ascii_lowercase();
                if !key.is_empty() {
                    requested.insert(key);
                }
            }
            idx += 1;
        }
        idx += 1;
    }

    let all = bench_targets();
    if requested.is_empty() {
        return all;
    }

    all.into_iter()
        .filter(|target| {
            let fqbn = target.fqbn.to_ascii_lowercase();
            let short = target
                .fqbn
                .rsplit(':')
                .next()
                .unwrap_or(target.fqbn)
                .to_ascii_lowercase();
            requested.contains(&fqbn)
                || requested.contains(&short)
                || requested.contains(&target.label.to_ascii_lowercase())
        })
        .collect()
}

fn variants() -> [VariantConfig; 4] {
    [
        // V1: Full-stack I2C+SPI bus mesh with rolling telemetry
        VariantConfig {
            key: "baseline_bus_mesh",
            use_spi: true,
            use_extra_lib: false,
            lane_count: 5,
            history_window: 12,
            diag_stride: 4,
            predictive_gain: 0,
            route_plan: &[0, 2, 4, 1, 3, 2, 4, 0],
            pulse_weights: &[3, 7, 11, 5, 13, 17, 19, 23],
        },
        // V2: Same topology, different logic (predictive gain + faster cadence)
        VariantConfig {
            key: "logic_edit_predictive",
            use_spi: true,
            use_extra_lib: false,
            lane_count: 6,
            history_window: 18,
            diag_stride: 3,
            predictive_gain: 17,
            route_plan: &[5, 1, 3, 0, 4, 2, 5, 0, 2, 4],
            pulse_weights: &[2, 11, 6, 15, 3, 19, 8, 10, 21, 5],
        },
        // V3: Topology shift - drop SPI, add more lanes, different geometry
        VariantConfig {
            key: "topology_shift_no_spi",
            use_spi: false,
            use_extra_lib: false,
            lane_count: 9,
            history_window: 16,
            diag_stride: 4,
            predictive_gain: 7,
            route_plan: &[8, 0, 5, 2, 7, 1, 6, 3, 4, 8, 2, 5],
            pulse_weights: &[4, 8, 6, 10, 12, 9, 15, 14, 18, 7, 20],
        },
        // V4: Full rewrite - max lanes, different cadence, new weights
        VariantConfig {
            key: "rewrite_after_shift",
            use_spi: false,
            use_extra_lib: false,
            lane_count: 10,
            history_window: 24,
            diag_stride: 5,
            predictive_gain: 13,
            route_plan: &[9, 3, 7, 1, 5, 0, 8, 2, 6, 4, 9, 5, 1, 7],
            pulse_weights: &[6, 5, 9, 14, 8, 13, 7, 11, 16, 3, 18, 12],
        },
    ]
}

/// V5: Same as V1 baseline but adds a never-before-seen library (Servo/Ticker).
fn newlib_variant() -> VariantConfig {
    VariantConfig {
        key: "newlib_add",
        use_spi: true,
        use_extra_lib: true,
        lane_count: 5,
        history_window: 12,
        diag_stride: 4,
        predictive_gain: 0,
        route_plan: &[0, 2, 4, 1, 3, 2, 4, 0],
        pulse_weights: &[3, 7, 11, 5, 13, 17, 19, 23],
    }
}

fn sanitize_fqbn_for_path(fqbn: &str) -> String {
    fqbn_cache_key(fqbn)
}

fn board_budget_ms(fqbn: &str) -> Option<u128> {
    if fqbn.starts_with("arduino:avr:") {
        Some(3_000)
    } else if fqbn.starts_with("esp32:") {
        Some(20_000)
    } else if fqbn.starts_with("esp8266:") {
        Some(20_000)
    } else {
        None
    }
}

fn cache_root() -> PathBuf {
    std::env::temp_dir().join("CK_Builds")
}

fn prebuilt_root() -> Option<PathBuf> {
    dirs::document_dir().map(|dir| dir.join("prebuilt_cores"))
}

fn metadata_root() -> PathBuf {
    cache_root().join("metadata")
}

fn qfast_meta_paths(fqbn: &str) -> Vec<PathBuf> {
    let fqbn_safe = sanitize_fqbn_for_path(fqbn);
    vec![
        metadata_root().join(format!("meta_{}_qfast2.json", fqbn_safe)),
        metadata_root().join(format!("backup_{}_qfast2.ino", fqbn_safe)),
        metadata_root().join(format!("warmup_meta_{}_qfast2.json", fqbn_safe)),
        metadata_root().join(format!("warmup_success_{}_qfast2", fqbn_safe)),
        metadata_root().join(format!("relink_props_{}_qfast2.json", fqbn_safe)),
    ]
}

fn qfast_project_paths(fqbn: &str) -> Vec<PathBuf> {
    let fqbn_safe = sanitize_fqbn_for_path(fqbn);
    vec![
        cache_root().join(format!("sketch_{}_qfast2", fqbn_safe)),
        cache_root().join(format!("sketch_{}_sfast2", fqbn_safe)),
        cache_root().join(format!("sketch_{}_rel", fqbn_safe)),
        cache_root().join("dep_obj_cache").join(fqbn_safe),
    ]
}

fn prebuilt_profile_paths(fqbn: &str) -> Vec<PathBuf> {
    let Some(root) = prebuilt_root() else {
        return Vec::new();
    };
    let fqbn_safe = sanitize_fqbn_for_path(fqbn);
    vec![
        root.join(format!("sketch_{}_qfast2", fqbn_safe)),
        root.join(format!("sketch_{}_sfast2", fqbn_safe)),
        root.join(format!("sketch_{}_rel", fqbn_safe)),
    ]
}

fn reset_board_cache(fqbn: &str) {
    for path in qfast_project_paths(fqbn) {
        if path.exists() {
            let _ = fs::remove_dir_all(&path);
        }
    }
    for path in qfast_meta_paths(fqbn) {
        if path.is_dir() {
            let _ = fs::remove_dir_all(&path);
        } else {
            let _ = fs::remove_file(&path);
        }
    }
}

fn reset_board_snapshots(fqbn: &str) {
    for path in prebuilt_profile_paths(fqbn) {
        if path.exists() {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

fn reset_board_state(fqbn: &str) {
    reset_board_cache(fqbn);
    reset_board_snapshots(fqbn);
}

fn bench_full_log_enabled() -> bool {
    matches!(
        std::env::var("CK_BENCH_FULL_LOG"),
        Ok(value) if value == "1" || value.eq_ignore_ascii_case("true")
    )
}

fn qfast_metadata_present(fqbn: &str) -> bool {
    let paths = qfast_meta_paths(fqbn);
    paths[0].exists() && paths[1].exists()
}

fn last_lines(text: &str, count: usize) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let start = lines.len().saturating_sub(count);
    lines[start..].join("\n")
}

fn compose_csv_u8(values: &[u8]) -> String {
    values
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

fn compose_csv_u16(values: &[u16]) -> String {
    values
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

fn board_uses_wifi(fqbn: &str) -> bool {
    fqbn.starts_with("esp32:")
}

fn render_sketch(fqbn: &str, config: VariantConfig) -> String {
    let use_wifi = board_uses_wifi(fqbn);
    let mut sketch = String::from(
        r#"#include <Arduino.h>
#include <Wire.h>
#include <EEPROM.h>
@@SPI_INCLUDE@@
@@WIFI_INCLUDE@@
@@EXTRA_LIB_INCLUDE@@

#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

template <size_t N>
struct RollingWindow {
  uint16_t values[N];
  size_t cursor;
  size_t used;
  uint32_t total;

  RollingWindow() : values{0}, cursor(0), used(0), total(0) {}

  void push(uint16_t value) {
    if (used < N) {
      values[used++] = value;
      total += value;
      cursor = used % N;
      return;
    }
    total -= values[cursor];
    values[cursor] = value;
    total += value;
    cursor = (cursor + 1) % N;
  }

  uint16_t average() const {
    return used == 0 ? 0 : static_cast<uint16_t>(total / used);
  }
};

template <size_t N>
struct MedianFilter {
    uint16_t values[N];
    size_t cursor;
    size_t used;

    MedianFilter() : values{0}, cursor(0), used(0) {}

    void push(uint16_t value) {
        values[cursor] = value;
        cursor = (cursor + 1) % N;
        if (used < N) {
            ++used;
        }
    }

    uint16_t median() const {
        if (used == 0) {
            return 0;
        }
        uint16_t scratch[N];
        for (size_t i = 0; i < used; ++i) {
            scratch[i] = values[i];
        }
        for (size_t i = 1; i < used; ++i) {
            uint16_t key = scratch[i];
            size_t j = i;
            while (j > 0 && scratch[j - 1] > key) {
                scratch[j] = scratch[j - 1];
                --j;
            }
            scratch[j] = key;
        }
        return scratch[used / 2];
    }
};

template <size_t N>
struct FirFilter {
    int16_t coeffs[N];
    uint16_t samples[N];
    size_t cursor;

    FirFilter() : coeffs{0}, samples{0}, cursor(0) {}

    void configure(const int16_t *src) {
        for (size_t i = 0; i < N; ++i) {
            coeffs[i] = src[i];
            samples[i] = 0;
        }
        cursor = 0;
    }

    uint16_t push(uint16_t sample) {
        samples[cursor] = sample;
        cursor = (cursor + 1) % N;
        int32_t acc = 0;
        for (size_t i = 0; i < N; ++i) {
            size_t idx = (cursor + N - 1 - i) % N;
            acc += static_cast<int32_t>(samples[idx]) * coeffs[i];
        }
        if (acc < 0) {
            acc = 0;
        }
        return static_cast<uint16_t>(acc / 16);
    }
};

template <size_t N>
struct PhaseAccumulator {
    uint16_t bins[N];
    size_t cursor;

    PhaseAccumulator() : bins{0}, cursor(0) {}

    uint16_t step(uint16_t sample, uint8_t phase) {
        bins[cursor] = static_cast<uint16_t>((sample ^ (phase * 53u)) & 0x03FFu);
        cursor = (cursor + 1) % N;
        uint32_t sum = 0;
        for (size_t i = 0; i < N; ++i) {
            sum += bins[i];
        }
        return static_cast<uint16_t>(sum % 4096u);
    }
};

struct LaneState {
  uint16_t raw;
    uint16_t bus;
  uint16_t blended;
  uint16_t envelope;
    uint16_t adaptive;
    uint16_t energy;
    uint16_t phase;
    int16_t integral;
  uint8_t drift;
  uint8_t heat;
    uint8_t state;
};

struct TelemetryFrame {
  uint16_t busHash;
  uint16_t energy;
  uint16_t envelope;
    uint16_t spectral;
    uint16_t checksum;
  uint8_t mode;
  uint8_t activeLane;
  uint32_t stamp;
};

struct PersistentProfile {
  uint8_t mode;
  uint8_t gain;
  uint8_t gate;
    uint8_t bias;
};

class ProfileStore {
public:
  void load(PersistentProfile &profile) {
    profile.mode = EEPROM.read(0);
    profile.gain = EEPROM.read(1);
    profile.gate = EEPROM.read(2);
        profile.bias = EEPROM.read(3);
        if (profile.gain == 0 || profile.gain == 0xFF) {
      profile.mode = 1;
      profile.gain = 6;
      profile.gate = 18;
            profile.bias = 9;
    }
  }

  void save(const PersistentProfile &profile) {
#if defined(ESP32) || defined(ESP8266)
    EEPROM.write(0, profile.mode);
    EEPROM.write(1, profile.gain);
    EEPROM.write(2, profile.gate);
        EEPROM.write(3, profile.bias);
    EEPROM.commit();
#else
    EEPROM.update(0, profile.mode);
    EEPROM.update(1, profile.gain);
    EEPROM.update(2, profile.gate);
        EEPROM.update(3, profile.bias);
#endif
  }
};

class CommandRouter {
public:
    CommandRouter() : lastMode(1), lastGain(6), lastBias(9), pending(false) {}

  void feed(char c) {
        if (c >= '1' && c <= '6') {
      lastMode = static_cast<uint8_t>(c - '0');
      pending = true;
    } else if (c == '+') {
      if (lastGain < 24) {
        lastGain++;
      }
      pending = true;
    } else if (c == '-') {
      if (lastGain > 2) {
        lastGain--;
      }
      pending = true;
        } else if (c == '>') {
            if (lastBias < 30) {
                ++lastBias;
            }
            pending = true;
        } else if (c == '<') {
            if (lastBias > 1) {
                --lastBias;
            }
            pending = true;
    }
  }

  bool consume(PersistentProfile &profile) {
    if (!pending) {
      return false;
    }
    pending = false;
    profile.mode = lastMode;
    profile.gain = lastGain;
    profile.gate = static_cast<uint8_t>(12 + (lastMode * 3));
        profile.bias = lastBias;
    return true;
  }

private:
  uint8_t lastMode;
  uint8_t lastGain;
    uint8_t lastBias;
  bool pending;
};

class LaneController {
public:
    LaneController() : kp(3), ki(1), kd(1), prevError(0), integral(0) {}

    void retune(uint8_t baseGain, uint8_t bias) {
        kp = static_cast<int16_t>(2 + baseGain);
        ki = static_cast<int16_t>(1 + (bias % 4u));
        kd = static_cast<int16_t>(1 + (baseGain % 5u));
    }

    uint16_t step(uint16_t target, uint16_t current, uint8_t gate) {
        int16_t error = static_cast<int16_t>(target) - static_cast<int16_t>(current);
        integral += error;
        if (integral > 2048) {
            integral = 2048;
        }
        if (integral < -2048) {
            integral = -2048;
        }
        int16_t delta = error - prevError;
        prevError = error;
        int32_t out = static_cast<int32_t>(current)
            + (static_cast<int32_t>(kp) * error) / 8
            + (static_cast<int32_t>(ki) * integral) / 32
            + (static_cast<int32_t>(kd) * delta) / 16
            + gate;
        if (out < 0) {
            out = 0;
        }
        if (out > 65535) {
            out = 65535;
        }
        return static_cast<uint16_t>(out);
    }

private:
    int16_t kp;
    int16_t ki;
    int16_t kd;
    int16_t prevError;
    int16_t integral;
};

static const uint8_t kLaneCount = @@LANE_COUNT@@;
static const uint8_t kHistoryWindow = @@HISTORY_WINDOW@@;
static const uint8_t kDiagStride = @@DIAG_STRIDE@@;
static const uint16_t kPredictiveGain = @@PREDICTIVE_GAIN@@;
static const uint8_t kRoutePlan[] = { @@ROUTE_PLAN@@ };
static const uint16_t kPulseWeights[] = { @@PULSE_WEIGHTS@@ };
static const int16_t kFirKernel[5] = { 1, 3, 8, 3, 1 };

static LaneState g_lanes[@@LANE_COUNT@@];
static PersistentProfile g_profile;
static ProfileStore g_store;
static CommandRouter g_router;
static RollingWindow<@@HISTORY_WINDOW@@> g_energyWindow;
static RollingWindow<8> g_gradientWindow;
static MedianFilter<5> g_laneMedian[@@LANE_COUNT@@];
static FirFilter<5> g_laneFir[@@LANE_COUNT@@];
static PhaseAccumulator<6> g_phase[@@LANE_COUNT@@];
static LaneController g_controller[@@LANE_COUNT@@];
static uint32_t g_cycle = 0;
static uint32_t g_lastCommit = 0;
static uint32_t g_lastBlink = 0;
static uint8_t g_ledState = LOW;
@@EXTRA_LIB_GLOBALS@@

static uint16_t clamp_u16(int32_t value) {
  if (value < 0) {
    return 0;
  }
  if (value > 65535) {
    return 65535;
  }
  return static_cast<uint16_t>(value);
}

static uint16_t blend_sample(uint16_t current, uint16_t target, uint8_t gain) {
  int32_t delta = static_cast<int32_t>(target) - static_cast<int32_t>(current);
  return clamp_u16(static_cast<int32_t>(current) + (delta / (gain == 0 ? 1 : gain)));
}

static uint16_t mix16(uint16_t a, uint16_t b, uint8_t shift) {
    return static_cast<uint16_t>(((a << (shift & 3u)) ^ (b >> ((shift + 1u) & 3u))) & 0xFFFFu);
}

static uint16_t crc16_step(uint16_t crc, uint8_t data) {
    crc ^= static_cast<uint16_t>(data);
    for (uint8_t i = 0; i < 8; ++i) {
        if (crc & 1u) {
            crc = static_cast<uint16_t>((crc >> 1) ^ 0xA001u);
        } else {
            crc >>= 1;
        }
    }
    return crc;
}

static uint16_t crc16_block(const uint8_t *data, size_t len) {
    uint16_t crc = 0xFFFFu;
    for (size_t i = 0; i < len; ++i) {
        crc = crc16_step(crc, data[i]);
    }
    return crc;
}

static uint16_t synthetic_sample(uint8_t lane, uint32_t tick) {
  uint32_t laneMix = (lane + 3u) * 37u;
  uint32_t weight = kPulseWeights[lane % (sizeof(kPulseWeights) / sizeof(kPulseWeights[0]))];
    uint32_t folded = (tick / (9u + lane)) + laneMix + (weight * (lane + 1u));
    uint32_t phase = ((tick << (lane % 3u)) ^ (weight * 17u) ^ (laneMix * 9u));
    uint32_t base = (folded * (13u + lane)) ^ (weight * 29u) ^ phase;
  return static_cast<uint16_t>(120u + (base % 900u));
}

static uint16_t predictive_bias(uint16_t raw, uint16_t blended, uint8_t lane) {
  int16_t slope = static_cast<int16_t>(raw) - static_cast<int16_t>(blended);
  int16_t bias = static_cast<int16_t>((slope * static_cast<int16_t>(kPredictiveGain + lane + 1u)) / 16);
  return clamp_u16(static_cast<int32_t>(blended) + bias);
}

static uint16_t topology_probe(uint8_t lane, uint32_t tick) {
    uint16_t acc = 0;
    for (uint8_t i = 0; i < kLaneCount; ++i) {
        uint8_t routed = static_cast<uint8_t>(kRoutePlan[(tick + i) % (sizeof(kRoutePlan) / sizeof(kRoutePlan[0]))] % kLaneCount);
        acc ^= static_cast<uint16_t>((routed + 1u) * (lane + i + 3u) * 11u);
    }
    return static_cast<uint16_t>(acc & 0x03FFu);
}

static uint16_t bus_probe(uint8_t lane, uint32_t tick) {
  Wire.beginTransmission(static_cast<uint8_t>(0x20u + (lane % 4u)));
  Wire.write(static_cast<uint8_t>(0x10u + lane));
    Wire.write(static_cast<uint8_t>((tick >> (lane & 3u)) & 0xFFu));
  Wire.endTransmission();
#if @@USE_SPI@@
  SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));
  uint8_t spiByte = SPI.transfer(static_cast<uint8_t>((tick >> (lane % 5u)) & 0xFFu));
    uint8_t spiEcho = SPI.transfer(static_cast<uint8_t>((tick + lane * 17u) & 0xFFu));
  SPI.endTransaction();
    return static_cast<uint16_t>((spiByte << 3) ^ (spiEcho << 1) ^ (lane * 17u));
#else
  return static_cast<uint16_t>((lane + 1u) * 19u);
#endif
}

static uint16_t wifi_probe(uint32_t tick) {
#if @@USE_WIFI@@
  uint16_t mode = static_cast<uint16_t>(WiFi.getMode());
  uint16_t status = static_cast<uint16_t>(WiFi.status());
  uint16_t channel = static_cast<uint16_t>(WiFi.channel() & 0x3Fu);
  return static_cast<uint16_t>((mode << 11) ^ (channel << 5) ^ status ^ (tick & 0x1Fu));
#else
  return static_cast<uint16_t>((tick >> 1) & 0x3Fu);
#endif
}

static void update_lane(LaneState &lane, uint8_t laneIndex, uint32_t tick) {
    uint16_t raw = synthetic_sample(laneIndex, tick);
    uint16_t bus = bus_probe(laneIndex, tick);
    uint16_t topo = topology_probe(laneIndex, tick);
    g_laneMedian[laneIndex].push(static_cast<uint16_t>(raw + (bus % 47u) + (topo % 29u)));
    uint16_t median = g_laneMedian[laneIndex].median();
    uint16_t filtered = g_laneFir[laneIndex].push(static_cast<uint16_t>(median + (topo >> 2u)));
    uint16_t target = predictive_bias(filtered, lane.blended, laneIndex);
    lane.raw = raw;
    lane.bus = bus;
    lane.blended = blend_sample(lane.blended, filtered, g_profile.gain);
    lane.envelope = g_controller[laneIndex].step(target, lane.blended, g_profile.gate);
    lane.adaptive = mix16(lane.envelope, topo, laneIndex);
    lane.energy = static_cast<uint16_t>((lane.adaptive + lane.envelope + lane.bus) / 3u);
    lane.phase = g_phase[laneIndex].step(lane.energy, static_cast<uint8_t>((tick + laneIndex) & 0x0Fu));
    lane.integral = static_cast<int16_t>((static_cast<int32_t>(lane.integral) + static_cast<int32_t>(lane.envelope) - static_cast<int32_t>(lane.blended)) / 2);
    lane.drift = static_cast<uint8_t>((lane.phase / 13u) & 0x1Fu);
    lane.heat = static_cast<uint8_t>((lane.energy + laneIndex + g_profile.mode + g_profile.bias) % 31u);
    lane.state = static_cast<uint8_t>((lane.heat + lane.drift + laneIndex) % 7u);
}

static uint16_t compute_energy() {
  uint32_t sum = 0;
  for (uint8_t i = 0; i < kLaneCount; ++i) {
        sum += g_lanes[i].energy;
  }
  g_energyWindow.push(static_cast<uint16_t>(sum / kLaneCount));
  return g_energyWindow.average();
}

static uint16_t compute_spectral() {
    uint32_t spread = 0;
    for (uint8_t i = 0; i < kLaneCount; ++i) {
        spread += static_cast<uint32_t>(g_lanes[i].phase ^ g_lanes[i].adaptive);
    }
    g_gradientWindow.push(static_cast<uint16_t>((spread / kLaneCount) & 0xFFFFu));
    return g_gradientWindow.average();
}

static TelemetryFrame build_frame(uint32_t tick) {
  TelemetryFrame frame;
  frame.energy = compute_energy();
    frame.envelope = g_lanes[tick % kLaneCount].envelope;
    frame.spectral = compute_spectral();
  frame.busHash = wifi_probe(tick);
  for (uint8_t i = 0; i < kLaneCount; ++i) {
        frame.busHash ^= static_cast<uint16_t>((g_lanes[i].raw << (i % 3u)) | g_lanes[i].drift);
        frame.busHash ^= static_cast<uint16_t>(g_lanes[i].bus >> (i % 4u));
  }
  frame.mode = g_profile.mode;
  frame.activeLane = static_cast<uint8_t>(kRoutePlan[tick % (sizeof(kRoutePlan) / sizeof(kRoutePlan[0]))] % kLaneCount);
  frame.stamp = tick;
    uint8_t payload[8];
    payload[0] = static_cast<uint8_t>(frame.busHash & 0xFFu);
    payload[1] = static_cast<uint8_t>(frame.busHash >> 8);
    payload[2] = static_cast<uint8_t>(frame.energy & 0xFFu);
    payload[3] = static_cast<uint8_t>(frame.energy >> 8);
    payload[4] = static_cast<uint8_t>(frame.envelope & 0xFFu);
    payload[5] = static_cast<uint8_t>(frame.envelope >> 8);
    payload[6] = static_cast<uint8_t>(frame.spectral & 0xFFu);
    payload[7] = static_cast<uint8_t>(frame.spectral >> 8);
    frame.checksum = crc16_block(payload, sizeof(payload));
  return frame;
}

static String render_frame(const TelemetryFrame &frame) {
  String out;
    out.reserve(144);
  out += F("m=");
  out += String(frame.mode);
  out += F(",lane=");
  out += String(frame.activeLane);
  out += F(",bus=");
  out += String(frame.busHash);
  out += F(",eng=");
  out += String(frame.energy);
  out += F(",env=");
  out += String(frame.envelope);
    out += F(",spec=");
    out += String(frame.spectral);
    out += F(",crc=");
    out += String(frame.checksum);
  out += F(",tick=");
  out += String(frame.stamp);
  @@FRAME_APPEND@@
  return out;
}

static void maybe_apply_synthetic_command(uint32_t tick) {
    static const char kScript[] = {'1', '+', '+', '3', '-', '4', '>', '+', '2', '<', '5', '+'};
  if ((tick % kDiagStride) == 0) {
    g_router.feed(kScript[(tick / kDiagStride) % (sizeof(kScript) / sizeof(kScript[0]))]);
  }
  if (g_router.consume(g_profile)) {
        for (uint8_t i = 0; i < kLaneCount; ++i) {
            g_controller[i].retune(g_profile.gain + i, g_profile.bias + i);
        }
    g_store.save(g_profile);
  }
}

static uint8_t compute_blink_period(uint16_t energy, uint8_t mode) {
  uint16_t folded = static_cast<uint16_t>((energy / (mode + 1u)) % 220u);
  return static_cast<uint8_t>(40u + folded);
}

static void run_diagnostics(const TelemetryFrame &frame) {
  if ((frame.stamp % (kDiagStride * 4u)) == 0) {
        volatile uint16_t checksum = 0;
    for (uint8_t i = 0; i < kLaneCount; ++i) {
            checksum ^= static_cast<uint16_t>(g_lanes[i].raw + (g_lanes[i].heat << (i % 3u)));
            checksum ^= static_cast<uint16_t>(g_lanes[i].phase + (g_lanes[i].state << 4u));
        }
        uint16_t corr[4][4];
        for (uint8_t r = 0; r < 4u; ++r) {
            for (uint8_t c = 0; c < 4u; ++c) {
                uint8_t li = static_cast<uint8_t>(r % kLaneCount);
                uint8_t lj = static_cast<uint8_t>((c + frame.activeLane) % kLaneCount);
                corr[r][c] = static_cast<uint16_t>((g_lanes[li].energy ^ g_lanes[lj].adaptive) + (r * 17u) + c);
                checksum ^= corr[r][c];
            }
    }
    (void)checksum;
  }
}

static void rebalance_mesh(uint32_t tick) {
    for (uint8_t i = 0; i < kLaneCount; ++i) {
        uint8_t next = static_cast<uint8_t>((i + 1u) % kLaneCount);
        uint8_t prev = static_cast<uint8_t>((i + kLaneCount - 1u) % kLaneCount);
        uint16_t neighbour = static_cast<uint16_t>((g_lanes[next].energy + g_lanes[prev].energy) / 2u);
        g_lanes[i].adaptive = blend_sample(g_lanes[i].adaptive, neighbour, static_cast<uint8_t>(2u + ((tick + i) % 5u)));
    }
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
#if defined(ESP32) || defined(ESP8266)
    EEPROM.begin(64);
#endif
#if @@USE_WIFI@@
  WiFi.mode(WIFI_MODE_NULL);
#endif
  Wire.begin();
#if @@USE_SPI@@
  SPI.begin();
#endif
  @@EXTRA_LIB_SETUP@@
  g_store.load(g_profile);
  for (uint8_t i = 0; i < kLaneCount; ++i) {
        g_controller[i].retune(g_profile.gain + i, g_profile.bias + i);
        g_laneFir[i].configure(kFirKernel);
        g_lanes[i].raw = static_cast<uint16_t>(100 + (i * 11));
        g_lanes[i].bus = 0;
    g_lanes[i].blended = g_lanes[i].raw;
    g_lanes[i].envelope = g_lanes[i].raw;
        g_lanes[i].adaptive = g_lanes[i].raw;
        g_lanes[i].energy = g_lanes[i].raw;
        g_lanes[i].phase = 0;
        g_lanes[i].integral = 0;
    g_lanes[i].drift = 0;
    g_lanes[i].heat = 0;
        g_lanes[i].state = 0;
  }
}

void loop() {
  ++g_cycle;
  maybe_apply_synthetic_command(g_cycle);
  for (uint8_t i = 0; i < kLaneCount; ++i) {
    update_lane(g_lanes[i], i, g_cycle + (i * 3u));
  }
    rebalance_mesh(g_cycle);
  TelemetryFrame frame = build_frame(g_cycle);
  @@VARIANT_BLOCK@@
  run_diagnostics(frame);

  uint32_t now = millis();
  uint8_t period = compute_blink_period(frame.energy, frame.mode);
  if ((now - g_lastBlink) >= period) {
    g_lastBlink = now;
    g_ledState = static_cast<uint8_t>(g_ledState == LOW ? HIGH : LOW);
    digitalWrite(LED_BUILTIN, g_ledState);
  }

  if ((g_cycle % (kDiagStride * 3u)) == 0) {
    String line = render_frame(frame);
    if (line.length() > 0 && Serial) {
      Serial.println(line);
    }
  }

  if ((g_cycle - g_lastCommit) > 32u) {
    g_lastCommit = g_cycle;
    g_store.save(g_profile);
  }
}
"#,
    );

    let variant_block = match config.key {
        "baseline_bus_mesh" => String::from(
            r#"  // V1: Passive bus mesh with staged checksum folding.
    if ((frame.stamp % 5u) == 0) {
        uint8_t lane = frame.activeLane % kLaneCount;
        g_lanes[lane].blended = blend_sample(g_lanes[lane].blended, frame.envelope, g_profile.mode + 2u);
        g_lanes[lane].adaptive = mix16(g_lanes[lane].adaptive, frame.checksum, lane);
    }
    for (uint8_t c = 1; c < kLaneCount; ++c) {
        int16_t prev_drift = static_cast<int16_t>(g_lanes[c - 1].drift);
        g_lanes[c].heat = static_cast<uint8_t>((g_lanes[c].heat + prev_drift + g_lanes[c - 1].state) % 31u);
        g_lanes[c].phase = static_cast<uint16_t>((g_lanes[c].phase + g_lanes[c - 1].adaptive) & 0x0FFFu);
    }"#,
        ),
        "logic_edit_predictive" => String::from(
            r#"  // V2: Predictive controller with mirrored damping and bias injection.
    if ((frame.stamp % 3u) == 0) {
        uint8_t lane = frame.activeLane % kLaneCount;
        int32_t boost = static_cast<int32_t>(kPredictiveGain + g_profile.bias) * static_cast<int32_t>(lane + 1u);
        g_lanes[lane].envelope = clamp_u16(static_cast<int32_t>(g_lanes[lane].envelope) + boost);
        g_lanes[lane].adaptive = clamp_u16(static_cast<int32_t>(g_lanes[lane].adaptive) + boost / 2);
    } else {
        uint8_t lane = static_cast<uint8_t>((frame.activeLane + 1u) % kLaneCount);
        g_lanes[lane].blended = blend_sample(g_lanes[lane].blended, frame.energy + frame.spectral, g_profile.mode + 1u);
    }
    {
        uint8_t opposing = static_cast<uint8_t>((kLaneCount - 1u) - (frame.activeLane % kLaneCount));
        if (g_lanes[opposing].envelope > 50u) {
            g_lanes[opposing].envelope -= static_cast<uint16_t>((kPredictiveGain / 2u) + 1u);
            g_lanes[opposing].phase = static_cast<uint16_t>((g_lanes[opposing].phase ^ frame.checksum) & 0x0FFFu);
        }
    }"#,
        ),
        "topology_shift_no_spi" => String::from(
            r#"  // V3: Ring topology with non-SPI redistribution and saturation fencing.
    for (uint8_t r = 0; r < kLaneCount; ++r) {
        uint8_t next = static_cast<uint8_t>((r + 1u) % kLaneCount);
        uint16_t cross = static_cast<uint16_t>((g_lanes[r].raw >> 2u) + g_lanes[next].blended + g_lanes[r].phase);
        g_lanes[next].heat = static_cast<uint8_t>((cross + g_lanes[r].drift + g_lanes[next].state) % 19u);
        g_lanes[next].adaptive = blend_sample(g_lanes[next].adaptive, cross, 3u + (r % 4u));
    }
    for (uint8_t s = 0; s < kLaneCount; ++s) {
        uint16_t gate_limit = static_cast<uint16_t>(g_profile.gate * 32u);
        if (g_lanes[s].envelope > gate_limit && gate_limit > 0u) {
            g_lanes[s].envelope = gate_limit;
            g_lanes[s].drift = 0;
            g_lanes[s].phase = static_cast<uint16_t>(g_lanes[s].phase >> 1u);
        }
    }"#,
        ),
        _ => String::from(
            r#"  // V4: Three-stage rewrite pipeline with energy shuffling and phase repair.
    for (uint8_t p = 0; p + 1u < kLaneCount; p += 2u) {
        uint16_t avg = static_cast<uint16_t>((g_lanes[p].envelope + g_lanes[p + 1u].envelope + g_lanes[p].adaptive) / 3u);
        g_lanes[p].blended = blend_sample(g_lanes[p].blended, avg, g_profile.gain);
        g_lanes[p + 1u].blended = blend_sample(g_lanes[p + 1u].blended, avg, g_profile.gain);
    }
    {
        uint8_t hottest = 0, coldest = 0;
        for (uint8_t q = 1; q < kLaneCount; ++q) {
            if (g_lanes[q].envelope > g_lanes[hottest].envelope) hottest = q;
            if (g_lanes[q].envelope < g_lanes[coldest].envelope) coldest = q;
        }
        if (hottest != coldest && g_lanes[hottest].envelope > g_lanes[coldest].envelope + 20u) {
            uint16_t transfer = static_cast<uint16_t>(kPredictiveGain + g_profile.bias + 1u);
            g_lanes[hottest].envelope = clamp_u16(static_cast<int32_t>(g_lanes[hottest].envelope) - transfer);
            g_lanes[coldest].envelope = clamp_u16(static_cast<int32_t>(g_lanes[coldest].envelope) + transfer);
            g_lanes[coldest].adaptive = clamp_u16(static_cast<int32_t>(g_lanes[coldest].adaptive) + (transfer / 2u));
        }
    }
    for (uint8_t d = 0; d < kLaneCount; ++d) {
        int16_t err = static_cast<int16_t>(g_lanes[d].raw) - static_cast<int16_t>(g_lanes[d].blended);
        g_lanes[d].drift = static_cast<uint8_t>((static_cast<int16_t>(g_lanes[d].drift) + (err / 8)) & 0x1Fu);
        g_lanes[d].phase = static_cast<uint16_t>((g_lanes[d].phase + g_lanes[d].adaptive + frame.spectral) & 0x0FFFu);
    }"#,
        ),
    };

    let frame_append = match config.key {
        "baseline_bus_mesh" => String::from(
            r#"  out += F(",mesh=");
    out += String(static_cast<uint16_t>(frame.busHash ^ frame.energy));
    out += F(",crc2=");
    out += String(static_cast<uint16_t>(frame.checksum ^ frame.spectral));"#,
        ),
        "logic_edit_predictive" => String::from(
            r#"  out += F(",mesh=");
  out += String(static_cast<uint16_t>(frame.busHash ^ frame.energy));
  out += F(",pred=");
    out += String(kPredictiveGain);
    out += F(",bias=");
    out += String(g_profile.bias);"#,
        ),
        "topology_shift_no_spi" => String::from(
            r#"  out += F(",ring=");
    out += String(static_cast<uint16_t>(frame.busHash + frame.envelope + frame.spectral));
  out += F(",gate=");
  out += String(g_profile.gate);"#,
        ),
        _ => String::from(
            r#"  out += F(",pipe=");
    out += String(static_cast<uint16_t>((frame.busHash >> 3) ^ frame.envelope ^ frame.spectral));
  out += F(",gate=");
  out += String(g_profile.gate);
  out += F(",drift=");
  { uint16_t dsum = 0; for (uint8_t dd = 0; dd < kLaneCount && dd < 8; ++dd) dsum += g_lanes[dd].drift; out += String(dsum); }"#,
        ),
    };

    sketch = sketch.replace(
        "@@SPI_INCLUDE@@",
        if config.use_spi {
            "#include <SPI.h>"
        } else {
            ""
        },
    );
    sketch = sketch.replace(
        "@@WIFI_INCLUDE@@",
        if use_wifi { "#include <WiFi.h>" } else { "" },
    );

    // Extra library: SoftwareSerial for AVR, Ticker for ESP
    let is_avr = fqbn.starts_with("arduino:avr:");
    if config.use_extra_lib {
        if is_avr {
            sketch = sketch.replace("@@EXTRA_LIB_INCLUDE@@", "#include <SoftwareSerial.h>");
            sketch = sketch.replace(
                "@@EXTRA_LIB_GLOBALS@@",
                "static SoftwareSerial g_swSerial(10, 11);",
            );
            sketch = sketch.replace("@@EXTRA_LIB_SETUP@@", "g_swSerial.begin(9600);");
        } else {
            sketch = sketch.replace("@@EXTRA_LIB_INCLUDE@@", "#include <Ticker.h>");
            sketch = sketch.replace(
                "@@EXTRA_LIB_GLOBALS@@",
                "static Ticker g_extraTicker;\nstatic volatile uint8_t g_tickFlag = 0;\nstatic void tick_cb() { g_tickFlag = 1; }",
            );
            sketch = sketch.replace(
                "@@EXTRA_LIB_SETUP@@",
                "g_extraTicker.attach_ms(100, tick_cb);",
            );
        }
    } else {
        sketch = sketch.replace("@@EXTRA_LIB_INCLUDE@@", "");
        sketch = sketch.replace("@@EXTRA_LIB_GLOBALS@@", "");
        sketch = sketch.replace("@@EXTRA_LIB_SETUP@@", "");
    }

    sketch = sketch.replace("@@USE_SPI@@", if config.use_spi { "1" } else { "0" });
    sketch = sketch.replace("@@USE_WIFI@@", if use_wifi { "1" } else { "0" });
    sketch = sketch.replace("@@LANE_COUNT@@", &config.lane_count.to_string());
    sketch = sketch.replace("@@HISTORY_WINDOW@@", &config.history_window.to_string());
    sketch = sketch.replace("@@DIAG_STRIDE@@", &config.diag_stride.to_string());
    sketch = sketch.replace("@@PREDICTIVE_GAIN@@", &config.predictive_gain.to_string());
    sketch = sketch.replace("@@ROUTE_PLAN@@", &compose_csv_u8(config.route_plan));
    sketch = sketch.replace("@@PULSE_WEIGHTS@@", &compose_csv_u16(config.pulse_weights));
    sketch = sketch.replace("@@FRAME_APPEND@@", &frame_append);
    sketch = sketch.replace("@@VARIANT_BLOCK@@", &variant_block);
    sketch
}

async fn run_compile(
    sysroot: &Arc<Sysroot>,
    fqbn: &str,
    variant: VariantConfig,
    label_override: &str,
) -> ScenarioResult {
    let code = render_sketch(fqbn, variant);
    let build_signature = build_signature_for_code(sysroot, fqbn, &code);
    let captured = Arc::new(Mutex::new(String::new()));
    let captured_cb = captured.clone();
    let start = std::time::Instant::now();
    let compile = compile_sketch_string(
        sysroot,
        &code,
        fqbn,
        &[],
        CompileAccelSettings::default_jobs(),
        &build_signature,
        None,
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
    let captured_log = captured.lock().map(|g| g.clone()).unwrap_or_default();
    match compile {
        Ok((_path, result_log)) => {
            let combined = if captured_log.is_empty() {
                result_log.clone()
            } else {
                format!("{captured_log}\n{result_log}")
            };
            let excerpt = if bench_full_log_enabled() {
                combined.clone()
            } else {
                last_lines(&combined, 8)
            };
            let exact_hit = combined.contains("Cached build (Exact Match)")
                || combined.contains("Code unchanged (Exact Match)");
            let fast_relink =
                combined.contains("Fast Relink completed") || combined.contains("Fast Relink path");
            ScenarioResult {
                key: variant.key.to_string(),
                label: label_override.to_string(),
                elapsed_ms,
                success: true,
                exact_hit,
                fast_relink,
                metadata_present: qfast_metadata_present(fqbn),
                error: None,
                log_excerpt: Some(excerpt),
            }
        }
        Err(err) => {
            let excerpt = if captured_log.is_empty() {
                None
            } else if bench_full_log_enabled() {
                Some(captured_log)
            } else {
                Some(last_lines(&captured_log, 14))
            };
            ScenarioResult {
                key: variant.key.to_string(),
                label: label_override.to_string(),
                elapsed_ms,
                success: false,
                exact_hit: false,
                fast_relink: false,
                metadata_present: qfast_metadata_present(fqbn),
                error: Some(err.to_string()),
                log_excerpt: excerpt,
            }
        }
    }
}

async fn run_warmup(sysroot: &Arc<Sysroot>, fqbn: &str, variant: VariantConfig) -> WarmupResult {
    let (_cancel_tx, cancel_rx) = watch::channel(false);
    let start = std::time::Instant::now();
    let code = render_sketch(fqbn, variant);
    let build_signature = build_signature_for_code(sysroot, fqbn, &code);
    let result = warmup_sketch_with_cancel(
        sysroot,
        fqbn,
        Some(code),
        CompileAccelSettings::default_jobs(),
        CompileProfile::QuickFast,
        cancel_rx,
        Some(build_signature),
    )
    .await;
    WarmupResult {
        elapsed_ms: start.elapsed().as_millis(),
        success: result.is_ok(),
        metadata_present: qfast_metadata_present(fqbn),
        error: result.err().map(|e| e.to_string()),
    }
}

async fn run_startup_prewarm(sysroot: &Arc<Sysroot>, fqbn: &str) -> WarmupResult {
    let (_cancel_tx, cancel_rx) = watch::channel(false);
    let start = std::time::Instant::now();
    let result = match canonical_prewarm_spec(sysroot, fqbn) {
        Ok(spec) => {
            warmup_sketch_with_cancel(
                sysroot,
                fqbn,
                Some(spec.code),
                CompileAccelSettings::default_jobs(),
                CompileProfile::QuickFast,
                cancel_rx,
                Some(spec.build_signature),
            )
            .await
        }
        Err(e) => Err(e),
    };
    WarmupResult {
        elapsed_ms: start.elapsed().as_millis(),
        success: result.is_ok(),
        metadata_present: qfast_metadata_present(fqbn),
        error: result.err().map(|e| e.to_string()),
    }
}

/// Upload-style compile that mirrors the real upload cascade in lib.rs:
/// If QuickFast cache is warm → QuickFast (fast relink with artifacts).
/// If cold → SharedFast directly (avoids wasted QuickFast cold compile).
async fn run_upload_compile(
    sysroot: &Arc<Sysroot>,
    fqbn: &str,
    variant: VariantConfig,
    label_override: &str,
) -> ScenarioResult {
    let code = render_sketch(fqbn, variant);
    let build_signature = build_signature_for_code(sysroot, fqbn, &code);

    let profile = if has_warm_build_cache(sysroot, fqbn, CompileProfile::QuickFast) {
        CompileProfile::QuickFast
    } else {
        CompileProfile::SharedFast
    };

    let captured = Arc::new(Mutex::new(String::new()));
    let captured_cb = captured.clone();
    let start = std::time::Instant::now();
    let compile = compile_sketch_string(
        sysroot,
        &code,
        fqbn,
        &[],
        CompileAccelSettings::default_jobs(),
        &build_signature,
        None,
        profile,
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
    let captured_log = captured.lock().map(|g| g.clone()).unwrap_or_default();
    match compile {
        Ok((_path, result_log)) => {
            let combined = if captured_log.is_empty() {
                result_log.clone()
            } else {
                format!("{captured_log}\n{result_log}")
            };
            let excerpt = if bench_full_log_enabled() {
                combined.clone()
            } else {
                last_lines(&combined, 8)
            };
            let exact_hit = combined.contains("Cached build (Exact Match)")
                || combined.contains("Code unchanged (Exact Match)");
            let fast_relink =
                combined.contains("Fast Relink completed") || combined.contains("Fast Relink path");
            ScenarioResult {
                key: variant.key.to_string(),
                label: label_override.to_string(),
                elapsed_ms,
                success: true,
                exact_hit,
                fast_relink,
                metadata_present: qfast_metadata_present(fqbn),
                error: None,
                log_excerpt: Some(excerpt),
            }
        }
        Err(err) => {
            let excerpt = if captured_log.is_empty() {
                None
            } else if bench_full_log_enabled() {
                Some(captured_log)
            } else {
                Some(last_lines(&captured_log, 14))
            };
            ScenarioResult {
                key: variant.key.to_string(),
                label: label_override.to_string(),
                elapsed_ms,
                success: false,
                exact_hit: false,
                fast_relink: false,
                metadata_present: qfast_metadata_present(fqbn),
                error: Some(err.to_string()),
                log_excerpt: excerpt,
            }
        }
    }
}

fn write_report(report: &BenchReport) -> Result<PathBuf> {
    let state_dir = std::env::current_dir()
        .context("resolve cwd failed")?
        .join("state");
    fs::create_dir_all(&state_dir).with_context(|| format!("create {}", state_dir.display()))?;
    let ts = report.generated_at_ms;
    let out_path = state_dir.join(format!("compile_matrix_{ts}.json"));
    let data = serde_json::to_string_pretty(report)?;
    fs::write(&out_path, data).with_context(|| format!("write {}", out_path.display()))?;
    Ok(out_path)
}

fn print_board_summary(result: &BoardBenchResult) {
    println!("\n=== {} ({}) ===", result.label, result.fqbn);
    if let Some(budget) = result.budget_ms {
        println!("Target budget: {} ms", budget);
    }
    let scenarios = [
        ("cold", &result.cold_compile),
        ("startup-prime", &result.compile_after_startup_prewarm),
        ("warm-compile", &result.compile_after_warmup),
        ("logic-edit", &result.logic_edit),
        ("topology-shift", &result.topology_shift),
        ("rewrite", &result.rewrite_after_shift),
        ("upload-compile", &result.upload_compile),
        ("cold-upload", &result.cold_upload_compile),
        ("newlib-upload", &result.newlib_upload_compile),
    ];
    for (name, scenario) in scenarios {
        println!(
            "  {:14} {:>7} ms | ok={} | exact={} | relink={} | meta={}",
            name,
            scenario.elapsed_ms,
            scenario.success,
            scenario.exact_hit,
            scenario.fast_relink,
            scenario.metadata_present
        );
        if let Some(err) = &scenario.error {
            println!("    error: {}", err);
        }
    }
    println!(
        "  {:14} {:>7} ms | ok={} | meta={}",
        "startup-warmup",
        result.startup_prewarm.elapsed_ms,
        result.startup_prewarm.success,
        result.startup_prewarm.metadata_present
    );
    if let Some(err) = &result.startup_prewarm.error {
        println!("    error: {}", err);
    }
    println!(
        "  {:14} {:>7} ms | ok={} | meta={}",
        "warmup", result.warmup.elapsed_ms, result.warmup.success, result.warmup.metadata_present
    );
    if let Some(err) = &result.warmup.error {
        println!("    error: {}", err);
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let targets = selected_targets();
    if targets.is_empty() {
        println!("No board targets matched the requested filter.");
        return Ok(());
    }

    let ck_root = dirs::document_dir()
        .context("resolve Documents failed")?
        .join("CK");
    let sysroot = Arc::new(Sysroot::init(Some(ck_root), "CK").await?);
    let jobs = CompileAccelSettings::default_jobs();
    let [baseline, logic_edit, topology_shift, rewrite_after_shift] = variants();

    let mut boards = Vec::new();
    for target in targets {
        println!("\n[Bench] Running board {}", target.fqbn);

        reset_board_state(target.fqbn);
        let cold_compile = run_compile(&sysroot, target.fqbn, baseline, "Cold compile").await;

        reset_board_state(target.fqbn);
        let startup_prewarm = run_startup_prewarm(&sysroot, target.fqbn).await;
        reset_board_cache(target.fqbn);
        let compile_after_startup_prewarm = run_compile(
            &sysroot,
            target.fqbn,
            baseline,
            "Compile after startup prewarm",
        )
        .await;

        reset_board_state(target.fqbn);
        let warmup = run_warmup(&sysroot, target.fqbn, baseline).await;
        let compile_after_warmup =
            run_compile(&sysroot, target.fqbn, baseline, "Compile after warmup").await;

        let logic_edit = run_compile(
            &sysroot,
            target.fqbn,
            logic_edit,
            "Logic edit, same topology",
        )
        .await;
        let topology_shift = run_compile(
            &sysroot,
            target.fqbn,
            topology_shift,
            "Topology shift, signature changed",
        )
        .await;
        let rewrite_after_shift = run_compile(
            &sysroot,
            target.fqbn,
            rewrite_after_shift,
            "Rewrite after topology shift",
        )
        .await;

        // Upload compile uses QuickFast profile (same as real upload path)
        let upload_compile = run_upload_compile(
            &sysroot,
            target.fqbn,
            baseline,
            "Upload compile (QuickFast, warm)",
        )
        .await;

        // New-library upload: warm cache from V1, then add a never-seen library (Servo/Ticker)
        let newlib_upload_compile = run_upload_compile(
            &sysroot,
            target.fqbn,
            newlib_variant(),
            "Upload compile (new library added)",
        )
        .await;

        // Cold upload: clear ALL caches, then upload compile from scratch
        reset_board_state(target.fqbn);
        let cold_upload_compile = run_upload_compile(
            &sysroot,
            target.fqbn,
            baseline,
            "Upload compile (QuickFast, cold)",
        )
        .await;

        let board_result = BoardBenchResult {
            fqbn: target.fqbn.to_string(),
            label: target.label.to_string(),
            budget_ms: board_budget_ms(target.fqbn),
            cold_compile,
            startup_prewarm,
            compile_after_startup_prewarm,
            warmup,
            compile_after_warmup,
            logic_edit,
            topology_shift,
            rewrite_after_shift,
            upload_compile,
            cold_upload_compile,
            newlib_upload_compile,
        };
        print_board_summary(&board_result);
        boards.push(board_result);
    }

    let report = BenchReport {
        generated_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        max_jobs: jobs,
        boards,
    };

    let out_path = write_report(&report)?;
    println!("\nSaved report: {}", out_path.display());
    Ok(())
}
