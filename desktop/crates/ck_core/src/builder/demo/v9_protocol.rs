//! Shared host-side protocol checks. This exact module is also exercised by
//! the small standalone contract test crate, without compiling the desktop UI.
use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::HashSet;

pub(super) const ARTIFACT_NAMES: [&str; 10] = [
    "sketch.ino.elf", "sketch.ino.bin", "sketch.ino.partitions.bin",
    "sketch.ino.merged.bin", "flash_args", "boot_app0.bin",
    "sketch.ino.bootloader.bin", "sdkconfig", "build.options.json", "partitions.csv",
];
pub(super) const AVR_ARTIFACT_NAMES: [&str; 4] = ["sketch.ino.elf", "sketch.ino.hex", "sketch.ino.eep", "build.options.json"];
pub(super) fn artifact_names(fqbn: &str) -> Result<&'static [&'static str]> {
    anyhow::ensure!(allows_fqbn(&["esp32:esp32:*".into(), "arduino:avr:*".into()], fqbn), "Invalid V9 artifact target");
    Ok(if fqbn.starts_with("arduino:avr:") { &AVR_ARTIFACT_NAMES } else { &ARTIFACT_NAMES })
}

pub(super) fn allows_fqbn(selectors: &[String], fqbn: &str) -> bool {
    let fields: Vec<_> = fqbn.split(':').collect();
    let identifier = |value: &str| !value.is_empty() && value.bytes().all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c));
    if fqbn.len() > 4096 || !(3..=4).contains(&fields.len()) || !identifier(fields[2]) { return false; }
    let family = match (fields[0], fields[1]) { ("esp32", "esp32") => "esp32:esp32:*", ("arduino", "avr") => "arduino:avr:*", _ => return false };
    if fields.len() == 4 {
        let mut keys = HashSet::new();
        for option in fields[3].split(',') {
            let Some((key, value)) = option.split_once('=') else { return false; };
            if !identifier(key) || !identifier(value) || !keys.insert(key) { return false; }
        }
    }
    selectors.iter().any(|value| value == family || value == fqbn)
}

pub(super) fn validate_receipt(receipt: &Value, id: &str, source: &str, fqbn: &str) -> Result<()> {
    anyhow::ensure!(receipt["requestId"] == id, "V9 request identity mismatch");
    anyhow::ensure!(receipt["sourceSha256"] == source, "V9 source identity mismatch");
    anyhow::ensure!(receipt["fqbn"] == fqbn, "V9 target mismatch");
    anyhow::ensure!(receipt["protocolVersion"] == 1 && receipt["engineVersion"] == "1.0.63", "V9 protocol mismatch");
    if receipt["success"] != true {
        // Keep compiler diagnostics as real lines. Serializing the error object
        // escapes paths/newlines and prevents the host from proving the sketch
        // alias and the UI from locating the responsible Blockly block.
        let error = &receipt["error"];
        let code = error["code"].as_str().unwrap_or("BUILD_FAILED");
        let message = error["message"].as_str()
            .or_else(|| error.as_str()).unwrap_or("V9 returned no error details");
        anyhow::bail!("V9 build failed [{}]:\n{}", code, message);
    }
    Ok(())
}

