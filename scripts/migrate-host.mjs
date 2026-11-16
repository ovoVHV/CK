import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),f=path.join(root,'desktop/crates/ck_core/src/builder/demo/native_graph_backend.rs');
let s=fs.readFileSync(f,'utf8');
s=s.replace(/\/\/! Explicit Windows-native[\s\S]*?use super::\*;/,'//! V9.0 opt-in preview host. Structured IPC results; independent artifact verification.\nuse super::*;');
s=s.replace('    node_path: PathBuf,','    enabled: bool,\n    engine_version: String,\n    protocol_version: u64,\n    node_path: PathBuf,');
s=s.replace('    anyhow::ensure!(receipt["success"] == true,','    anyhow::ensure!(receipt["protocolVersion"] == 1 && receipt["engineVersion"] == "9.1.0-alpha.2", "V9 protocol mismatch");\n    anyhow::ensure!(receipt["success"] == true,');
s=s.replace('"CK_NATIVE_GRAPH_CONFIG"','"CK_V9_CONFIG"');
s=s.replace('    if !config.allowed_fqbns', '    if !config.enabled { return Ok(None); }\n    anyhow::ensure!(config.protocol_version == 1 && config.engine_version == "9.1.0-alpha.2", "V9 host configuration version mismatch");\n    if !config.allowed_fqbns');
s=s.replace('"native-graph-v1"','"ck-build-engine-v9-protocol-1"').replace('CK_Builds/native-graph','CK_Builds/v9');
s=s.replace('"requestId":request_id,"receiptPath":receipt_file,"fqbn":fqbn,','"requestId":request_id,"sourceSha256":source_hash,"receiptPath":receipt_file,"fqbn":fqbn,');
const a=s.indexOf('    anyhow::ensure!(receipt_file.is_file()');const b=s.indexOf('    let export_started',a);
s=s.slice(0,a)+`    // The host consumes the result returned by its managed bridge process.
    // A self-checking file on disk cannot authorize a successful build.
    let receipt: Value = serde_json::from_slice(&output.stdout).context("Invalid V9 structured result")?;
    anyhow::ensure!(receipt["requestId"] == request_id && receipt["sourceSha256"] == source_hash && receipt["fqbn"] == fqbn,
        "V9 response identity mismatch");
    anyhow::ensure!(receipt["protocolVersion"] == 1 && receipt["engineVersion"] == "9.1.0-alpha.2", "V9 response version mismatch");
    if receipt["success"] != true && receipt["error"]["fallbackSafe"] == true
        && matches!(receipt["error"]["code"].as_str(), Some("ENGINE_UNAVAILABLE" | "NOT_QUALIFIED")) {
        log(format!("[V9] Safe fallback to v6: {}\\n", receipt["error"]["message"]));
        return Ok(None);
    }
    validate_receipt(&receipt, &request_id, &source_hash, fqbn)?;
    anyhow::ensure!(output.status.success(), "V9 bridge failed; output rejected");
    std::fs::write(&receipt_file, serde_json::to_vec_pretty(&receipt)?)?;
`+s.slice(b);
s=s.replace('    for item in receipt["artifacts"].as_array().context("Missing native graph artifact manifest")? {',`    const EXPECTED: [&str; 10] = ["sketch.ino.elf", "sketch.ino.bin", "sketch.ino.partitions.bin", "sketch.ino.merged.bin", "flash_args", "boot_app0.bin", "sketch.ino.bootloader.bin", "sdkconfig", "build.options.json", "partitions.csv"];
    let artifacts = receipt["artifacts"].as_array().context("Missing V9 artifact manifest")?;
    anyhow::ensure!(artifacts.len() == EXPECTED.len(), "V9 requires exactly ten delivery files");
    let mut names = std::collections::HashSet::new();
    for item in artifacts {
        let name = item["name"].as_str().context("Missing artifact name")?;
        anyhow::ensure!(EXPECTED.contains(&name) && names.insert(name), "Unknown or duplicate V9 artifact");`);
s=s.replace('        anyhow::ensure!(!std::fs::symlink_metadata(&file)?',`        anyhow::ensure!(file.file_name().and_then(|n| n.to_str()) == Some(name), "Artifact name differs from path");
        #[cfg(windows)] {
            use std::os::windows::fs::MetadataExt;
            for ancestor in file.ancestors() {
                anyhow::ensure!(std::fs::symlink_metadata(ancestor)?.file_attributes() & 0x400 == 0, "Reparse artifact path rejected");
            }
        }
        anyhow::ensure!(!std::fs::symlink_metadata(&file)?`);
s=s.replace(/for name in \["sketch.ino.bin", "sketch.ino.elf", "sketch.ino.bootloader.bin", "sketch.ino.partitions.bin", "boot_app0.bin", "flash_args"\]/,'for name in EXPECTED');
s=s.replace('    let summary = format!',`    let ack_file = stage_process.join("export-ack.json");
    std::fs::write(&ack_file, serde_json::to_vec(&json!({"requestId":request_id,"sourceSha256":source_hash,"success":true}))?)?;
    let mut ack = Command::new(&config.node_path); hide_window(&mut ack);
    ack.arg(&config.engine_path).arg("--config").arg(&ack_file).arg("--ack").current_dir(&sysroot.root_dir);
    let ack_output = managed_command_output(&mut ack).await?;
    anyhow::ensure!(ack_output.status.success() && serde_json::from_slice::<Value>(&ack_output.stdout)?["success"] == true, "V9 export lease acknowledgement failed");
    let summary = format!`);
s=s.replaceAll('windows-native-graph-v1','ck-build-engine-v9').replaceAll('(explicit experiment)','(opt-in preview)');
s=s.replace('"fqbn":"b","success":true','"fqbn":"b","success":true,"protocolVersion":1,"engineVersion":"9.1.0-alpha.2"');
fs.writeFileSync(f,s);
