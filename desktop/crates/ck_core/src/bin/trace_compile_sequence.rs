//! Isolated production-builder diagnostic; not a desktop-click benchmark or qualification.
//! Run with TEMP/TMP under CK_PROBE_OUTPUT. Never uploads or edits a user's project.
use anyhow::{Context, Result, ensure};
use ck_core::builder::demo::{
    self, CkExactReusePolicy, CompileIntent, CompileProfile, ToolchainIdentityLease,
};
use ck_core::builder::signature::{BuildSignatureInput, compute_build_signature};
use ck_core::manifest::Manifest;
use ck_core::sysroot::Sysroot;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stage {
    name: String,
    code: String,
    #[serde(default)]
    upload_ready: bool,
    #[serde(default)]
    expect_failure: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let root = PathBuf::from(std::env::var_os("CK_PROBE_ROOT").context("CK_PROBE_ROOT required")?)
        .canonicalize()?;
    let output =
        PathBuf::from(std::env::var_os("CK_PROBE_OUTPUT").context("CK_PROBE_OUTPUT required")?)
            .canonicalize()?;
    let temp = std::env::temp_dir().canonicalize()?;
    let cache_owner = std::env::var_os("CK_PROBE_CACHE_OWNER")
        .map(PathBuf::from)
        .unwrap_or_else(|| output.clone())
        .canonicalize()?;
    ensure!(
        temp.starts_with(&cache_owner) && temp != cache_owner,
        "TEMP/TMP must be a dedicated child of the diagnostic cache owner"
    );
    ensure!(
        !output.join("report.json").exists(),
        "refusing to overwrite a diagnostic report"
    );
    let fqbn = std::env::var("CK_PROBE_FQBN").context("CK_PROBE_FQBN required")?;
    let sysroot = Sysroot {
        root_dir: root.clone(),
        manifest: Arc::new(tokio::sync::Mutex::new(Manifest::default())),
    };
    let cli_version = demo::canonical_prewarm_cli_version(&sysroot);
    let default_stages = [
        (
            "empty",
            "#include <Arduino.h>\nvoid setup() {}\nvoid loop() {}\n",
        ),
        (
            "gpio",
            "#include <Arduino.h>\nvoid setup() { pinMode(4, OUTPUT); }\nvoid loop() { digitalWrite(4, HIGH); delay(100); digitalWrite(4, LOW); delay(100); }\n",
        ),
        (
            "wifi",
            "#include <Arduino.h>\n#include <WiFi.h>\nvoid setup() { pinMode(4, OUTPUT); WiFi.mode(WIFI_STA); }\nvoid loop() { digitalWrite(4, HIGH); delay(100); digitalWrite(4, LOW); delay(100); }\n",
        ),
        (
            "wifi-edit",
            "#include <Arduino.h>\n#include <WiFi.h>\nvoid setup() { pinMode(4, OUTPUT); WiFi.mode(WIFI_STA); }\nvoid loop() { again: digitalWrite(4, HIGH); delay(101); digitalWrite(4, LOW); delay(100); goto again; }\n",
        ),
        (
            "remove-wifi",
            "#include <Arduino.h>\nvoid setup() { pinMode(4, OUTPUT); }\nvoid loop() { digitalWrite(4, HIGH); delay(100); digitalWrite(4, LOW); delay(100); }\n",
        ),
    ];
    let stages: Vec<Stage> = if let Some(path) = std::env::var_os("CK_PROBE_SCENARIOS") {
        serde_json::from_slice(&std::fs::read(path)?)?
    } else {
        default_stages.into_iter().map(|(name, code)| Stage {
            name: name.into(), code: code.into(), upload_ready: false, expect_failure: false,
        }).collect()
    };
    let mut names = std::collections::HashSet::new();
    for stage in &stages {
        ensure!(!stage.name.is_empty() && stage.name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'), "invalid stage name");
        ensure!(names.insert(stage.name.clone()), "duplicate stage name");
    }
    let count: usize = std::env::var("CK_PROBE_COUNT")
        .unwrap_or_else(|_| stages.len().to_string())
        .parse()?;
    let mut report = json!({ "boundary": "production ck_core builder; excludes desktop IPC/UI and library resolver", "fqbn": fqbn, "profile": "release", "nativeRelink": "disabled (matches observed unqualified target)", "uploadPerformed": false, "projectModified": false, "stages": [] });
    for stage in stages.into_iter().take(count) {
        let name = stage.name.as_str();
        let code = stage.code.as_str();
        let intent = if stage.upload_ready { CompileIntent::UploadReady } else { CompileIntent::CompileOnly };
        let started = std::time::Instant::now();
        let lease = ToolchainIdentityLease::begin(&root, &fqbn)?;
        let signature = compute_build_signature(&BuildSignatureInput {
            fqbn: &fqbn,
            cli_version: &cli_version,
            toolchain_key: lease.toolchain_key(),
            sorted_libs: &[],
        });
        let log = Arc::new(Mutex::new(String::new()));
        let captured = log.clone();
        let timeline = Arc::new(Mutex::new(Vec::new()));
        let captured_timeline = timeline.clone();
        println!("START {name}");
        let result = demo::compile_sketch_string_with_identity_lease_and_intent(
            &sysroot,
            code,
            &fqbn,
            &[],
            8,
            &signature,
            Some("isolated-sequence"),
            CompileProfile::Release,
            CkExactReusePolicy::Allow,
            intent,
            lease,
            |_, _| {},
            move |line| {
                if line.contains("Timing DIAG")
                    || line.contains("CoreSeed")
                    || line.contains("Native CLI dependency")
                {
                    print!("{line}");
                }
                captured.lock().unwrap().push_str(&line);
                captured_timeline.lock().unwrap().push(json!({"elapsedMs": started.elapsed().as_millis(), "line": line}));
            },
        )
        .await;
        let elapsed = started.elapsed().as_millis();
        std::fs::write(output.join(format!("{name}.ino")), code)?;
        std::fs::write(
            output.join(format!("{name}.log.txt")),
            log.lock().unwrap().as_bytes(),
        )?;
        std::fs::write(output.join(format!("{name}.timeline.json")), serde_json::to_vec_pretty(&*timeline.lock().unwrap())?)?;
        if result.is_err() || stage.expect_failure {
            let passed = result.is_err() && stage.expect_failure;
            let error = result.err().map(|error| error.to_string());
            let row = json!({"stage": name, "wallMs": elapsed, "buildSignature": signature, "uploadReady": stage.upload_ready, "expectedFailure": stage.expect_failure, "passed": passed, "error": error});
            println!("RESULT {row}");
            report["stages"].as_array_mut().unwrap().push(row);
            std::fs::write(output.join("report.json"), serde_json::to_vec_pretty(&report)?)?;
            ensure!(passed, "stage {name} did not produce the expected outcome");
            continue;
        }
        let (build, _) = result?;
        let mut artifacts = Vec::new();
        for entry in std::fs::read_dir(&build)? {
            let path = entry?.path();
            if matches!(
                path.extension().and_then(|s| s.to_str()),
                Some("bin" | "elf" | "hex" | "uf2")
            ) {
                let bytes = std::fs::read(&path)?;
                let sha256 = hex::encode(Sha256::digest(&bytes));
                artifacts.push(json!({"file": path.file_name().unwrap().to_string_lossy(), "bytes": bytes.len(), "sha256": sha256}));
            }
        }
        let row = json!({ "stage": name, "wallMs": elapsed, "buildSignature": signature, "buildPath": build, "artifacts": artifacts, "uploadReady": stage.upload_ready, "passed": true });
        // Preserve the native command graph and Core timestamps as evidence
        // that a cache-hit label was not mistaken for actual object reuse.
        let core = build.join("core");
        let mut core_files = Vec::new();
        for entry in std::fs::read_dir(&core)? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            if metadata.is_file() {
                core_files.push(json!({"file": entry.file_name().to_string_lossy(), "bytes": metadata.len(), "mtimeNs": metadata.modified()?.duration_since(std::time::UNIX_EPOCH)?.as_nanos().to_string(), "sha256": hex::encode(Sha256::digest(std::fs::read(entry.path())?))}));
            }
        }
        std::fs::write(
            output.join(format!("{name}.core-files.json")),
            serde_json::to_vec_pretty(&core_files)?,
        )?;
        std::fs::copy(
            build.join("compile_commands.json"),
            output.join(format!("{name}.ccdb.json")),
        )?;
        println!("RESULT {}", json!({"stage": name, "wallMs": elapsed}));
        report["stages"].as_array_mut().unwrap().push(row);
        std::fs::write(
            output.join("report.json"),
            serde_json::to_vec_pretty(&report)?,
        )?;
    }
    Ok(())
}
