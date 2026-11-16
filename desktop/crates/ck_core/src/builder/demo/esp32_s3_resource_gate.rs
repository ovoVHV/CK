//! Installed-environment ESP32-S3 production resource gate.
//!
//! This ignored test exercises the same production compile -> ResolvedProps ->
//! resource-observation path used by CK.  It is deliberately test-only: no
//! compile or resource-analysis path is changed by this fixture.
use super::*;

fn firmware_bytes(build: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    std::fs::read_dir(build).unwrap().filter_map(Result::ok).filter_map(|entry| {
        let path = entry.path();
        matches!(path.extension().and_then(|x| x.to_str()), Some("bin") | Some("elf"))
            .then(|| (entry.file_name().to_string_lossy().to_string(), std::fs::read(path).unwrap()))
    }).collect()
}

#[tokio::test]
#[ignore = "requires installed ESP32-S3 Core; explicit CK_ESP32_REALITY_ROOT and output"]
async fn esp32_s3_production_resource_gate() {
    let root = PathBuf::from(std::env::var("CK_ESP32_REALITY_ROOT").unwrap());
    let boards_path = root.join("packages/esp32/hardware/esp32/3.3.6/boards.txt");
    let boards = std::fs::read_to_string(&boards_path).unwrap();
    assert!(boards.contains("esp32s3.name=ESP32S3 Dev Module"));
    assert!(boards.contains("esp32s3.build.mcu=esp32s3"));
    assert!(boards.contains("esp32s3.build.variant=esp32s3"));
    assert!(boards.contains("esp32s3.build.f_cpu=240000000L"));
    assert!(boards.contains("esp32s3-octal.build.mcu=esp32s3"));
    let variant = std::fs::read_to_string(root.join("packages/esp32/hardware/esp32/3.3.6/variants/esp32s3/pins_arduino.h")).unwrap();
    assert!(variant.contains("static const uint8_t SDA = 8"));
    assert!(variant.contains("static const uint8_t SCL = 9"));
    assert!(variant.contains("static const uint8_t SS = 10"));
    assert!(variant.contains("static const uint8_t SCK = 12"));

    let sysroot = Sysroot { root_dir: root.clone(), manifest: std::sync::Arc::new(tokio::sync::Mutex::new(crate::manifest::Manifest::default())) };
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("esp32_s3_gate");
    let build = tmp.path().join("build");
    let code = "void setup(){pinMode(13,OUTPUT);Serial.begin(115200);} void loop(){digitalWrite(13,HIGH);analogWrite(13,128);Serial.println(analogRead(A0));}";
    let fqbn = "esp32:esp32:esp32s3";
    let overrides = command_scoped_build_properties(&root, fqbn, CompileProfile::Release);
    let request = serde_json::json!({"code":code,"fqbn":fqbn,"options":overrides,"libraries":[],"profile":"Release","jobs":2});
    let request_before = request.clone();

    let without = resolve_runtime_tools_preflight_for_compile(&root, fqbn, &build, &project, "esp32_s3_gate.ino", &overrides, None).await.unwrap();
    let (with, identity) = crate::builder::resource_observation::capture(
        resolve_runtime_tools_preflight_for_compile(&root, fqbn, &build, &project, "esp32_s3_gate.ino", &overrides, None)
    ).await;
    assert_eq!(without, with.unwrap());
    let identity = identity.unwrap();
    assert_eq!(identity.fqbn, fqbn);
    assert_eq!(identity.mcu, "esp32s3");
    assert_eq!(identity.variant, "esp32s3");
    assert_eq!(identity.f_cpu, "240000000L");

    let signature = build_signature_for_code(&sysroot, fqbn, code);
    let off = compile_sketch_string(&sysroot, code, fqbn, &[], 2, &signature, None, CompileProfile::Release, CkExactReusePolicy::Deny, |_, _| {}, |_| {}).await.unwrap();
    let binaries = firmware_bytes(&off.0);
    assert!(!binaries.is_empty(), "ESP32-S3 compile must emit firmware artifacts");
    let (on, observed) = crate::builder::resource_observation::capture(
        compile_sketch_string(&sysroot, code, fqbn, &[], 2, &signature, None, CompileProfile::Release, CkExactReusePolicy::Deny, |_, _| {}, |_| {})
    ).await;
    let on = on.unwrap();
    assert_eq!(off.0, on.0);
    assert_eq!(binaries, firmware_bytes(&on.0), "firmware must be byte-identical");
    assert_eq!(observed.as_ref(), Some(&identity));
    assert_eq!(signature, build_signature_for_code(&sysroot, fqbn, code));
    assert_eq!(request, request_before);

    // A real menu-resolved identity must remain distinct and must still pass
    // the same observer path.  This also exercises conditional OPI/USB facts.
    let menu_fqbn = "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,CDCOnBoot=cdc,JTAGAdapter=builtin";
    let menu_overrides = command_scoped_build_properties(&root, menu_fqbn, CompileProfile::Release);
    let (_, menu_observed) = crate::builder::resource_observation::capture(
        resolve_runtime_tools_preflight_for_compile(&root, menu_fqbn, &build, &project, "esp32_s3_menu.ino", &menu_overrides, None)
    ).await;
    let menu_observed = menu_observed.unwrap();
    assert_eq!(menu_observed.fqbn, menu_fqbn);
    assert_eq!(menu_observed.mcu, "esp32s3");
    assert_eq!(menu_observed.variant, "esp32s3");
    assert_eq!(menu_observed.options.get("PSRAM").map(String::as_str), Some("opi"));
    assert_eq!(menu_observed.options.get("CDCOnBoot").map(String::as_str), Some("cdc"));
    let menu_signature = build_signature_for_code(&sysroot, menu_fqbn, code);
    let menu_off = compile_sketch_string(&sysroot, code, menu_fqbn, &[], 2, &menu_signature, None, CompileProfile::Release, CkExactReusePolicy::Deny, |_, _| {}, |_| {}).await.unwrap();
    let menu_binaries = firmware_bytes(&menu_off.0);
    assert!(!menu_binaries.is_empty(), "ESP32-S3 OPI compile must emit firmware artifacts");
    let (menu_on, menu_identity) = crate::builder::resource_observation::capture(
        compile_sketch_string(&sysroot, code, menu_fqbn, &[], 2, &menu_signature, None, CompileProfile::Release, CkExactReusePolicy::Deny, |_, _| {}, |_| {})
    ).await;
    let menu_on = menu_on.unwrap();
    assert_eq!(menu_off.0, menu_on.0);
    assert_eq!(menu_binaries, firmware_bytes(&menu_on.0));
    assert_eq!(menu_identity.as_ref(), Some(&menu_observed));
    assert_eq!(menu_signature, build_signature_for_code(&sysroot, menu_fqbn, code));

    let hashes: std::collections::BTreeMap<_, _> = binaries.iter().map(|(name, bytes)| (name, hex::encode(Sha256::digest(bytes)))).collect();
    let menu_hashes: std::collections::BTreeMap<_, _> = menu_binaries.iter().map(|(name, bytes)| (name, hex::encode(Sha256::digest(bytes)))).collect();
    let output = serde_json::json!({
        "fqbn": fqbn,
        "identity": identity,
        "menuIdentity": menu_observed,
        "requestUnchanged": true,
        "productionCompilePair": "PASS",
        "menuProductionCompilePair": "PASS",
        "firmwareHashes": hashes,
        "menuFirmwareHashes": menu_hashes,
        "buildSignatureBefore": signature,
        "buildSignatureAfter": build_signature_for_code(&sysroot, fqbn, code),
        "menuBuildSignatureBefore": menu_signature,
        "menuBuildSignatureAfter": build_signature_for_code(&sysroot, menu_fqbn, code)
    });
    std::fs::write(std::env::var("CK_ESP32_REALITY_OUTPUT").unwrap(), serde_json::to_vec_pretty(&output).unwrap()).unwrap();
}
