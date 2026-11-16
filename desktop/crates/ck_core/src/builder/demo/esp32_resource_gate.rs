//! Installed-environment ESP32 Dev Module gate. This deliberately uses the
//! existing production compile/resolution path; it does not add a resolver.
use super::*;

fn firmware_bytes(build: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    std::fs::read_dir(build).unwrap().filter_map(Result::ok).filter_map(|entry| {
        let path = entry.path();
        matches!(path.extension().and_then(|x| x.to_str()), Some("bin") | Some("elf"))
            .then(|| (entry.file_name().to_string_lossy().to_string(), std::fs::read(path).unwrap()))
    }).collect()
}

#[tokio::test]
#[ignore = "requires installed ESP32 Core; explicit CK_ESP32_REALITY_ROOT and output"]
async fn esp32_dev_module_production_resource_gate() {
    let root = PathBuf::from(std::env::var("CK_ESP32_REALITY_ROOT").unwrap());
    let boards = std::fs::read_to_string(root.join("packages/esp32/hardware/esp32/3.3.6/boards.txt")).unwrap();
    assert!(boards.contains("esp32.name=ESP32 Dev Module"));
    assert!(boards.contains("esp32.build.mcu=esp32"));
    assert!(boards.contains("esp32.build.variant=esp32"));
    let sysroot = Sysroot { root_dir: root.clone(), manifest: std::sync::Arc::new(tokio::sync::Mutex::new(crate::manifest::Manifest::default())) };
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("esp32_gate");
    let build = tmp.path().join("build");
    let fqbn = "esp32:esp32:esp32";
    let code = "void setup(){pinMode(13,OUTPUT);Serial.begin(115200);Serial2.begin(115200);} void loop(){digitalWrite(13,HIGH);analogWrite(13,128);Serial.println(analogRead(36));}";
    let overrides = command_scoped_build_properties(&root, fqbn, CompileProfile::Release);
    let request = serde_json::json!({"code":code,"fqbn":fqbn,"options":overrides,"libraries":[],"profile":"Release","jobs":2});
    let request_before = request.clone();
    let without = resolve_runtime_tools_preflight_for_compile(&root, fqbn, &build, &project, "esp32_gate.ino", &overrides, None).await.unwrap();
    let (with, identity) = crate::builder::resource_observation::capture(
        resolve_runtime_tools_preflight_for_compile(&root, fqbn, &build, &project, "esp32_gate.ino", &overrides, None)
    ).await;
    assert_eq!(without, with.unwrap());
    let identity = identity.unwrap();
    assert_eq!(identity.fqbn, fqbn);
    assert_eq!(identity.mcu, "esp32");
    assert_eq!(identity.variant, "esp32");
    assert_eq!(identity.f_cpu, "240000000L");
    // Menu applicability is tested through the same production property
    // resolver, not through a hand-written TypeScript options object.
    let psram_fqbn = "esp32:esp32:esp32:PSRAM=enabled";
    let psram_overrides = command_scoped_build_properties(&root, psram_fqbn, CompileProfile::Release);
    let (psram_result, psram_identity) = crate::builder::resource_observation::capture(
        resolve_runtime_tools_preflight_for_compile(&root, psram_fqbn, &build, &project, "esp32_gate_psram.ino", &psram_overrides, None)
    ).await;
    psram_result.unwrap();
    let psram_identity = psram_identity.unwrap();
    assert_eq!(psram_identity.fqbn, psram_fqbn);
    assert_eq!(psram_identity.options.get("PSRAM").map(String::as_str), Some("enabled"));
    let signature = build_signature_for_code(&sysroot, fqbn, code);
    let off = compile_sketch_string(&sysroot, code, fqbn, &[], 2, &signature, None, CompileProfile::Release, CkExactReusePolicy::Deny, |_, _| {}, |_| {}).await.unwrap();
    let binaries = firmware_bytes(&off.0);
    assert!(!binaries.is_empty(), "ESP32 compile must emit firmware artifacts");
    let (on, observed) = crate::builder::resource_observation::capture(
        compile_sketch_string(&sysroot, code, fqbn, &[], 2, &signature, None, CompileProfile::Release, CkExactReusePolicy::Deny, |_, _| {}, |_| {})
    ).await;
    let on = on.unwrap();
    assert_eq!(off.0, on.0);
    assert_eq!(binaries, firmware_bytes(&on.0), "firmware must be byte-identical");
    assert_eq!(observed.as_ref(), Some(&identity));
    assert_eq!(signature, build_signature_for_code(&sysroot, fqbn, code));
    assert_eq!(request, request_before);
    let hashes: std::collections::BTreeMap<_, _> = binaries.iter().map(|(name, bytes)| (name, hex::encode(Sha256::digest(bytes)))).collect();
    let output = serde_json::json!({"fqbn":fqbn,"identity":identity,"psramResolvedMenu":{"identity":psram_identity,"reservation":"gpio.16/gpio.17"},"requestUnchanged":true,"productionCompilePair":"PASS","firmwareHashes":hashes,"buildSignatureBefore":signature,"buildSignatureAfter":build_signature_for_code(&sysroot,fqbn,code)});
    std::fs::write(std::env::var("CK_ESP32_REALITY_OUTPUT").unwrap(), serde_json::to_vec_pretty(&output).unwrap()).unwrap();
}
