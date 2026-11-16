//! Installed-environment ESP32-C3 production resource gate.  The test is
//! intentionally ignored by default because it requires the bundled Core and
//! toolchain; when enabled it exercises the same production compile observer
//! used by the application and compares observer OFF/ON outputs.
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
async fn esp32_c3_production_resource_gate() {
    let root = PathBuf::from(std::env::var("CK_ESP32_REALITY_ROOT").unwrap());
    let boards_path = root.join("packages/esp32/hardware/esp32/3.3.6/boards.txt");
    let boards = std::fs::read_to_string(&boards_path).unwrap();
    assert!(boards.contains("esp32c3.name=ESP32C3 Dev Module"));
    assert!(boards.contains("esp32c3.build.mcu=esp32c3"));
    assert!(boards.contains("esp32c3.build.variant=esp32c3"));
    assert!(boards.contains("esp32c3.build.f_cpu=160000000L"));
    let variant = std::fs::read_to_string(root.join("packages/esp32/hardware/esp32/3.3.6/variants/esp32c3/pins_arduino.h")).unwrap();
    assert!(variant.contains("static const uint8_t SDA = 8"));
    assert!(variant.contains("static const uint8_t SCL = 9"));
    let sysroot = Sysroot { root_dir: root.clone(), manifest: std::sync::Arc::new(tokio::sync::Mutex::new(crate::manifest::Manifest::default())) };
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("esp32_c3_gate");
    let build = tmp.path().join("build");
    let fqbn = "esp32:esp32:esp32c3";
    let code = "void setup(){pinMode(10,OUTPUT);Serial.begin(115200);} void loop(){digitalWrite(10,HIGH);analogWrite(10,128);Serial.println(analogRead(A0));}";
    let overrides = command_scoped_build_properties(&root, fqbn, CompileProfile::Release);
    let request = serde_json::json!({"code":code,"fqbn":fqbn,"options":overrides,"libraries":[],"profile":"Release","jobs":2});
    let request_before = request.clone();
    let without = resolve_runtime_tools_preflight_for_compile(&root, fqbn, &build, &project, "esp32_c3_gate.ino", &overrides, None).await.unwrap();
    let (with, identity) = crate::builder::resource_observation::capture(
        resolve_runtime_tools_preflight_for_compile(&root, fqbn, &build, &project, "esp32_c3_gate.ino", &overrides, None)
    ).await;
    assert_eq!(without, with.unwrap());
    let identity = identity.unwrap();
    assert_eq!(identity.fqbn, fqbn);
    assert_eq!(identity.mcu, "esp32c3");
    assert_eq!(identity.variant, "esp32c3");
    assert_eq!(identity.f_cpu, "160000000L");
    let signature = build_signature_for_code(&sysroot, fqbn, code);
    let off = compile_sketch_string(&sysroot, code, fqbn, &[], 2, &signature, None, CompileProfile::Release, CkExactReusePolicy::Deny, |_, _| {}, |_| {}).await.unwrap();
    let binaries = firmware_bytes(&off.0);
    assert!(!binaries.is_empty(), "ESP32-C3 compile must emit firmware artifacts");
    let (on, observed) = crate::builder::resource_observation::capture(
        compile_sketch_string(&sysroot, code, fqbn, &[], 2, &signature, None, CompileProfile::Release, CkExactReusePolicy::Deny, |_, _| {}, |_| {})
    ).await;
    let on = on.unwrap();
    assert_eq!(off.0, on.0);
    assert_eq!(binaries, firmware_bytes(&on.0), "firmware must be byte-identical");
    assert_eq!(observed.as_ref(), Some(&identity));
    assert_eq!(signature, build_signature_for_code(&sysroot, fqbn, code));
    assert_eq!(request, request_before);

    // Resource-affecting menus are resolved by the same production property
    // observer; they must not alter the compile identity path unexpectedly.
    let mut menu_reports = Vec::new();
    for (menu, value) in [("CDCOnBoot", "cdc"), ("JTAGAdapter", "builtin")] {
        let variant_fqbn = format!("{fqbn}:{menu}={value}");
        let variant_overrides = command_scoped_build_properties(&root, &variant_fqbn, CompileProfile::Release);
        let variant_request = serde_json::json!({"code":code,"fqbn":variant_fqbn,"options":variant_overrides,"libraries":[],"profile":"Release","jobs":2});
        let variant_request_before = variant_request.clone();
        let (_, observed) = crate::builder::resource_observation::capture(
            resolve_runtime_tools_preflight_for_compile(&root, &variant_fqbn, &build, &project, "esp32_c3_menu.ino", &variant_overrides, None)
        ).await;
        let observed = observed.unwrap();
        assert_eq!(observed.fqbn, variant_fqbn);
        assert_eq!(observed.options.get(menu).map(String::as_str), Some(value));
        let variant_signature = build_signature_for_code(&sysroot, &variant_fqbn, code);
        let variant_off = compile_sketch_string(&sysroot, code, &variant_fqbn, &[], 2, &variant_signature, None, CompileProfile::Release, CkExactReusePolicy::Deny, |_, _| {}, |_| {}).await.unwrap();
        let variant_binaries = firmware_bytes(&variant_off.0);
        assert!(!variant_binaries.is_empty(), "ESP32-C3 {menu}={value} compile must emit firmware artifacts");
        let (variant_on, variant_observed) = crate::builder::resource_observation::capture(
            compile_sketch_string(&sysroot, code, &variant_fqbn, &[], 2, &variant_signature, None, CompileProfile::Release, CkExactReusePolicy::Deny, |_, _| {}, |_| {})
        ).await;
        let variant_on = variant_on.unwrap();
        assert_eq!(variant_off.0, variant_on.0);
        assert_eq!(variant_binaries, firmware_bytes(&variant_on.0));
        assert_eq!(variant_observed.as_ref(), Some(&observed));
        assert_eq!(variant_signature, build_signature_for_code(&sysroot, &variant_fqbn, code));
        assert_eq!(variant_request, variant_request_before);
        let variant_hashes: std::collections::BTreeMap<_, _> = variant_binaries.iter().map(|(name, bytes)| (name, hex::encode(Sha256::digest(bytes)))).collect();
        menu_reports.push(serde_json::json!({
            "menu": menu,
            "value": value,
            "fqbn": variant_fqbn,
            "identity": observed,
            "requestUnchanged": true,
            "buildSignatureBefore": variant_signature,
            "buildSignatureAfter": build_signature_for_code(&sysroot, &variant_fqbn, code),
            "firmwareHashes": variant_hashes,
            "productionCompilePair": "PASS"
        }));
    }

    let hashes: std::collections::BTreeMap<_, _> = binaries.iter().map(|(name, bytes)| (name, hex::encode(Sha256::digest(bytes)))).collect();
    let output = serde_json::json!({
        "fqbn": fqbn,
        "identity": identity,
        "resourceMenus": ["CDCOnBoot", "JTAGAdapter"],
        "resourceMenuReports": menu_reports,
        "requestUnchanged": true,
        "productionCompilePair": "PASS",
        "firmwareHashes": hashes,
        "buildSignatureBefore": signature,
        "buildSignatureAfter": build_signature_for_code(&sysroot, fqbn, code)
    });
    std::fs::write(std::env::var("CK_ESP32_REALITY_OUTPUT").unwrap(), serde_json::to_vec_pretty(&output).unwrap()).unwrap();
}
