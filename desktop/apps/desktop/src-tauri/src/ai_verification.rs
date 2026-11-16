//! Return HEX only from this successful candidate's host-verified artifacts.
//! No model-supplied path or replacement test source is accepted.
use serde_json::{json, Value};
pub fn simulation_target(fqbn: &str) -> bool {
    let parts: Vec<_> = fqbn.split(':').collect();
    if !(3..=4).contains(&parts.len()) || parts[0] != "arduino" || parts[1] != "avr" { return false; }
    match parts[2] {
        "uno" => parts.len() == 3 || parts[3].is_empty(),
        "nano" => parts.len() == 3 || matches!(parts[3], "" | "cpu=atmega328" | "cpu=atmega328old"),
        _ => false,
    }
}
pub fn capture_firmware(artifacts: &[Value], fqbn: &str, source: &str) -> Result<Value, String> {
    let hex: Vec<_> = artifacts.iter().filter_map(Value::as_str).filter(|p| {
        let path = std::path::Path::new(p);
        path.extension().and_then(|v| v.to_str()) == Some("hex") && !p.to_lowercase().contains("with_bootloader")
    }).collect();
    if hex.len() != 1 { return Err("行为验证需要唯一的候选HEX产物".into()); }
    let path = std::path::Path::new(hex[0]);
    if std::fs::metadata(path).map_err(|e|e.to_string())?.len() > 200000 { return Err("行为验证HEX超过容量上限".into()); }
    let content = std::fs::read_to_string(path).map_err(|e|e.to_string())?;
    if content.len() > 200000 { return Err("行为验证HEX超过容量上限".into()); }
    Ok(json!({"format":"ihex","content":content,"sha256":crate::sha256_text(&content),"fqbn":fqbn,"sourceSha256":source}))
}
#[cfg(test)] mod tests {
    #[test] fn unsupported_mcu_and_options_are_not_implicitly_simulated() {
        for q in ["arduino:avr:uno","arduino:avr:nano:cpu=atmega328","arduino:avr:nano:cpu=atmega328old"] { assert!(super::simulation_target(q)); }
        for q in ["arduino:avr:nano:cpu=atmega168","arduino:avr:mega","esp32:esp32:esp32s3","arduino:avr:uno:clock=8MHz","custom:avr:uno"] { assert!(!super::simulation_target(q)); }
    }
}