pub(super) fn validate_manifest(receipt: &Value) -> Result<&Vec<Value>> {
    let artifacts = receipt["artifacts"].as_array().context("Missing V9 artifact manifest")?;
    let expected = artifact_names(receipt["fqbn"].as_str().context("Missing V9 manifest target")?)?;
    anyhow::ensure!(artifacts.len() == expected.len(), "V9 target artifact count mismatch");
    let mut names = HashSet::new();
    for item in artifacts {
        let name = item["name"].as_str().context("Missing artifact name")?;
        anyhow::ensure!(expected.contains(&name) && names.insert(name), "Unknown or duplicate V9 artifact");
    }
    Ok(artifacts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn esp32_routing_accepts_menu_combinations_without_collapsing_identity() {
        let selectors = vec!["esp32:esp32:*".to_owned()];
        for fqbn in ["esp32:esp32:esp32", "esp32:esp32:esp32c3", "esp32:esp32:esp32s3:FlashSize=4M,PartitionScheme=default", "esp32:esp32:esp32s3:PSRAM=opi,USBMode=hwcdc"] {
            assert!(allows_fqbn(&selectors, fqbn));
        }
        for fqbn in ["esp32:esp32:*", "esp32:esp32:esp32s3:", "esp32:esp32:esp32:FlashSize=4M,FlashSize=16M", "arduino:avr:uno", "esp32:esp32:../esp32"] {
            assert!(!allows_fqbn(&selectors, fqbn));
        }
        let exact = vec!["esp32:esp32:esp32s3:FlashSize=16M".to_owned()];
        assert!(!allows_fqbn(&exact, "esp32:esp32:esp32s3:FlashSize=4M"));
    }

    #[test]
    fn stale_failed_and_unknown_protocol_results_are_rejected() {
        let base = json!({"requestId":"request","sourceSha256":"source","fqbn":"board",
            "protocolVersion":1,"engineVersion":"1.0.63","success":true});
        assert!(validate_receipt(&base, "request", "source", "board").is_ok());
        for key in ["requestId", "sourceSha256", "fqbn", "protocolVersion", "engineVersion", "success"] {
            let mut changed = base.clone(); changed[key] = json!("invalid");
            assert!(validate_receipt(&changed, "request", "source", "board").is_err(), "{key}");
        }
    }

    #[test]
    fn failed_build_preserves_multiline_diagnostics_after_identity_checks() {
        let diagnostic = "C:\\CKData\\tmp\\CK_Builds\\v9\\sessions\\abc\\source\\sketch\\sketch.ino:7:3: error: 'variable' was not declared in this scope\r\n  variable = 0;\r\n";
        let mut receipt = json!({"requestId":"request","sourceSha256":"source","fqbn":"board",
            "protocolVersion":1,"engineVersion":"1.0.63","success":false,
            "error":{"code":"BUILD_FAILED","fallbackSafe":false,"message":diagnostic}});
        let error = validate_receipt(&receipt, "request", "source", "board").unwrap_err().to_string();
        assert_eq!(error, format!("V9 build failed [BUILD_FAILED]:\n{}", diagnostic));
        assert!(error.lines().any(|line| line.starts_with("C:\\CKData")));
        receipt["sourceSha256"] = json!("stale");
        let error = validate_receipt(&receipt, "request", "source", "board").unwrap_err().to_string();
        assert!(!error.contains(diagnostic));
        assert!(error.contains("source identity mismatch"));
    }

    #[test]
    fn missing_duplicate_and_extra_outputs_are_rejected() {
        let artifacts: Vec<_> = ARTIFACT_NAMES.iter().map(|name| json!({"name":name})).collect();
        let base = json!({"fqbn":"esp32:esp32:esp32s3","artifacts":artifacts}); assert!(validate_manifest(&base).is_ok());
        let mut missing = base.clone(); missing["artifacts"].as_array_mut().unwrap().pop();
        assert!(validate_manifest(&missing).is_err());
        let mut duplicate = base.clone(); duplicate["artifacts"][9] = duplicate["artifacts"][0].clone();
        assert!(validate_manifest(&duplicate).is_err());
        let mut escape = base; escape["artifacts"][9]["name"] = json!("../other.bin");
        assert!(validate_manifest(&escape).is_err());
    }

    #[test]
    fn avr_contract_preserves_menu_identity_and_rejects_cross_arch_outputs() {
        let allowed=vec!["arduino:avr:*".into()];
        for fqbn in ["arduino:avr:uno","arduino:avr:nano:cpu=atmega328old","arduino:avr:mega:cpu=atmega2560"] { assert!(allows_fqbn(&allowed,fqbn)); }
        assert!(!allows_fqbn(&allowed,"esp32:esp32:esp32s3"));
        assert!(!allows_fqbn(&["arduino:avr:nano:cpu=atmega328".into()],"arduino:avr:nano:cpu=atmega328old"));
        let artifacts:Vec<_>=AVR_ARTIFACT_NAMES.iter().map(|n|json!({"name":n})).collect();
        let mut receipt=json!({"fqbn":"arduino:avr:uno","artifacts":artifacts});
        assert!(validate_manifest(&receipt).is_ok());
        receipt["fqbn"]=json!("esp32:esp32:esp32s3");assert!(validate_manifest(&receipt).is_err());
    }
}
