//! Installed-environment Nano gate, using the existing production compile/resolution path.
use super::*;

fn firmware_bytes(build: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    std::fs::read_dir(build).unwrap().filter_map(Result::ok).filter_map(|entry| {
        let path = entry.path();
        matches!(path.extension().and_then(|x| x.to_str()), Some("hex") | Some("elf"))
            .then(|| (entry.file_name().to_string_lossy().to_string(), std::fs::read(path).unwrap()))
    }).collect()
}

#[tokio::test]
#[ignore = "requires installed AVR Core; explicit CK_NANO_REALITY_ROOT and output"]
async fn nano_production_resource_gate() {
    let root = PathBuf::from(std::env::var("CK_NANO_REALITY_ROOT").unwrap());
    // Inventory only. Build properties are resolved exclusively by production code below.
    let version = std::env::var("CK_AVR_REALITY_VERSION").unwrap_or_else(|_| "1.8.8".into());
    let boards = std::fs::read_to_string(root.join(format!("packages/arduino/hardware/avr/{version}/boards.txt"))).unwrap();
    let processors: Vec<String> = boards.lines().filter_map(|line| {
        let rest = line.strip_prefix("nano.menu.cpu.")?;
        let (key, _) = rest.split_once('=')?;
        (!key.contains('.')).then(|| key.to_string())
    }).collect();
    assert!(!processors.is_empty());
    let sysroot = Sysroot { root_dir: root.clone(), manifest: std::sync::Arc::new(tokio::sync::Mutex::new(crate::manifest::Manifest::default())) };
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("nano_gate");
    let build = tmp.path().join("build");
    let code = "void setup(){pinMode(13,OUTPUT);Serial.begin(9600);} void loop(){digitalWrite(13,HIGH);analogWrite(3,128);analogWrite(9,128);Serial.println(analogRead(A6));}";
    let mut results = Vec::new();
    for cpu in &processors {
        let fqbn = format!("arduino:avr:nano:cpu={cpu}");
        let overrides = command_scoped_build_properties(&root, &fqbn, CompileProfile::Release);
        let request = serde_json::json!({"code":code,"fqbn":fqbn,"options":overrides,"libraries":[],"profile":"Release","jobs":2});
        let request_before = request.clone();
        let without = resolve_runtime_tools_preflight_for_compile(&root, &fqbn, &build, &project, "nano_gate.ino", &overrides, None).await.unwrap();
        let (with, identity) = crate::builder::resource_observation::capture(
            resolve_runtime_tools_preflight_for_compile(&root, &fqbn, &build, &project, "nano_gate.ino", &overrides, None)
        ).await;
        assert_eq!(without, with.unwrap());
        let identity = identity.unwrap();
        assert_eq!(identity.core_version, version);
        let signature = build_signature_for_code(&sysroot, &fqbn, code);
        let off = compile_sketch_string(&sysroot, code, &fqbn, &[], 2, &signature, None, CompileProfile::Release, CkExactReusePolicy::Deny, |_, _| {}, |_| {}).await.unwrap();
        let binaries = firmware_bytes(&off.0);
        assert!(!binaries.is_empty());
        let (on, observed) = crate::builder::resource_observation::capture(
            compile_sketch_string(&sysroot, code, &fqbn, &[], 2, &signature, None, CompileProfile::Release, CkExactReusePolicy::Deny, |_, _| {}, |_| {})
        ).await;
        let on = on.unwrap();
        assert_eq!(off.0, on.0);
        assert_eq!(binaries, firmware_bytes(&on.0), "firmware must be byte-identical: {fqbn}");
        assert_eq!(observed.as_ref(), Some(&identity));
        assert_eq!(signature, build_signature_for_code(&sysroot, &fqbn, code));
        assert_eq!(request, request_before);
        let mut rejected = serde_json::Map::new();
        for (label, key, value) in [("mcu", "build.mcu", "unknown_mcu"), ("variant", "build.variant", "standard"), ("fCpu", "build.f_cpu", "8000000L"), ("core", "runtime.platform.path", "C:/gate/avr/0.0.0")] {
            let mut changed = overrides.clone(); changed.push((key.into(), value.into()));
            let (_, observation) = crate::builder::resource_observation::capture(
                resolve_runtime_tools_preflight_for_compile(&root, &fqbn, &build, &project, "nano_gate.ino", &changed, None)
            ).await;
            rejected.insert(label.into(), serde_json::to_value(observation.unwrap()).unwrap());
        }
        let (_, menu) = crate::builder::resource_observation::capture(
            resolve_runtime_tools_preflight_for_compile(&root, &format!("{fqbn},unverified=1"), &build, &project, "nano_gate.ino", &overrides, None)
        ).await;
        rejected.insert("menu".into(), serde_json::to_value(menu.unwrap()).unwrap());
        // A capture with no resolution must never reuse the preceding compile's identity.
        let (_, empty) = crate::builder::resource_observation::capture(async {}).await;
        assert!(empty.is_none());
        let hashes: std::collections::BTreeMap<_, _> = binaries.iter().map(|(name, bytes)| (name, hex::encode(Sha256::digest(bytes)))).collect();
        results.push(serde_json::json!({"identity":identity,"rejected":rejected,"requestUnchanged":true,"productionCompilePair":"PASS","firmwareHashes":hashes,"buildSignatureBefore":signature,"buildSignatureAfter":build_signature_for_code(&sysroot,&fqbn,code)}));
    }
    let (_, default_identity) = crate::builder::resource_observation::capture(
        resolve_runtime_tools_preflight_for_compile(&root, "arduino:avr:nano", &build, &project, "nano_gate.ino", &[], None)
    ).await;
    let output = serde_json::json!({"processors":processors,"applicabilities":results,"defaultIdentity":default_identity.unwrap()});
    std::fs::write(std::env::var("CK_NANO_REALITY_OUTPUT").unwrap(), serde_json::to_vec_pretty(&output).unwrap()).unwrap();
}
