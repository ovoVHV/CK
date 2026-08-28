//! Explicit local qualification helper.
//!
//! This test is ignored by default because it scans the installed Core and
//! tool inputs. Run it deliberately with `--ignored --nocapture`; it never
//! compiles, uploads, opens a serial port, or changes a qualification manifest.

use std::time::Instant;

#[path = "../src/ck_forge.rs"]
mod ck_forge;

#[test]
#[ignore = "explicit local CK Forge identity scan"]
fn print_local_ck_forge_target_identities() {
    let sysroot = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("workspace sysroot");
    let targets = [
        "esp32:esp32:esp32",
        "esp32:esp32:esp32s2",
        "esp32:esp32:esp32s3",
        "esp32:esp32:esp32c3",
        "esp32:esp32:esp32c5",
        "esp32:esp32:esp32c6",
        "esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB",
        "arduino:avr:uno",
        "arduino:avr:nano",
        "arduino:avr:nano:cpu=atmega328",
        "arduino:avr:mega",
        "arduino:avr:mega:cpu=atmega2560",
        "arduino:avr:diecimila",
        "arduino:avr:diecimila:cpu=atmega328",
        "esp8266:esp8266:nodemcuv2",
    ];
    let mut rows = Vec::new();
    for fqbn in targets {
        let started = Instant::now();
        let (key, first_source) =
            ck_core::builder::demo::resolve_toolchain_cache_key_from_root(&sysroot, fqbn);
        let first_ms = started.elapsed().as_millis();
        let started = Instant::now();
        let (reused_key, second_source) =
            ck_core::builder::demo::resolve_toolchain_cache_key_from_root(&sysroot, fqbn);
        let second_ms = started.elapsed().as_millis();
        assert_eq!(reused_key, key, "identity changed during scan for {fqbn}");
        rows.push(serde_json::json!({
            "canonical_fqbn": fqbn,
            "toolchain_key": key,
            "first_source": format!("{first_source:?}"),
            "first_ms": u64::try_from(first_ms).unwrap_or(u64::MAX),
            "second_source": format!("{second_source:?}"),
            "second_ms": u64::try_from(second_ms).unwrap_or(u64::MAX),
        }));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "schema_version": 2,
            "host_identity_sha256": ck_forge::host_environment_fingerprint(&sysroot),
            "engine_id": "ck-forge/v1",
            "host_os": std::env::consts::OS,
            "host_arch": std::env::consts::ARCH,
            "compile_performed": false,
            "upload_performed": false,
            "targets": rows,
        }))
        .expect("identity report JSON")
    );
}
