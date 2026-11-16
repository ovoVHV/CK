#[path = "../src/ck_forge.rs"]
mod ck_forge;

use ck_forge::{
    CK_FORGE_ENGINE_ID, CK_FORGE_PRODUCT_VERSION, CK_FORGE_SCHEMA_VERSION, ForgeCompatibilityInput,
    ForgeCorePackageIdentity,
    ForgeDecisionSource, ForgePerformanceEvidence, ForgePerformanceOperation,
    ForgePerformanceProfile, ForgeQualificationEvidence, ForgeQualificationStatus, ForgeReasonCode,
    ForgeRouteDecision, current_forge_contract_id, decide_forge_compatibility,
    decide_forge_compatibility_with_core_package_identity,
};
use sha2::{Digest, Sha256};

const TEST_HOST_IDENTITY: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const HISTORICAL_FAST_BUILD_CONTRACT_V8: &str = "ck-fast-build-contract-v8:command-scoped-ccache-O1-final-g0-no-lto-expanded-ccdb-core-deps-portable-response-guard";

fn test_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[test]
fn host_fingerprint_v2_has_a_fixed_cross_language_byte_vector() {
    let environment = std::collections::BTreeMap::from([
        ("COMPUTERNAME".to_string(), "CK-DEV".to_string()),
        ("NUMBER_OF_PROCESSORS".to_string(), "16".to_string()),
        ("PROCESSOR_ARCHITECTURE".to_string(), "AMD64".to_string()),
        (
            "PROCESSOR_IDENTIFIER".to_string(),
            "Intel64 Family 6 Model DEV".to_string(),
        ),
    ]);
    let expected = "ebe0f423a2fcaca0cca95fefdfda3db982be39f09dafbcf6f6f6b0a31a1241b5";
    assert_eq!(
        ck_forge::host_environment_fingerprint_from_parts(
            "win32",
            "x64",
            "//?/C:/Users/AI/Documents/CK/",
            &environment,
        ),
        expected
    );
    assert_eq!(
        ck_forge::host_environment_fingerprint_from_parts(
            "windows",
            "x86_64",
            r"c:\users\ai\documents\ck",
            &environment,
        ),
        expected
    );
}

#[test]
fn native_relink_rust_loader_requires_an_explicit_registered_adapter_contract() {
    let controls = serde_json::json!({
        "nativeRelinkAdapterId": "arduino-avr-native-relink-v1",
        "nativeRelinkEngineContractId": ck_forge::CK_FORGE_NATIVE_RELINK_COMPILE_ONLY_CONTRACT_ID,
        "artifactEquivalencePolicyId": "arduino-avr-hex-required-eeprom-optional-exact-v2"
    });
    assert!(ck_forge::native_relink_adapter_contract_matches(
        "arduino:avr:uno",
        Some("avr"),
        &controls
    ));
    assert!(!ck_forge::native_relink_adapter_contract_matches(
        "arduino:samd:mkrzero",
        Some("samd"),
        &controls
    ));
    let samd_controls = serde_json::json!({
        "nativeRelinkAdapterId": "arduino-samd-mkrzero-native-relink-v1",
        "nativeRelinkEngineContractId": "ck-native-relink-samd-release-compile-only-phase1-v1",
        "artifactEquivalencePolicyId": "arduino-samd-app-bin-hex-exact-ck-edit-no-bootloader-v2"
    });
    assert!(ck_forge::native_relink_adapter_contract_matches(
        "arduino:samd:mkrzero:usbstack=arduino",
        Some("samd"),
        &samd_controls
    ));
    for fqbn in [
        "arduino:samd:mkrzero_clone",
        "arduino:samd:mkrwifi1010",
        "arduino:samd:arduino_zero_native",
    ] {
        assert!(!ck_forge::native_relink_adapter_contract_matches(
            fqbn,
            Some("samd"),
            &samd_controls
        ));
    }
    for field in [
        "nativeRelinkAdapterId",
        "nativeRelinkEngineContractId",
        "artifactEquivalencePolicyId",
    ] {
        let mut tampered = controls.clone();
        tampered[field] = serde_json::json!("tampered");
        assert!(!ck_forge::native_relink_adapter_contract_matches(
            "arduino:avr:uno",
            Some("avr"),
            &tampered
        ));
    }
}

#[test]
fn node_runner_and_rust_loader_hash_the_same_real_host_root() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("canonical workspace root");
    let runner = root.join("scripts/Run-CKForgeNativeAB.cjs");
    let script = r#"const runner=require(process.argv[1]);process.stdout.write(runner.hostEnvironmentFingerprint(process.argv[2]));"#;
    let output = std::process::Command::new("node")
        .arg("-e")
        .arg(script)
        .arg(&runner)
        .arg(&root)
        .output()
        .expect("Node is required by the CK Forge qualification runner");
    assert!(
        output.status.success(),
        "Node fingerprint failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout)
            .expect("Node fingerprint UTF-8")
            .trim(),
        ck_forge::host_environment_fingerprint(&root)
    );
}

fn passing_performance() -> ForgePerformanceEvidence {
    passing_performance_for(
        ForgePerformanceOperation::Compile,
        ForgePerformanceProfile::QuickFast,
    )
}

fn passing_performance_for(
    operation: ForgePerformanceOperation,
    candidate_profile: ForgePerformanceProfile,
) -> ForgePerformanceEvidence {
    ForgePerformanceEvidence {
        operation,
        candidate_profile,
        host_identity_sha256: TEST_HOST_IDENTITY.to_string(),
        sample_set_sha256: "d".repeat(64),
        samples_per_lane: 5,
        native_fresh_median_ms: 10_000,
        candidate_fresh_median_ms: 7_500,
        native_repeat_median_ms: 5_000,
        candidate_repeat_median_ms: 3_500,
        native_fresh_p95_ms: 11_000,
        candidate_fresh_p95_ms: 9_500,
        native_repeat_p95_ms: 5_500,
        candidate_repeat_p95_ms: 4_500,
        native_fresh_cv_basis_points: 1_000,
        candidate_fresh_cv_basis_points: 1_000,
        native_repeat_cv_basis_points: 1_000,
        candidate_repeat_cv_basis_points: 1_000,
        artifact_equivalent: true,
        resource_equivalent: true,
        evidence_sha256: "a".repeat(64),
        artifact_set_sha256: "b".repeat(64),
    }
}

fn request<'a>(fqbn: &'a str, core_version: Option<&'a str>) -> ForgeCompatibilityInput<'a> {
    let toolchain_key =
        core_version.and_then(|version| ck_forge::builtin_expected_toolchain_key(fqbn, version));
    ForgeCompatibilityInput {
        fqbn,
        core_version,
        cli_version: Some("1.4.1"),
        toolchain_key,
        host_identity_sha256: Some(TEST_HOST_IDENTITY),
        qualification: None,
    }
}

fn qualification_manifest_json() -> serde_json::Value {
    serde_json::from_str(include_str!("../src/ck_forge_qualified_targets.v1.json"))
        .expect("CK Forge qualification manifest JSON")
}

fn qualification_manifest_matches_current_host() -> bool {
    let manifest = qualification_manifest_json();
    manifest["host_os"] == std::env::consts::OS && manifest["host_arch"] == std::env::consts::ARCH
}

#[test]
fn correctness_only_builtin_rows_do_not_claim_fast_without_performance_ab() {
    let manifest = qualification_manifest_json();
    let same_host = manifest["host_os"] == std::env::consts::OS
        && manifest["host_arch"] == std::env::consts::ARCH;
    for target in manifest["targets"].as_array().expect("target rows") {
        let fqbn = target["canonical_fqbn"].as_str().unwrap();
        let version = target["core_version"].as_str().unwrap();
        let toolchain_key = target["toolchain_key"].as_str().unwrap();
        let decision = decide_forge_compatibility(ForgeCompatibilityInput {
            fqbn,
            core_version: Some(version),
            cli_version: Some(manifest["arduino_cli_version"].as_str().unwrap()),
            toolchain_key: Some(toolchain_key),
            host_identity_sha256: Some(TEST_HOST_IDENTITY),
            qualification: None,
        });
        if same_host {
            assert_eq!(
                decision.decision,
                ForgeRouteDecision::ForcePlatform,
                "{fqbn}"
            );
            assert_eq!(decision.source, ForgeDecisionSource::ConservativeFallback);
            assert_eq!(
                decision.reason_codes,
                vec![ForgeReasonCode::BuiltinPerformanceQualificationMissing]
            );
        } else {
            assert_eq!(
                decision.decision,
                ForgeRouteDecision::ForcePlatform,
                "{fqbn}"
            );
            assert_eq!(
                decision.reason_codes,
                vec![ForgeReasonCode::UnverifiedHostPlatform]
            );
        }
    }
}

#[test]
fn builtin_qualification_is_a_machine_readable_unique_target_manifest() {
    let manifest = qualification_manifest_json();
    assert_eq!(manifest["schema_version"], 2);
    assert_eq!(manifest["engine_id"], "ck-forge/v1");
    assert_eq!(
        current_forge_contract_id(),
        ck_core::builder::demo::FAST_BUILD_CONTRACT_SIGNATURE_MARKER
    );
    assert_eq!(
        manifest["contract_id"].as_str(),
        Some(current_forge_contract_id()),
        "the shipped candidate manifest must be readable by the current builder/Forge contract"
    );
    let targets = manifest["targets"].as_array().expect("target rows");
    assert!(!targets.is_empty());
    let identities = targets
        .iter()
        .map(|target| {
            format!(
                "{}@{}",
                target["canonical_fqbn"].as_str().unwrap(),
                target["core_version"].as_str().unwrap()
            )
        })
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(identities.len(), targets.len());
    assert!(
        targets
            .iter()
            .all(|target| target.get("performance_ab").is_none()),
        "the migrated correctness matrix must not silently invent A/B evidence"
    );
    let parsed =
        ck_forge::parse_builtin_qualification_manifest(&serde_json::to_string(&manifest).unwrap())
            .expect("runtime manifest parser");
    assert!(ck_forge::builtin_manifest_matches_host(
        &parsed,
        manifest["host_os"].as_str().unwrap(),
        manifest["host_arch"].as_str().unwrap()
    ));
    assert!(!ck_forge::builtin_manifest_matches_host(
        &parsed,
        "other-os",
        manifest["host_arch"].as_str().unwrap()
    ));
}

#[test]
fn builtin_qualification_manifest_parser_fails_closed_on_identity_mutations() {
    let valid = qualification_manifest_json();
    let rejects = |value: serde_json::Value| {
        assert!(
            ck_forge::parse_builtin_qualification_manifest(&serde_json::to_string(&value).unwrap())
                .is_none()
        );
    };

    for (field, value) in [
        ("schema_version", serde_json::json!(1)),
        ("engine_id", serde_json::json!("other/v1")),
        ("contract_id", serde_json::json!("other-contract")),
        ("arduino_cli_version", serde_json::json!("1.4.2")),
        ("host_os", serde_json::json!("")),
        ("host_arch", serde_json::json!("")),
    ] {
        let mut mutated = valid.clone();
        mutated[field] = value;
        rejects(mutated);
    }

    let mut historical_v8 = valid.clone();
    historical_v8["contract_id"] = serde_json::json!(HISTORICAL_FAST_BUILD_CONTRACT_V8);
    rejects(historical_v8);

    let mut unknown_field = valid.clone();
    unknown_field["unexpected"] = serde_json::json!(true);
    rejects(unknown_field);

    let mut unknown_target_field = valid.clone();
    unknown_target_field["targets"][0]["unexpected"] = serde_json::json!(true);
    rejects(unknown_target_field);

    let mut invalid_performance = valid.clone();
    invalid_performance["targets"][0]["performance_ab"] = serde_json::json!([{
        "operation": "compile",
        "candidateProfile": "quick-fast",
        "hostIdentitySha256": TEST_HOST_IDENTITY,
        "sampleSetSha256": "d".repeat(64),
        "samplesPerLane": 5,
        "nativeFreshMedianMs": 10_000,
        "candidateFreshMedianMs": 11_000,
        "nativeRepeatMedianMs": 5_000,
        "candidateRepeatMedianMs": 4_000,
        "nativeFreshP95Ms": 11_000,
        "candidateFreshP95Ms": 11_500,
        "nativeRepeatP95Ms": 5_500,
        "candidateRepeatP95Ms": 4_500,
        "nativeFreshCvBasisPoints": 1_000,
        "candidateFreshCvBasisPoints": 1_000,
        "nativeRepeatCvBasisPoints": 1_000,
        "candidateRepeatCvBasisPoints": 1_000,
        "artifactEquivalent": true,
        "resourceEquivalent": true,
        "evidenceSha256": "a".repeat(64),
        "artifactSetSha256": "b".repeat(64),
    }]);
    rejects(invalid_performance);

    let mut valid_performance = valid.clone();
    valid_performance["targets"][0]["performance_ab"] = serde_json::json!([passing_performance()]);
    assert!(
        ck_forge::parse_builtin_qualification_manifest(
            &serde_json::to_string(&valid_performance).unwrap()
        )
        .is_some()
    );

    for (field, value) in [
        ("samplesPerLane", serde_json::json!(2)),
        ("samplesPerLane", serde_json::json!(26)),
        ("candidateFreshMedianMs", serde_json::json!(9_500)),
        ("candidateRepeatMedianMs", serde_json::json!(4_600)),
        ("candidateFreshP95Ms", serde_json::json!(12_000)),
        ("candidateRepeatP95Ms", serde_json::json!(6_000)),
        ("nativeFreshCvBasisPoints", serde_json::json!(2_001)),
        ("candidateFreshCvBasisPoints", serde_json::json!(2_001)),
        ("nativeRepeatCvBasisPoints", serde_json::json!(2_001)),
        ("candidateRepeatCvBasisPoints", serde_json::json!(2_001)),
        ("artifactEquivalent", serde_json::json!(false)),
        ("resourceEquivalent", serde_json::json!(false)),
        ("hostIdentitySha256", serde_json::json!("bad")),
        ("sampleSetSha256", serde_json::json!("bad")),
        ("evidenceSha256", serde_json::json!("bad")),
        ("evidenceSha256", serde_json::json!("A".repeat(64))),
        ("artifactSetSha256", serde_json::json!("bad")),
        ("artifactSetSha256", serde_json::json!("B".repeat(64))),
    ] {
        let mut failed_gate = valid_performance.clone();
        failed_gate["targets"][0]["performance_ab"][0][field] = value;
        rejects(failed_gate);
    }

    let mut unsupported_profile_operation = valid_performance.clone();
    unsupported_profile_operation["targets"][0]["performance_ab"][0]["candidateProfile"] =
        serde_json::json!("shared-fast");
    rejects(unsupported_profile_operation);

    let mut duplicate_capability = valid_performance.clone();
    let duplicate_evidence = duplicate_capability["targets"][0]["performance_ab"][0].clone();
    duplicate_capability["targets"][0]["performance_ab"]
        .as_array_mut()
        .unwrap()
        .push(duplicate_evidence);
    rejects(duplicate_capability);

    let mut saves_less_than_500ms = valid_performance.clone();
    saves_less_than_500ms["targets"][0]["performance_ab"][0]["nativeRepeatMedianMs"] =
        serde_json::json!(4_000);
    saves_less_than_500ms["targets"][0]["performance_ab"][0]["candidateRepeatMedianMs"] =
        serde_json::json!(3_600);
    saves_less_than_500ms["targets"][0]["performance_ab"][0]["nativeRepeatP95Ms"] =
        serde_json::json!(4_500);
    saves_less_than_500ms["targets"][0]["performance_ab"][0]["candidateRepeatP95Ms"] =
        serde_json::json!(4_000);
    rejects(saves_less_than_500ms);

    for field in ["canonical_fqbn", "core_version", "toolchain_key"] {
        let mut missing_target_field = valid.clone();
        missing_target_field["targets"][0]
            .as_object_mut()
            .unwrap()
            .remove(field);
        rejects(missing_target_field);
    }

    let mut duplicate = valid.clone();
    let first_target = duplicate["targets"][0].clone();
    duplicate["targets"]
        .as_array_mut()
        .unwrap()
        .push(first_target);
    rejects(duplicate);

    let mut noncanonical = valid.clone();
    let configured = noncanonical["targets"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|target| {
            target["canonical_fqbn"]
                .as_str()
                .unwrap()
                .contains("PartitionScheme=")
        })
        .unwrap();
    configured["canonical_fqbn"] =
        serde_json::json!("esp32:esp32:esp32c6:PartitionScheme=app3M_fat9M_16MB,FlashSize=16M");
    rejects(noncanonical);

    for malformed in [
        "esp32:esp32:esp32 c6",
        "esp32:esp32:esp32c6:Flash Size=16M",
        "esp32:esp32:esp32c6:FlashSize=16 M",
        "esp32:esp32:esp32c6:FlashSize=16M:extra",
        "esp32:esp32:esp32c6:FlashSize=16M,flashsize=8M",
    ] {
        let mut bad_fqbn = valid.clone();
        bad_fqbn["targets"][0]["canonical_fqbn"] = serde_json::json!(malformed);
        rejects(bad_fqbn);
    }

    for replacement in [
        "esp32|esp32|3.3.6|bad",
        "vendor|esp32|3.3.6|0000000000000000000000000000000000000000000000000000000000000000",
        "esp32|other|3.3.6|0000000000000000000000000000000000000000000000000000000000000000",
        "esp32|esp32|9.9.9|0000000000000000000000000000000000000000000000000000000000000000",
        "esp32|esp32|3.3.6|gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg",
    ] {
        let mut bad_key = valid.clone();
        bad_key["targets"][0]["toolchain_key"] = serde_json::json!(replacement);
        rejects(bad_key);
    }
}

#[test]
fn full_fqbn_options_are_canonicalized_but_only_qualified_combinations_are_fast() {
    let reordered = decide_forge_compatibility(request(
        "esp32:esp32:esp32c6:PartitionScheme=app3M_fat9M_16MB,FlashSize=16M",
        Some("3.3.6"),
    ));
    if qualification_manifest_matches_current_host() {
        assert_eq!(reordered.decision, ForgeRouteDecision::ForcePlatform);
        assert_eq!(
            reordered.reason_codes,
            vec![ForgeReasonCode::BuiltinPerformanceQualificationMissing]
        );
    } else {
        assert_eq!(reordered.decision, ForgeRouteDecision::ForcePlatform);
        assert_eq!(
            reordered.reason_codes,
            vec![ForgeReasonCode::UnverifiedHostPlatform]
        );
    }

    for fqbn in [
        "esp32:esp32:esp32c5:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=enabled",
        "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi",
        "esp32:esp32:esp32c6:FlashSize=8M",
        "arduino:avr:nano:cpu=atmega168",
    ] {
        let decision = decide_forge_compatibility(request(
            fqbn,
            Some(if fqbn.starts_with("arduino") {
                "1.8.6"
            } else {
                "3.3.6"
            }),
        ));
        assert_eq!(
            decision.decision,
            ForgeRouteDecision::ForcePlatform,
            "{fqbn}"
        );
        assert_eq!(
            decision.reason_codes,
            vec![ForgeReasonCode::UnverifiedBoardConfiguration],
            "{fqbn}"
        );
    }
}

#[test]
fn esp32_cn_label_matches_the_builtin_row_only_with_the_exact_archive_identity() {
    let fqbn = "esp32:esp32:esp32c6";
    let expected_toolchain = ck_forge::builtin_expected_toolchain_key(fqbn, "3.3.6")
        .expect("qualified C6 identity");
    let input = || ForgeCompatibilityInput {
        fqbn,
        core_version: Some("3.3.6-cn"),
        cli_version: Some("1.4.1"),
        toolchain_key: Some(expected_toolchain),
        host_identity_sha256: Some(TEST_HOST_IDENTITY),
        qualification: None,
    };

    for identity in [
        None,
        Some(ForgeCorePackageIdentity {
            archive_sha256: "0d0cf5e9062d5411470d216f5c24fcc3f269b3d23a8d7c4b34f981cc92e61755",
            archive_size: ck_forge::ESP32_3_3_6_ARCHIVE_SIZE,
        }),
        Some(ForgeCorePackageIdentity {
            archive_sha256: ck_forge::ESP32_3_3_6_ARCHIVE_SHA256,
            archive_size: ck_forge::ESP32_3_3_6_ARCHIVE_SIZE - 1,
        }),
    ] {
        let rejected = decide_forge_compatibility_with_core_package_identity(input(), identity);
        assert_eq!(rejected.decision, ForgeRouteDecision::ForcePlatform);
        assert_eq!(
            rejected.reason_codes,
            vec![ForgeReasonCode::UnverifiedCoreVersion]
        );
    }

    let proven = decide_forge_compatibility_with_core_package_identity(
        input(),
        Some(ForgeCorePackageIdentity {
            archive_sha256: ck_forge::ESP32_3_3_6_ARCHIVE_SHA256,
            archive_size: ck_forge::ESP32_3_3_6_ARCHIVE_SIZE,
        }),
    );
    assert_eq!(proven.decision, ForgeRouteDecision::ForcePlatform);
    assert_eq!(proven.core_version.as_deref(), Some("3.3.6-cn"));
    assert_eq!(
        proven.reason_codes,
        vec![if qualification_manifest_matches_current_host() {
            ForgeReasonCode::BuiltinPerformanceQualificationMissing
        } else {
            ForgeReasonCode::UnverifiedHostPlatform
        }]
    );
    assert!(ck_forge::core_package_identity_is_known_equivalent(
        fqbn,
        "3.3.6-cn",
        Some(ForgeCorePackageIdentity {
            archive_sha256: ck_forge::ESP32_3_3_6_ARCHIVE_SHA256,
            archive_size: ck_forge::ESP32_3_3_6_ARCHIVE_SIZE,
        })
    ));
    assert!(!ck_forge::core_package_identity_is_known_equivalent(
        "arduino:avr:uno",
        "3.3.6-cn",
        Some(ForgeCorePackageIdentity {
            archive_sha256: ck_forge::ESP32_3_3_6_ARCHIVE_SHA256,
            archive_size: ck_forge::ESP32_3_3_6_ARCHIVE_SIZE,
        })
    ));
}

#[test]
fn esp32_cn_archive_identity_never_aliases_a_local_336_certificate() {
    let evidence = ForgeQualificationEvidence {
        status: ForgeQualificationStatus::Passed,
        canonical_fqbn: "esp32:esp32:esp32c6".to_string(),
        core_version: "3.3.6".to_string(),
        cli_version: "1.4.1".to_string(),
        toolchain_key: "esp32|esp32|3.3.6|qualified-content".to_string(),
        contract_id: current_forge_contract_id().to_string(),
        performance_ab: vec![passing_performance()],
    };
    let decision = decide_forge_compatibility_with_core_package_identity(
        ForgeCompatibilityInput {
            fqbn: "esp32:esp32:esp32c6",
            core_version: Some("3.3.6-cn"),
            cli_version: Some("1.4.1"),
            toolchain_key: Some("esp32|esp32|3.3.6-cn|different-identity"),
            host_identity_sha256: Some(TEST_HOST_IDENTITY),
            qualification: Some(&evidence),
        },
        Some(ForgeCorePackageIdentity {
            archive_sha256: ck_forge::ESP32_3_3_6_ARCHIVE_SHA256,
            archive_size: ck_forge::ESP32_3_3_6_ARCHIVE_SIZE,
        }),
    );
    assert_eq!(decision.decision, ForgeRouteDecision::ForcePlatform);
    assert!(
        decision
            .reason_codes
            .contains(&ForgeReasonCode::QualificationCoreVersionMismatch)
    );
    assert!(
        decision
            .reason_codes
            .contains(&ForgeReasonCode::QualificationToolchainMismatch)
    );
}

#[test]
fn builtin_identity_alone_never_unlocks_fast() {
    if !qualification_manifest_matches_current_host() {
        return;
    }
    let expected = ck_forge::builtin_expected_toolchain_key("esp32:esp32:esp32c6", "3.3.6")
        .expect("qualified C6 identity");
    for cli_version in ["1.4.10", "1.4.11", "arduino-cli Version: 1.4.10 Commit: x"] {
        let decision = decide_forge_compatibility(ForgeCompatibilityInput {
            fqbn: "esp32:esp32:esp32c6",
            core_version: Some("3.3.6"),
            cli_version: Some(cli_version),
            toolchain_key: Some(expected),
            host_identity_sha256: Some(TEST_HOST_IDENTITY),
            qualification: None,
        });
        assert_eq!(decision.decision, ForgeRouteDecision::ForcePlatform);
        assert_eq!(
            decision.reason_codes,
            vec![ForgeReasonCode::BuiltinPerformanceQualificationMissing]
        );
    }

    let qualified = decide_forge_compatibility(ForgeCompatibilityInput {
        fqbn: "esp32:esp32:esp32c6",
        core_version: Some("3.3.6"),
        cli_version: Some("arduino-cli Version: 1.4.1 Commit: x Date: local"),
        toolchain_key: Some(expected),
        host_identity_sha256: Some(TEST_HOST_IDENTITY),
        qualification: None,
    });
    assert_eq!(qualified.decision, ForgeRouteDecision::ForcePlatform);
    assert_eq!(
        qualified.reason_codes,
        vec![ForgeReasonCode::BuiltinPerformanceQualificationMissing]
    );
}

#[test]
fn builtin_correctness_row_does_not_become_fast_when_identity_is_partial() {
    if !qualification_manifest_matches_current_host() {
        return;
    }
    let expected = ck_forge::builtin_expected_toolchain_key("esp32:esp32:esp32c6", "3.3.6")
        .expect("qualified C6 identity");
    let missing_cli = decide_forge_compatibility(ForgeCompatibilityInput {
        fqbn: "esp32:esp32:esp32c6",
        core_version: Some("3.3.6"),
        cli_version: None,
        toolchain_key: Some(expected),
        host_identity_sha256: Some(TEST_HOST_IDENTITY),
        qualification: None,
    });
    assert_eq!(missing_cli.decision, ForgeRouteDecision::ForcePlatform);
    assert_eq!(
        missing_cli.reason_codes,
        vec![ForgeReasonCode::BuiltinPerformanceQualificationMissing]
    );

    let missing_toolchain = decide_forge_compatibility(ForgeCompatibilityInput {
        fqbn: "esp32:esp32:esp32c6",
        core_version: Some("3.3.6"),
        cli_version: Some("1.4.1"),
        toolchain_key: None,
        host_identity_sha256: Some(TEST_HOST_IDENTITY),
        qualification: None,
    });
    assert_eq!(
        missing_toolchain.decision,
        ForgeRouteDecision::ForcePlatform
    );
    assert_eq!(
        missing_toolchain.reason_codes,
        vec![ForgeReasonCode::BuiltinPerformanceQualificationMissing]
    );

    assert!(!ck_forge::is_builtin_forge_candidate(
        "esp32:esp32:esp32c6",
        Some("3.3.6"),
        Some(TEST_HOST_IDENTITY),
    ));
    assert!(!ck_forge::is_builtin_forge_candidate(
        "esp32:esp32:third_party_board",
        Some("3.3.6"),
        Some(TEST_HOST_IDENTITY),
    ));
}

#[test]
fn an_unqualified_board_id_on_a_known_core_is_not_platform_wide_allowlisted() {
    for (fqbn, version) in [
        ("esp32:esp32:third_party_board", "3.3.6"),
        ("arduino:avr:leonardo", "1.8.6"),
        ("esp8266:esp8266:generic", "3.1.2"),
    ] {
        let decision = decide_forge_compatibility(request(fqbn, Some(version)));
        assert_eq!(decision.decision, ForgeRouteDecision::ForcePlatform);
        assert_eq!(decision.source, ForgeDecisionSource::ConservativeFallback);
        assert_eq!(
            decision.reason_codes,
            vec![ForgeReasonCode::UnverifiedBoardTarget]
        );
    }
}

#[test]
fn builtin_matrix_requires_performance_evidence_before_toolchain_identity_can_promote_it() {
    if !qualification_manifest_matches_current_host() {
        return;
    }
    let expected = ck_forge::builtin_expected_toolchain_key("esp32:esp32:esp32c6", "3.3.6")
        .expect("qualified C6 identity");
    let verified = decide_forge_compatibility(ForgeCompatibilityInput {
        fqbn: "esp32:esp32:esp32c6",
        core_version: Some("3.3.6"),
        cli_version: Some("arduino-cli Version: 1.4.1 Commit: local"),
        toolchain_key: Some(expected),
        host_identity_sha256: Some(TEST_HOST_IDENTITY),
        qualification: None,
    });
    assert_eq!(verified.decision, ForgeRouteDecision::ForcePlatform);
    assert_eq!(
        verified.reason_codes,
        vec![ForgeReasonCode::BuiltinPerformanceQualificationMissing]
    );

    let modified_in_place = decide_forge_compatibility(ForgeCompatibilityInput {
        fqbn: "esp32:esp32:esp32c6",
        core_version: Some("3.3.6"),
        cli_version: Some("1.4.1"),
        toolchain_key: Some("esp32|esp32|3.3.6|modified-content"),
        host_identity_sha256: Some(TEST_HOST_IDENTITY),
        qualification: None,
    });
    assert_eq!(
        modified_in_place.decision,
        ForgeRouteDecision::ForcePlatform
    );
    assert_eq!(
        modified_in_place.reason_codes,
        vec![ForgeReasonCode::BuiltinPerformanceQualificationMissing]
    );
}

#[test]
fn local_qualification_can_unlock_an_unlisted_board_on_a_known_core() {
    let evidence = ForgeQualificationEvidence {
        status: ForgeQualificationStatus::Passed,
        canonical_fqbn: "esp32:esp32:third_party_board:FlashSize=8M".to_string(),
        core_version: "3.3.6".to_string(),
        cli_version: "1.4.1".to_string(),
        toolchain_key: "esp32|esp32|3.3.6|qualified-content".to_string(),
        contract_id: current_forge_contract_id().to_string(),
        performance_ab: vec![passing_performance()],
    };
    let decision = decide_forge_compatibility(ForgeCompatibilityInput {
        fqbn: "esp32:esp32:third_party_board:FlashSize=8M",
        core_version: Some("3.3.6"),
        cli_version: Some("1.4.1"),
        toolchain_key: Some("esp32|esp32|3.3.6|qualified-content"),
        host_identity_sha256: Some(TEST_HOST_IDENTITY),
        qualification: Some(&evidence),
    });
    assert_eq!(decision.decision, ForgeRouteDecision::AllowFast);
    assert_eq!(decision.source, ForgeDecisionSource::LocalQualification);
    assert!(decision.allows(
        ForgePerformanceOperation::Compile,
        ForgePerformanceProfile::QuickFast
    ));
    assert!(!decision.allows(
        ForgePerformanceOperation::UploadReady,
        ForgePerformanceProfile::QuickFast
    ));
    assert!(!decision.allows(
        ForgePerformanceOperation::UploadReady,
        ForgePerformanceProfile::SharedFast
    ));
}

#[test]
fn historical_v8_local_evidence_cannot_authorize_the_current_v9_runtime() {
    let evidence = ForgeQualificationEvidence {
        status: ForgeQualificationStatus::Passed,
        canonical_fqbn: "vendor:arch:custom".to_string(),
        core_version: "1.0.0".to_string(),
        cli_version: "1.4.1".to_string(),
        toolchain_key: "vendor|arch|1.0.0|content".to_string(),
        contract_id: HISTORICAL_FAST_BUILD_CONTRACT_V8.to_string(),
        performance_ab: vec![passing_performance()],
    };
    let decision = decide_forge_compatibility(ForgeCompatibilityInput {
        fqbn: "vendor:arch:custom",
        core_version: Some("1.0.0"),
        cli_version: Some("1.4.1"),
        toolchain_key: Some("vendor|arch|1.0.0|content"),
        host_identity_sha256: Some(TEST_HOST_IDENTITY),
        qualification: Some(&evidence),
    });

    assert_eq!(decision.decision, ForgeRouteDecision::ForcePlatform);
    assert_eq!(decision.source, ForgeDecisionSource::ConservativeFallback);
    assert_eq!(
        decision.reason_codes,
        vec![ForgeReasonCode::QualificationContractMismatch]
    );
    assert!(!decision.capabilities.any());
}

#[test]
fn performance_evidence_is_bound_to_operation_profile_and_machine() {
    let base = ForgeQualificationEvidence {
        status: ForgeQualificationStatus::Passed,
        canonical_fqbn: "vendor:arch:custom".to_string(),
        core_version: "1.0.0".to_string(),
        cli_version: "1.4.1".to_string(),
        toolchain_key: "vendor|arch|1.0.0|content".to_string(),
        contract_id: current_forge_contract_id().to_string(),
        performance_ab: vec![passing_performance_for(
            ForgePerformanceOperation::UploadReady,
            ForgePerformanceProfile::SharedFast,
        )],
    };
    let decide = |evidence: &ForgeQualificationEvidence, host: Option<&str>| {
        decide_forge_compatibility(ForgeCompatibilityInput {
            fqbn: "vendor:arch:custom",
            core_version: Some("1.0.0"),
            cli_version: Some("1.4.1"),
            toolchain_key: Some("vendor|arch|1.0.0|content"),
            host_identity_sha256: host,
            qualification: Some(evidence),
        })
    };

    let shared_upload_only = decide(&base, Some(TEST_HOST_IDENTITY));
    assert_eq!(shared_upload_only.decision, ForgeRouteDecision::AllowFast);
    assert!(!shared_upload_only.allows(
        ForgePerformanceOperation::Compile,
        ForgePerformanceProfile::QuickFast
    ));
    assert!(!shared_upload_only.allows(
        ForgePerformanceOperation::UploadReady,
        ForgePerformanceProfile::QuickFast
    ));
    assert!(shared_upload_only.allows(
        ForgePerformanceOperation::UploadReady,
        ForgePerformanceProfile::SharedFast
    ));

    let missing_host = decide(&base, None);
    assert_eq!(missing_host.decision, ForgeRouteDecision::ForcePlatform);
    assert_eq!(
        missing_host.reason_codes,
        vec![ForgeReasonCode::QualificationHostIdentityUnavailable]
    );

    let other_host = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    let mismatched_host = decide(&base, Some(other_host));
    assert_eq!(mismatched_host.decision, ForgeRouteDecision::ForcePlatform);
    assert_eq!(
        mismatched_host.reason_codes,
        vec![ForgeReasonCode::QualificationHostIdentityMismatch]
    );
}

#[test]
fn local_correctness_certificate_without_non_regressing_ab_stays_native() {
    let mut evidence = ForgeQualificationEvidence {
        status: ForgeQualificationStatus::Passed,
        canonical_fqbn: "vendor:arch:custom".to_string(),
        core_version: "1.0.0".to_string(),
        cli_version: "1.4.1".to_string(),
        toolchain_key: "vendor|arch|1.0.0|content".to_string(),
        contract_id: current_forge_contract_id().to_string(),
        performance_ab: Vec::new(),
    };
    let decide = |evidence: &ForgeQualificationEvidence| {
        decide_forge_compatibility(ForgeCompatibilityInput {
            fqbn: "vendor:arch:custom",
            core_version: Some("1.0.0"),
            cli_version: Some("1.4.1"),
            toolchain_key: Some("vendor|arch|1.0.0|content"),
            host_identity_sha256: Some(TEST_HOST_IDENTITY),
            qualification: Some(evidence),
        })
    };
    let missing = decide(&evidence);
    assert_eq!(missing.decision, ForgeRouteDecision::ForcePlatform);
    assert_eq!(
        missing.reason_codes,
        vec![ForgeReasonCode::QualificationPerformanceUnavailable]
    );

    let mut regressing = passing_performance();
    regressing.candidate_fresh_median_ms = regressing.native_fresh_median_ms + 1;
    evidence.performance_ab = vec![regressing];
    let slower = decide(&evidence);
    assert_eq!(slower.decision, ForgeRouteDecision::ForcePlatform);
    assert_eq!(
        slower.reason_codes,
        vec![ForgeReasonCode::QualificationPerformanceRegression]
    );
}

#[test]
fn version_updates_downgrade_to_platform_routing_instead_of_blocking() {
    for (fqbn, version) in [
        ("esp32:esp32:esp32c6", "3.3.7"),
        ("arduino:avr:uno", "1.8.7"),
        ("esp8266:esp8266:nodemcuv2", "3.2.0"),
    ] {
        let decision = decide_forge_compatibility(request(fqbn, Some(version)));
        assert_eq!(decision.decision, ForgeRouteDecision::ForcePlatform);
        assert_ne!(decision.decision, ForgeRouteDecision::Block);
        assert_eq!(
            decision.reason_codes,
            vec![ForgeReasonCode::UnverifiedCoreVersion]
        );
    }
}

#[test]
fn core_agnostic_contract_keeps_new_versions_on_native_lane_until_qualified() {
    // A new Core is a compatibility warning, not a reason to reuse another
    // Core's Fast Relink objects.  This deliberately spans the common
    // families and a completely external vendor so the contract cannot grow
    // an accidental ESP32-only allow-list.
    for (fqbn, version) in [
        ("esp32:esp32:esp32c6", "3.3.7"),
        ("stm32:stm32:generic", "2.7.0"),
        ("arduino:avr:uno", "1.8.7"),
        ("rp2040:rp2040:generic", "4.2.0"),
    ] {
        let decision = decide_forge_compatibility(ForgeCompatibilityInput {
            fqbn,
            core_version: Some(version),
            cli_version: Some("1.4.1"),
            // A syntactically plausible identity is not qualification.  The
            // exact Core/toolchain pair must be proven by the local workflow.
            toolchain_key: Some("vendor|arch|version|unqualified"),
            host_identity_sha256: Some(TEST_HOST_IDENTITY),
            qualification: None,
        });
        assert_eq!(
            decision.decision,
            ForgeRouteDecision::ForcePlatform,
            "{fqbn}"
        );
        assert_ne!(decision.decision, ForgeRouteDecision::Block, "{fqbn}");
        assert_eq!(decision.source, ForgeDecisionSource::ConservativeFallback);
    }
}

#[test]
fn a_matching_local_certificate_can_enable_fast_for_any_core_family_and_version() {
    // The built-in matrix is only a shipped evidence set.  A local
    // qualification certificate is intentionally the extensibility seam for
    // STM32, AVR updates, third-party boards, and future Core releases.
    for (fqbn, version, toolchain) in [
        (
            "esp32:esp32:esp32c6:FlashSize=16M",
            "3.3.7",
            "esp32|esp32|3.3.7|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
        (
            "stm32:stm32:generic:UploadMethod=dfu",
            "2.7.0",
            "stm32|stm32|2.7.0|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ),
        (
            "arduino:avr:uno",
            "1.8.7",
            "arduino|avr|1.8.7|cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        ),
    ] {
        let evidence = ForgeQualificationEvidence {
            status: ForgeQualificationStatus::Passed,
            canonical_fqbn: fqbn.to_string(),
            core_version: version.to_string(),
            cli_version: "1.4.1".to_string(),
            toolchain_key: toolchain.to_string(),
            contract_id: current_forge_contract_id().to_string(),
            performance_ab: vec![passing_performance()],
        };
        let decision = decide_forge_compatibility(ForgeCompatibilityInput {
            fqbn,
            core_version: Some(version),
            cli_version: Some("1.4.1"),
            toolchain_key: Some(toolchain),
            host_identity_sha256: Some(TEST_HOST_IDENTITY),
            qualification: Some(&evidence),
        });
        assert_eq!(decision.decision, ForgeRouteDecision::AllowFast, "{fqbn}");
        assert_eq!(decision.source, ForgeDecisionSource::LocalQualification);
        assert_eq!(
            decision.reason_codes,
            vec![ForgeReasonCode::LocalQualificationMatched]
        );
    }
}

#[test]
fn unknown_and_malformed_targets_fail_closed_only_for_fast_routing() {
    let unknown = decide_forge_compatibility(request("vendor:arch:custom", Some("1.0.0")));
    assert_eq!(unknown.decision, ForgeRouteDecision::ForcePlatform);
    assert_eq!(unknown.reason_codes, vec![ForgeReasonCode::UnknownPlatform]);

    for malformed in [
        "",
        "esp32:esp32",
        "esp32::board",
        "vendor:arch:board:bad",
        "vendor:arch:board name",
        "vendor:arch:board:Menu Key=value",
        "vendor:arch:board:Menu=value with spaces",
        "vendor:arch:board:Menu=value,menu=other",
        "vendor:arch:board:Menu=value:extra",
    ] {
        let decision = decide_forge_compatibility(request(malformed, Some("1.0.0")));
        assert_eq!(decision.decision, ForgeRouteDecision::ForcePlatform);
        assert_eq!(decision.reason_codes, vec![ForgeReasonCode::MalformedFqbn]);
    }
}

#[test]
fn missing_or_invalid_core_versions_use_the_platform_path() {
    let missing = decide_forge_compatibility(request("esp32:esp32:esp32c6", None));
    assert_eq!(missing.decision, ForgeRouteDecision::ForcePlatform);
    assert_eq!(
        missing.reason_codes,
        vec![ForgeReasonCode::MissingCoreVersion]
    );

    let invalid =
        decide_forge_compatibility(request("esp32:esp32:esp32c6", Some("locally-patched")));
    assert_eq!(invalid.decision, ForgeRouteDecision::ForcePlatform);
    assert_eq!(
        invalid.reason_codes,
        vec![ForgeReasonCode::InvalidCoreVersion]
    );
}

#[test]
fn matching_local_evidence_can_extend_fast_routing_without_a_code_change() {
    let evidence = ForgeQualificationEvidence {
        status: ForgeQualificationStatus::Passed,
        canonical_fqbn: "vendor:arch:custom:Memory=large".to_string(),
        core_version: "2.4.1".to_string(),
        cli_version: "2.3.0".to_string(),
        toolchain_key: "vendor|arch|2.4.1|sha256".to_string(),
        contract_id: current_forge_contract_id().to_string(),
        performance_ab: vec![passing_performance()],
    };
    let decision = decide_forge_compatibility(ForgeCompatibilityInput {
        fqbn: "vendor:arch:custom:Memory=large",
        core_version: Some("2.4.1"),
        cli_version: Some("2.3.0"),
        toolchain_key: Some("vendor|arch|2.4.1|sha256"),
        host_identity_sha256: Some(TEST_HOST_IDENTITY),
        qualification: Some(&evidence),
    });
    assert_eq!(decision.decision, ForgeRouteDecision::AllowFast);
    assert_eq!(decision.source, ForgeDecisionSource::LocalQualification);
    assert_eq!(
        decision.reason_codes,
        vec![ForgeReasonCode::LocalQualificationMatched]
    );
}

#[test]
fn local_evidence_is_bound_to_target_core_toolchain_contract_and_status() {
    let evidence = ForgeQualificationEvidence {
        status: ForgeQualificationStatus::Expired,
        canonical_fqbn: "vendor:arch:other".to_string(),
        core_version: "2.4.0".to_string(),
        cli_version: "2.3.9".to_string(),
        toolchain_key: "old-toolchain".to_string(),
        contract_id: "old-contract".to_string(),
        performance_ab: vec![passing_performance()],
    };
    let decision = decide_forge_compatibility(ForgeCompatibilityInput {
        fqbn: "vendor:arch:custom",
        core_version: Some("2.4.1"),
        cli_version: Some("2.4.0"),
        toolchain_key: Some("current-toolchain"),
        host_identity_sha256: Some(TEST_HOST_IDENTITY),
        qualification: Some(&evidence),
    });
    assert_eq!(decision.decision, ForgeRouteDecision::ForcePlatform);
    assert_eq!(
        decision.reason_codes,
        vec![
            ForgeReasonCode::QualificationNotPassed,
            ForgeReasonCode::QualificationFqbnMismatch,
            ForgeReasonCode::QualificationCoreVersionMismatch,
            ForgeReasonCode::QualificationCliVersionMismatch,
            ForgeReasonCode::QualificationContractMismatch,
            ForgeReasonCode::QualificationToolchainMismatch,
        ]
    );

    let mut otherwise_matching = evidence.clone();
    otherwise_matching.status = ForgeQualificationStatus::Passed;
    otherwise_matching.canonical_fqbn = "vendor:arch:custom".to_string();
    otherwise_matching.core_version = "2.4.1".to_string();
    otherwise_matching.cli_version = "2.4.0".to_string();
    otherwise_matching.toolchain_key = "current-toolchain".to_string();
    otherwise_matching.contract_id = current_forge_contract_id().to_string();
    let no_current_toolchain = decide_forge_compatibility(ForgeCompatibilityInput {
        fqbn: "vendor:arch:custom",
        core_version: Some("2.4.1"),
        cli_version: Some("2.4.0"),
        toolchain_key: None,
        host_identity_sha256: Some(TEST_HOST_IDENTITY),
        qualification: Some(&otherwise_matching),
    });
    assert_eq!(
        no_current_toolchain.reason_codes,
        vec![ForgeReasonCode::QualificationToolchainUnavailable]
    );
}

#[test]
fn additive_identity_serializes_without_renaming_existing_profile_contracts() {
    let decision = decide_forge_compatibility(request("esp32:esp32:esp32c6", Some("3.3.6")));
    let json = serde_json::to_value(decision).expect("serialize CK Forge decision");
    assert_eq!(json["engine"]["id"], CK_FORGE_ENGINE_ID);
    assert_eq!(json["engine"]["schemaVersion"], CK_FORGE_SCHEMA_VERSION);
    assert_eq!(json["engine"]["productVersion"], CK_FORGE_PRODUCT_VERSION);
    assert_eq!(json["engine"]["contractId"], current_forge_contract_id());
    if qualification_manifest_matches_current_host() {
        assert_eq!(json["decision"], "force-platform");
        assert_eq!(json["source"], "conservative-fallback");
        assert_eq!(
            json["reasonCodes"][0],
            "builtin-performance-qualification-missing"
        );
    } else {
        assert_eq!(json["decision"], "force-platform");
        assert_eq!(json["reasonCodes"][0], "unverified-host-platform");
    }
    assert!(json.get("profile").is_none());
    assert!(json.get("buildMode").is_none());
}

#[test]
fn failed_local_qualification_is_never_promoted() {
    for status in [
        ForgeQualificationStatus::Failed,
        ForgeQualificationStatus::Expired,
    ] {
        let evidence = ForgeQualificationEvidence {
            status,
            canonical_fqbn: "vendor:arch:custom".to_string(),
            core_version: "1.0.0".to_string(),
            cli_version: "1.4.1".to_string(),
            toolchain_key: "toolchain".to_string(),
            contract_id: current_forge_contract_id().to_string(),
            performance_ab: vec![passing_performance()],
        };
        let decision = decide_forge_compatibility(ForgeCompatibilityInput {
            fqbn: "vendor:arch:custom",
            core_version: Some("1.0.0"),
            cli_version: Some("1.4.1"),
            toolchain_key: Some("toolchain"),
            host_identity_sha256: Some(TEST_HOST_IDENTITY),
            qualification: Some(&evidence),
        });
        assert_eq!(decision.decision, ForgeRouteDecision::ForcePlatform);
        assert_eq!(
            decision.reason_codes,
            vec![ForgeReasonCode::QualificationNotPassed]
        );
    }
}

#[test]
fn local_certificate_loader_recomputes_samples_report_cli_host_source_and_artifacts() {
    let root = std::env::temp_dir().join(format!(
        "ck-forge-local-certificate-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let cli_path = if cfg!(windows) {
        bin.join("arduino-cli.exe")
    } else {
        bin.join("arduino-cli")
    };
    let cli_bytes = b"fixture-cli-v2";
    std::fs::write(&cli_path, cli_bytes).unwrap();
    let cli_config_bytes = b"directories:\n  data: fixture-data\n";
    std::fs::write(root.join("arduino-cli-fast.yaml"), cli_config_bytes).unwrap();

    let fqbn = "vendor:arch:custom";
    let core_version = "1.0.0";
    let cli_version = "1.4.1";
    let toolchain_content_sha256 = test_sha256(b"fixture-core-and-toolchain-content");
    let toolchain_key = format!("vendor|arch|1.0.0|{toolchain_content_sha256}");
    let sketch_sha256 =
        "9957ed4144a4dcb3ea6918ae021976812dda56d4da3815ef92ca29682e0fa0b5".to_string();
    let host_identity = ck_forge::host_environment_fingerprint(&root);
    let cli_sha256 = test_sha256(cli_bytes);
    let cli_config_sha256 = test_sha256(cli_config_bytes);
    let native_baseline_compiler_properties_sha256 =
        test_sha256(b"fixture-native-compiler-properties");
    let production_executable_sha256 = test_sha256(
        &std::fs::read(std::env::current_exe().expect("current test executable")).unwrap(),
    );

    let artifact_bytes = b"fixture-firmware";
    let artifact_manifest = serde_json::json!({
        "schemaId": "ck.forge.qualification-artifact-set",
        "schemaVersion": 1,
        "artifacts": [{
            "path": "artifacts/firmware.bin",
            "size": artifact_bytes.len(),
            "sha256": test_sha256(artifact_bytes),
        }],
    });
    let artifact_manifest_bytes = serde_json::to_vec_pretty(&artifact_manifest).unwrap();
    let artifact_manifest_sha256 = test_sha256(&artifact_manifest_bytes);
    let controls = serde_json::json!({
        "compileOnly": true,
        "uploadPerformed": false,
        "physicalFlashWritten": false,
        "serialPortAccessed": false,
        "sameMachine": true,
        "freshBuildPathsVerified": true,
        "sameBuildPathWithinLaneVerified": true,
        "stageSourceHashesVerified": true,
        "exactReuseDenied": true,
        "routeGatePassed": true,
        "recipeCapabilityGatePassed": true,
        "globalCachesSharedEqually": true,
        "noConcurrentCompiles": true,
        "laneBoundaryIdleGatePassed": true,
        "compilePropertyDeltaDeclared": true,
        "dependencyClosureGatePassed": true,
        "artifactGatePassed": true,
        "resourceGatePassed": true,
    });
    let identity = serde_json::json!({
        "fqbn": fqbn,
        "corePackage": "vendor",
        "coreArchitecture": "arch",
        "coreVersion": core_version,
        "toolchainKey": toolchain_key,
        "toolchainContentSha256": toolchain_content_sha256,
        "sketchSha256": sketch_sha256,
        "cliExecutableSha256": cli_sha256,
        "cliConfigSha256": cli_config_sha256,
        "cliVersion": cli_version,
        "hostIdentitySha256": host_identity,
        "productionExecutableSha256": production_executable_sha256,
    });
    let stages = serde_json::json!([
        {
            "id": "simple",
            "sourceSha256": "9957ed4144a4dcb3ea6918ae021976812dda56d4da3815ef92ca29682e0fa0b5"
        },
        {
            "id": "complex",
            "sourceSha256": "ea468a750d243cc9a5a801d7bcd66a87e8daa2fdb535a783896fef99b0a0266e"
        },
        {
            "id": "medium",
            "sourceSha256": "1e41189bc6e324ef3e72a08adfceef99ed1a1c8153a6d0a5c0f98cb874b52d99"
        },
        {
            "id": "simple-return",
            "sourceSha256": "9957ed4144a4dcb3ea6918ae021976812dda56d4da3815ef92ca29682e0fa0b5"
        }
    ]);
    let sequence_sha256 = fixture_digest(&stages);
    let run_artifacts = serde_json::json!([{
        "name": "fixture.ino.bin",
        "role": "application-bin",
        "bytes": artifact_bytes.len(),
        "sha256": test_sha256(artifact_bytes),
        "primaryApplication": true,
    }]);
    let run_artifact_set_sha256 = fixture_digest(&run_artifacts);
    let make_run = |wall_ms: u64, stage: &str, stage_sha256: &str, build_path: &str, ck: bool| {
        let mut run = serde_json::json!({
            "success": true,
            "wallMs": wall_ms,
            "artifactsVerified": true,
            "resourceGatePassed": true,
            "exactUsed": false,
            "evidenceSha256": "5".repeat(64),
            "artifactSetSha256": run_artifact_set_sha256,
            "artifacts": run_artifacts,
            "codeSha256": stage_sha256,
            "buildPathIdentitySha256": build_path,
            "resources": {
                "evidenceComplete": true,
                "flashUsedBytes": 1024,
                "ramUsedBytes": 128,
                "warningCount": 0,
            },
        });
        if ck {
            run["profile"] = serde_json::json!("quick-fast");
            run["qualificationOperation"] = serde_json::json!("compile");
            run["qualificationProfile"] = serde_json::json!("quick-fast");
            run["ckContractId"] = serde_json::json!(current_forge_contract_id());
            run["candidateRoute"] = serde_json::json!("qualification-token-probe");
            run["buildMode"] = serde_json::json!(if stage == "simple" {
                "full-build"
            } else {
                "fast-relink"
            });
            run["fallbackUsed"] = serde_json::json!(false);
            run["recipeCapability"] = serde_json::json!({
                "schemaVersion": 2,
                "baselineSha256": "7".repeat(64),
                "observationOnly": true,
                "capabilityGatePassed": true,
                "requiredCapabilities": ["sketch_compile", "direct_link"],
                "missingCapabilities": [],
            });
        } else {
            run["profile"] = serde_json::json!("quick-fast");
            run["compilerPropertyDeltaSha256"] =
                serde_json::json!(native_baseline_compiler_properties_sha256);
        }
        run
    };
    let make_trials = |lane: &str,
                       simple: [u64; 5],
                       complex: [u64; 5],
                       medium: [u64; 5],
                       simple_return: [u64; 5]| {
        (0..5)
            .map(|index| {
                let build_path = test_sha256(format!("{lane}-{index}").as_bytes());
                serde_json::json!({
                    "id": format!("trial-{}", index + 1),
                    "simple": make_run(simple[index], "simple", stages[0]["sourceSha256"].as_str().unwrap(), &build_path, lane == "ck"),
                    "complex": make_run(complex[index], "complex", stages[1]["sourceSha256"].as_str().unwrap(), &build_path, lane == "ck"),
                    "medium": make_run(medium[index], "medium", stages[2]["sourceSha256"].as_str().unwrap(), &build_path, lane == "ck"),
                    "simple-return": make_run(simple_return[index], "simple-return", stages[3]["sourceSha256"].as_str().unwrap(), &build_path, lane == "ck"),
                })
            })
            .collect::<Vec<_>>()
    };
    let candidate = serde_json::json!({
        "schemaId": "ck.forge.performance-ab-candidate",
        "schemaVersion": 4,
        "operation": "compile",
        "candidateProfile": "quick-fast",
        "ckContractId": current_forge_contract_id(),
        "artifactEquivalencePolicyId": "compile-only-shared-primary-application-exact-v1",
        "compilePropertyDelta": "fixture compile profile",
        "nativeBaselineCompilerPropertiesSha256": native_baseline_compiler_properties_sha256,
        "measurementSequence": "portable-edit",
        "sequenceSha256": sequence_sha256,
        "stages": stages,
        "controls": controls,
        "captureOrder": ["ck-native", "native-ck", "ck-native", "native-ck", "ck-native"],
        "lanes": {
            "ck": {
                "identity": identity,
                "trials": make_trials(
                    "ck",
                    [7_500, 7_600, 7_400, 7_550, 7_450],
                    [3_500, 3_600, 3_400, 3_550, 3_450],
                    [4_000, 4_100, 3_900, 4_050, 3_950],
                    [3_000, 3_100, 2_900, 3_050, 2_950]
                ),
            },
            "native": {
                "identity": identity,
                "trials": make_trials(
                    "native",
                    [10_000, 10_100, 9_900, 10_050, 9_950],
                    [5_000, 5_100, 4_900, 5_050, 4_950],
                    [5_500, 5_600, 5_400, 5_550, 5_450],
                    [4_500, 4_600, 4_400, 4_550, 4_450]
                ),
            },
        },
    });
    let candidate_bytes = serde_json::to_vec_pretty(&candidate).unwrap();
    let candidate_sha256 = test_sha256(&candidate_bytes);
    let qualification_key = ck_forge::compute_qualification_key(&candidate).unwrap();
    let report = serde_json::json!({
        "schemaId": "ck.forge.performance-qualification-report",
        "schemaVersion": 4,
        "policy": { "id": "ck-forge-portable-edit-no-regression-v3" },
        "inputSha256": candidate_sha256,
        "qualificationKey": qualification_key,
        "target": identity,
        "operation": "compile",
        "candidateProfile": "quick-fast",
        "artifactEquivalencePolicyId": "compile-only-shared-primary-application-exact-v1",
        "measurementSequence": "portable-edit",
        "sequenceSha256": sequence_sha256,
        "hostIdentitySha256": host_identity,
        "sampleSetSha256": candidate_sha256,
        "ckContractId": current_forge_contract_id(),
        "compilePropertyDelta": "fixture compile profile",
        "nativeBaselineCompilerPropertiesSha256": native_baseline_compiler_properties_sha256,
        "trialCountPerLane": 5,
        "captureOrder": ["ck-native", "native-ck", "ck-native", "native-ck", "ck-native"],
        "qualifiedFast": true,
        "status": "qualified-fast",
        "recommendedRoute": "ck-fast",
        "controls": controls,
        "compileOnly": true,
        "uploadPerformed": false,
        "hardwareTested": false,
        "stages": [
            { "stage": "simple", "qualified": true, "checks": [{"id":"fixture", "passed":true}] },
            { "stage": "complex", "qualified": true, "checks": [{"id":"fixture", "passed":true}] },
            { "stage": "medium", "qualified": true, "checks": [{"id":"fixture", "passed":true}] },
            { "stage": "simple-return", "qualified": true, "checks": [{"id":"fixture", "passed":true}] }
        ],
    });
    let report_bytes = serde_json::to_vec_pretty(&report).unwrap();
    let report_sha256 = test_sha256(&report_bytes);
    let qualification_dir = root
        .join("state")
        .join("qualifications")
        .join(&qualification_key);
    std::fs::create_dir_all(qualification_dir.join("artifacts")).unwrap();
    std::fs::write(qualification_dir.join("candidate.json"), &candidate_bytes).unwrap();
    std::fs::write(qualification_dir.join("report.json"), &report_bytes).unwrap();
    std::fs::write(
        qualification_dir.join("artifact-manifest.json"),
        &artifact_manifest_bytes,
    )
    .unwrap();
    std::fs::write(
        qualification_dir.join("artifacts").join("firmware.bin"),
        artifact_bytes,
    )
    .unwrap();
    std::fs::write(
        qualification_dir.join("certificate.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "schemaId": "ck.forge.local-performance-certificate",
            "schemaVersion": 2,
            "candidateSha256": candidate_sha256,
            "reportSha256": report_sha256,
            "artifactManifestSha256": artifact_manifest_sha256,
        }))
        .unwrap(),
    )
    .unwrap();

    let loaded = ck_forge::load_local_qualification(
        &root,
        fqbn,
        core_version,
        cli_version,
        &toolchain_key,
        &sketch_sha256,
    )
    .expect("fully revalidated local qualification");
    assert_eq!(loaded.performance_ab.len(), 1);
    assert_eq!(
        loaded.performance_ab[0].candidate_profile,
        ForgePerformanceProfile::QuickFast
    );
    assert!(
        ck_forge::load_local_native_relink_evidence_sha256(
            &root,
            fqbn,
            core_version,
            cli_version,
            &toolchain_key,
        )
        .is_none(),
        "a valid portable/local v2 certificate must never authorize NativeRelink v4"
    );

    // The historical schemaId is shared, so exercise the envelope boundary
    // itself: relabeling a valid v2 payload as v4 (or as an unknown future
    // version) must not make either certificate family accept it. A portable
    // certificate with NativeRelink fields is likewise rejected as a hybrid.
    let local_certificate_path = qualification_dir.join("certificate.json");
    let local_certificate_v2 = std::fs::read(&local_certificate_path).unwrap();
    let local_certificate_base: serde_json::Value =
        serde_json::from_slice(&local_certificate_v2).unwrap();
    let mut local_as_v4 = local_certificate_base.clone();
    local_as_v4["schemaVersion"] = serde_json::json!(4);
    let mut local_future = local_certificate_base.clone();
    local_future["schemaVersion"] = serde_json::json!(999);
    let mut local_hybrid = local_certificate_base.clone();
    local_hybrid["candidateProfile"] = serde_json::json!("native-relink-compile-only");
    local_hybrid["evidenceSha256"] = serde_json::json!("d".repeat(64));
    for (label, value) in [
        ("portable v2 relabeled as v4", local_as_v4),
        ("portable v2 future certificate", local_future),
        ("portable/NativeRelink hybrid certificate", local_hybrid),
    ] {
        std::fs::write(
            &local_certificate_path,
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();
        assert!(
            ck_forge::load_local_qualification(
                &root,
                fqbn,
                core_version,
                cli_version,
                &toolchain_key,
                &sketch_sha256,
            )
            .is_none(),
            "{label} must not pass the portable/local loader"
        );
        assert!(
            ck_forge::load_local_native_relink_evidence_sha256(
                &root,
                fqbn,
                core_version,
                cli_version,
                &toolchain_key,
            )
            .is_none(),
            "{label} must not pass the NativeRelink loader"
        );
    }
    std::fs::write(&local_certificate_path, &local_certificate_v2).unwrap();

    // The v2 loader must also reject an internally rehashed payload when its
    // contract/policy or producer/subject identity is incomplete.  These are
    // denial tests only; no schema or certificate migration is involved.
    let local_candidate_path = qualification_dir.join("candidate.json");
    let local_report_path = qualification_dir.join("report.json");
    let local_candidate_v4 = std::fs::read(&local_candidate_path).unwrap();
    let local_report_v4 = std::fs::read(&local_report_path).unwrap();
    let local_candidate_value: serde_json::Value =
        serde_json::from_slice(&local_candidate_v4).unwrap();
    let local_report_value: serde_json::Value = serde_json::from_slice(&local_report_v4).unwrap();
    let write_local_payload_variant =
        |label: &str,
         candidate_variant: serde_json::Value,
         mut report_variant: serde_json::Value| {
            let candidate_bytes = serde_json::to_vec_pretty(&candidate_variant).unwrap();
            let candidate_sha256 = test_sha256(&candidate_bytes);
            report_variant["inputSha256"] = serde_json::json!(candidate_sha256);
            report_variant["sampleSetSha256"] = serde_json::json!(candidate_sha256);
            let report_bytes = serde_json::to_vec_pretty(&report_variant).unwrap();
            let report_sha256 = test_sha256(&report_bytes);
            let certificate = serde_json::json!({
                "schemaId": "ck.forge.local-performance-certificate",
                "schemaVersion": 2,
                "candidateSha256": candidate_sha256,
                "reportSha256": report_sha256,
                "artifactManifestSha256": artifact_manifest_sha256,
            });
            std::fs::write(&local_candidate_path, candidate_bytes).unwrap();
            std::fs::write(&local_report_path, report_bytes).unwrap();
            std::fs::write(
                &local_certificate_path,
                serde_json::to_vec_pretty(&certificate).unwrap(),
            )
            .unwrap();
            assert!(
                ck_forge::load_local_qualification(
                    &root,
                    fqbn,
                    core_version,
                    cli_version,
                    &toolchain_key,
                    &sketch_sha256,
                )
                .is_none(),
                "{label} must fail closed"
            );
        };
    let mut missing_contract_candidate = local_candidate_value.clone();
    missing_contract_candidate
        .as_object_mut()
        .expect("candidate object")
        .remove("ckContractId");
    write_local_payload_variant(
        "portable v2 candidate without contract",
        missing_contract_candidate,
        local_report_value.clone(),
    );
    let mut missing_policy_report = local_report_value.clone();
    missing_policy_report
        .as_object_mut()
        .expect("report object")
        .remove("policy");
    write_local_payload_variant(
        "portable v2 report without policy",
        local_candidate_value.clone(),
        missing_policy_report,
    );
    let mut missing_producer_candidate = local_candidate_value.clone();
    missing_producer_candidate
        .get_mut("lanes")
        .and_then(serde_json::Value::as_object_mut)
        .and_then(|lanes| lanes.get_mut("ck"))
        .and_then(serde_json::Value::as_object_mut)
        .and_then(|ck| ck.get_mut("identity"))
        .and_then(serde_json::Value::as_object_mut)
        .expect("portable candidate identity")
        .remove("productionExecutableSha256");
    write_local_payload_variant(
        "portable v2 candidate without producer identity",
        missing_producer_candidate,
        local_report_value.clone(),
    );
    let mut missing_subject_candidate = local_candidate_value.clone();
    missing_subject_candidate
        .get_mut("lanes")
        .and_then(serde_json::Value::as_object_mut)
        .and_then(|lanes| lanes.get_mut("ck"))
        .and_then(serde_json::Value::as_object_mut)
        .and_then(|ck| ck.get_mut("identity"))
        .and_then(serde_json::Value::as_object_mut)
        .expect("portable candidate identity")
        .remove("fqbn");
    write_local_payload_variant(
        "portable v2 candidate without subject identity",
        missing_subject_candidate,
        local_report_value.clone(),
    );
    std::fs::write(&local_candidate_path, &local_candidate_v4).unwrap();
    std::fs::write(&local_report_path, &local_report_v4).unwrap();
    std::fs::write(&local_certificate_path, &local_certificate_v2).unwrap();

    // v3 payloads must not regain a fast route merely because their envelope
    // hashes remain internally consistent. The v2 envelope is intentionally
    // stable; v4 is the candidate/report evidence contract.
    let mut legacy_candidate = candidate.clone();
    legacy_candidate["schemaVersion"] = serde_json::json!(3);
    let legacy_candidate_bytes = serde_json::to_vec_pretty(&legacy_candidate).unwrap();
    let legacy_candidate_sha256 = test_sha256(&legacy_candidate_bytes);
    let mut legacy_report = report.clone();
    legacy_report["schemaVersion"] = serde_json::json!(3);
    legacy_report["inputSha256"] = serde_json::json!(legacy_candidate_sha256);
    legacy_report["sampleSetSha256"] = serde_json::json!(legacy_candidate_sha256);
    let legacy_report_bytes = serde_json::to_vec_pretty(&legacy_report).unwrap();
    let legacy_report_sha256 = test_sha256(&legacy_report_bytes);
    std::fs::write(
        qualification_dir.join("candidate.json"),
        &legacy_candidate_bytes,
    )
    .unwrap();
    std::fs::write(qualification_dir.join("report.json"), &legacy_report_bytes).unwrap();
    std::fs::write(
        qualification_dir.join("certificate.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "schemaId": "ck.forge.local-performance-certificate",
            "schemaVersion": 2,
            "candidateSha256": legacy_candidate_sha256,
            "reportSha256": legacy_report_sha256,
            "artifactManifestSha256": artifact_manifest_sha256,
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(
        ck_forge::load_local_qualification(
            &root,
            fqbn,
            core_version,
            cli_version,
            &toolchain_key,
            &sketch_sha256,
        )
        .is_none(),
        "a v3 candidate/report pair must fail closed"
    );

    // Restore the valid v4 evidence before exercising independent artifact
    // integrity checks below.
    std::fs::write(qualification_dir.join("candidate.json"), &candidate_bytes).unwrap();
    std::fs::write(qualification_dir.join("report.json"), &report_bytes).unwrap();
    std::fs::write(
        qualification_dir.join("certificate.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "schemaId": "ck.forge.local-performance-certificate",
            "schemaVersion": 2,
            "candidateSha256": candidate_sha256,
            "reportSha256": report_sha256,
            "artifactManifestSha256": artifact_manifest_sha256,
        }))
        .unwrap(),
    )
    .unwrap();

    std::fs::write(
        qualification_dir.join("artifacts").join("firmware.bin"),
        b"tampered-firmware",
    )
    .unwrap();
    assert!(
        ck_forge::load_local_qualification(
            &root,
            fqbn,
            core_version,
            cli_version,
            &toolchain_key,
            &sketch_sha256,
        )
        .is_none()
    );
    assert!(
        ck_forge::load_local_qualification(
            &root,
            fqbn,
            core_version,
            cli_version,
            &toolchain_key,
            &"f".repeat(64),
        )
        .is_none()
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn local_certificate_loader_keeps_missing_state_on_native_route_without_cli_io() {
    let root = std::env::temp_dir().join(format!(
        "ck-forge-no-local-certificate-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    assert!(
        ck_forge::load_local_qualification(
            &root,
            "vendor:arch:custom",
            "1.0.0",
            "1.4.1",
            "vendor|arch|1.0.0|content",
            &"a".repeat(64),
        )
        .is_none()
    );
    assert!(
        !root.join("state").exists(),
        "the read-only loader must not create state/qualifications"
    );
    let _ = std::fs::remove_dir_all(root);
}

fn fixture_canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::String(value) => serde_json::to_string(value).unwrap(),
        serde_json::Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(fixture_canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        serde_json::Value::Object(values) => {
            let mut fields = values.iter().collect::<Vec<_>>();
            fields.sort_by(|left, right| left.0.cmp(right.0));
            format!(
                "{{{}}}",
                fields
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        fixture_canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn fixture_digest(value: &serde_json::Value) -> String {
    test_sha256(fixture_canonical_json(value).as_bytes())
}

fn native_relink_run_fixture(
    stage: &str,
    source_sha256: &str,
    trial_id: &str,
    wall_ms: u64,
    ck: bool,
    cli_version: &str,
    contract_id: &str,
) -> serde_json::Value {
    let prefix = if ck { "ck" } else { "native" };
    let artifacts = serde_json::json!([
        {
            "name": format!("{prefix}.ino.hex"),
            "bytes": 128,
            "sha256": "a".repeat(64),
            "primaryApplication": true,
            "role": "avr-application-hex"
        },
        {
            "name": format!("{prefix}.ino.eep"),
            "bytes": 13,
            "sha256": "b".repeat(64),
            "primaryApplication": false,
            "role": "avr-eeprom"
        }
    ]);
    let mut run = serde_json::json!({
        "trialId": trial_id,
        "phase": stage,
        "success": true,
        "compileOnly": true,
        "uploadPerformed": false,
        "exactUsed": false,
        "wallMs": wall_ms,
        "buildMode": if ck {
            if stage == "simple" { "full-build" } else { "native-relink-compile-only" }
        } else if stage == "simple" {
            "native-fresh-build"
        } else {
            "native-incremental-edit"
        },
        "fqbn": "arduino:avr:uno",
        "codeSha256": source_sha256,
        "resources": {
            "evidenceComplete": true,
            "flashUsedBytes": 586,
            "ramUsedBytes": 13,
            "warningCount": 0
        },
        "artifacts": artifacts,
        "artifactsVerified": true,
        "artifactSetSha256": fixture_digest(&artifacts),
    });
    if ck {
        run["toolchainKey"] = serde_json::json!("arduino|avr|1.8.6|fixture-toolchain");
        run["cliVersion"] = serde_json::json!(cli_version);
        run["route"] = serde_json::json!({
            "coreVersion": "1.8.6",
            "contractId": contract_id,
            "decision": "force-platform"
        });
    } else {
        run["fqbn"] = serde_json::json!("arduino:avr:uno");
    }
    let digest = fixture_digest(&run);
    run["evidenceSha256"] = serde_json::json!(digest);
    run
}

fn install_native_relink_fixture(root: &std::path::Path) -> (String, String, String) {
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let cli_path = if cfg!(windows) {
        bin.join("arduino-cli.exe")
    } else {
        bin.join("arduino-cli")
    };
    let cli_bytes = b"fixture-native-relink-cli";
    std::fs::write(&cli_path, cli_bytes).unwrap();
    let cli_sha256 = test_sha256(cli_bytes);
    let host_sha256 = ck_forge::host_environment_fingerprint(root);
    let production_executable_sha256 = test_sha256(
        &std::fs::read(std::env::current_exe().expect("current test executable"))
            .expect("read current test executable"),
    );
    let cli_version = "arduino-cli Version: 1.4.1";
    let contract_id = current_forge_contract_id();
    let stages = serde_json::json!([
        {"id":"simple","sourceSha256":"9957ed4144a4dcb3ea6918ae021976812dda56d4da3815ef92ca29682e0fa0b5"},
        {"id":"complex","sourceSha256":"ea468a750d243cc9a5a801d7bcd66a87e8daa2fdb535a783896fef99b0a0266e"},
        {"id":"medium","sourceSha256":"1e41189bc6e324ef3e72a08adfceef99ed1a1c8153a6d0a5c0f98cb874b52d99"},
        {"id":"simple-return","sourceSha256":"9957ed4144a4dcb3ea6918ae021976812dda56d4da3815ef92ca29682e0fa0b5"}
    ]);
    let sequence_sha256 = fixture_digest(&stages);
    let stage_rows = stages.as_array().unwrap();
    let mut trials = Vec::new();
    let mut capture_order = Vec::new();
    for index in 0..5_u64 {
        let trial_id = format!("trial-{:03}", index + 1);
        let order = if index % 2 == 0 {
            "ck-native"
        } else {
            "native-ck"
        };
        capture_order.push(serde_json::json!(order));
        let mut ck = serde_json::Map::new();
        let mut native = serde_json::Map::new();
        ck.insert(
            "cacheClear".into(),
            serde_json::json!({
                "reset_scope": "first-project-full-fqbn",
                "force_rebuild_pending": false,
                "ccache_store_preserved": true
            }),
        );
        for row in stage_rows {
            let stage = row["id"].as_str().unwrap();
            let source = row["sourceSha256"].as_str().unwrap();
            let native_ms = if stage == "simple" { 8_000 } else { 3_000 } + index * 10;
            let ck_ms = if stage == "simple" { 9_000 } else { 1_000 } + index * 10;
            ck.insert(
                stage.to_string(),
                native_relink_run_fixture(
                    stage,
                    source,
                    &trial_id,
                    ck_ms,
                    true,
                    cli_version,
                    contract_id,
                ),
            );
            native.insert(
                stage.to_string(),
                native_relink_run_fixture(
                    stage,
                    source,
                    &trial_id,
                    native_ms,
                    false,
                    cli_version,
                    contract_id,
                ),
            );
        }
        trials.push(serde_json::json!({
            "id": trial_id,
            "order": order,
            "ck": ck,
            "native": native
        }));
    }
    let evidence = serde_json::json!({
        "schemaId": "ck.forge.native-ab-run",
        "schemaVersion": 2,
        "status": "passed",
        "measurementStatus": "passed",
        "qualificationStatus": "qualified",
        "controls": {
            "compileOnly": true,
            "uploadPerformed": false,
            "physicalFlashWritten": false,
            "serialPortAccessed": false,
            "sameMachine": true,
            "sameBundledCli": true,
            "sameCliConfig": true,
            "sameCoreAndCompleteFqbn": true,
            "sameSourceBytes": true,
            "sameParallelJobs": true,
            "globalCachesSharedEqually": true,
            "externalShortBuildPaths": true,
            "sequentialNoConcurrentCompiles": true,
            "ckQualificationMode": true,
            "qualificationTokenBound": true,
            "exactAllowed": false,
            "exactCountedAsFresh": false,
            "requiredCkMode": "native-relink-compile-only",
            "measurementSequence": "portable-edit",
            "sameBuildPathWithinLane": true,
            "nativeRelinkAdapterId": "arduino-avr-native-relink-v1",
            "nativeRelinkEngineContractId": ck_forge::CK_FORGE_NATIVE_RELINK_COMPILE_ONLY_CONTRACT_ID,
            "artifactEquivalencePolicyId": "arduino-avr-hex-required-eeprom-optional-exact-v2"
        },
        "identity": {
            "fqbn": "arduino:avr:uno",
            "coreArchitecture": "avr",
            "coreVersion": "1.8.6",
            "cliVersion": cli_version,
            "cliExecutableSha256": cli_sha256,
            "hostIdentitySha256": host_sha256,
            "runnerSha256": "c".repeat(64),
            "productionExecutableSha256": production_executable_sha256,
            "sequenceSha256": sequence_sha256
        },
        "stages": stages,
        "captureOrder": capture_order,
        "trials": trials,
        "checks": [{"id":"fixture","passed":true}],
        "failures": [],
        "runner": {"unchanged":true},
        "productionExecutable": {
            "before": {"executableSha256": production_executable_sha256},
            "after": {"executableSha256": production_executable_sha256},
            "unchanged": true
        }
    });
    let evidence_bytes = serde_json::to_vec_pretty(&evidence).unwrap();
    let evidence_sha256 = test_sha256(&evidence_bytes);
    let binding = serde_json::json!({
        "schemaId": "ck.forge.native-relink-local-binding",
        "schemaVersion": 3,
        "profile": "native-relink-compile-only",
        "performancePolicyId": "ck-forge-portable-edit-performance-v3",
        "fqbn": "arduino:avr:uno",
        "coreVersion": "1.8.6",
        "toolchainKey": "arduino|avr|1.8.6|fixture-toolchain",
        "cliVersion": cli_version,
        "cliExecutableSha256": cli_sha256,
        "hostIdentitySha256": host_sha256,
        "productionExecutableSha256": production_executable_sha256,
        "sequenceSha256": sequence_sha256,
        "ckContractId": contract_id,
        "nativeRelinkContractId": ck_forge::CK_FORGE_NATIVE_RELINK_COMPILE_ONLY_CONTRACT_ID
    });
    let qualification_key = fixture_digest(&binding);
    let report = serde_json::json!({
        "schemaId": "ck.forge.native-relink-local-qualification-report",
        "schemaVersion": 1,
        "evaluatedAt": "2026-07-18T00:00:00.000Z",
        "evidenceSha256": evidence_sha256,
        "qualificationKey": qualification_key,
        "operation": "compile",
        "candidateProfile": "native-relink-compile-only",
        "policy": {"id":"ck-forge-portable-edit-performance-v3"},
        "target": {
            "fqbn": "arduino:avr:uno",
            "coreVersion": "1.8.6",
            "toolchainKey": "arduino|avr|1.8.6|fixture-toolchain",
            "cliVersion": cli_version,
            "cliExecutableSha256": cli_sha256,
            "hostIdentitySha256": host_sha256,
            "productionExecutableSha256": production_executable_sha256,
            "sequenceSha256": sequence_sha256
        },
        "ckContractId": contract_id,
        "nativeRelinkAdapterId": "arduino-avr-native-relink-v1",
        "nativeRelinkContractId": ck_forge::CK_FORGE_NATIVE_RELINK_COMPILE_ONLY_CONTRACT_ID,
        "artifactEquivalencePolicyId": "arduino-avr-hex-required-eeprom-optional-exact-v2",
        "measurementSequence": "portable-edit",
        "coldSimpleRequiredToWin": false,
        "trialCountPerLane": 5,
        "stages": [
            {"id":"complex","qualified":true},
            {"id":"medium","qualified":true},
            {"id":"simple-return","qualified":true}
        ],
        "qualified": true,
        "status": "qualified-native-relink",
        "recommendedRoute": "native-relink-compile-only",
        "reasonCodes": ["all-portable-edit-stages-qualified"]
    });
    let report_bytes = serde_json::to_vec_pretty(&report).unwrap();
    let report_sha256 = test_sha256(&report_bytes);
    let qualification_dir = root
        .join("state")
        .join("qualifications")
        .join(&qualification_key);
    std::fs::create_dir_all(&qualification_dir).unwrap();
    std::fs::write(qualification_dir.join("evidence.json"), evidence_bytes).unwrap();
    std::fs::write(qualification_dir.join("report.json"), report_bytes).unwrap();
    std::fs::write(
        qualification_dir.join("certificate.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "schemaId": "ck.forge.local-performance-certificate",
            "schemaVersion": 4,
            "candidateProfile": "native-relink-compile-only",
            "evidenceSha256": evidence_sha256,
            "reportSha256": report_sha256
        }))
        .unwrap(),
    )
    .unwrap();
    (qualification_key, evidence_sha256, cli_version.to_string())
}

#[test]
fn native_relink_certificate_loader_recomputes_and_binds_host_fqbn_core_toolchain_cli_and_production_executable()
 {
    let root = std::env::temp_dir().join(format!(
        "ck-forge-native-relink-certificate-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let (key, evidence_sha256, cli_version) = install_native_relink_fixture(&root);
    assert_eq!(
        ck_forge::load_local_native_relink_evidence_sha256(
            &root,
            "arduino:avr:uno",
            "1.8.6",
            &cli_version,
            "arduino|avr|1.8.6|fixture-toolchain"
        ),
        Some(evidence_sha256)
    );
    assert!(
        ck_forge::load_local_qualification(
            &root,
            "arduino:avr:uno",
            "1.8.6",
            &cli_version,
            "arduino|avr|1.8.6|fixture-toolchain",
            &"f".repeat(64),
        )
        .is_none(),
        "a valid NativeRelink v4 certificate must never be treated as portable/local v2"
    );
    let certificate_path = root
        .join("state")
        .join("qualifications")
        .join(&key)
        .join("certificate.json");
    let certificate_v4 = std::fs::read(&certificate_path).expect("read v4 certificate");
    let mut legacy_certificate: serde_json::Value =
        serde_json::from_slice(&certificate_v4).expect("parse v4 certificate");
    legacy_certificate["schemaVersion"] = serde_json::json!(3);
    std::fs::write(
        &certificate_path,
        serde_json::to_vec_pretty(&legacy_certificate).unwrap(),
    )
    .unwrap();
    assert!(
        ck_forge::load_local_native_relink_evidence_sha256(
            &root,
            "arduino:avr:uno",
            "1.8.6",
            &cli_version,
            "arduino|avr|1.8.6|fixture-toolchain"
        )
        .is_none(),
        "legacy v3 NativeRelink certificates must fail closed"
    );
    std::fs::write(&certificate_path, certificate_v4).unwrap();

    let qualification_dir = certificate_path.parent().unwrap();
    let evidence_path = qualification_dir.join("evidence.json");
    let report_path = qualification_dir.join("report.json");
    let evidence_v4 = std::fs::read(&evidence_path).expect("read executable-bound evidence");
    let report_v4 = std::fs::read(&report_path).expect("read executable-bound report");
    let certificate_v4 = std::fs::read(&certificate_path).expect("read restored v4 certificate");

    // Exercise the NativeRelink envelope boundary independently of the
    // payload hashes.  Wrong/unknown versions, portable fields, and missing
    // NativeRelink fields must all stay out of the v4 authorization path.
    let certificate_base: serde_json::Value =
        serde_json::from_slice(&certificate_v4).expect("parse valid v4 certificate");
    let mut v4_as_v2 = certificate_base.clone();
    v4_as_v2["schemaVersion"] = serde_json::json!(2);
    let mut v4_future = certificate_base.clone();
    v4_future["schemaVersion"] = serde_json::json!(999);
    let mut v4_hybrid = certificate_base.clone();
    v4_hybrid["candidateSha256"] = serde_json::json!("a".repeat(64));
    v4_hybrid["artifactManifestSha256"] = serde_json::json!("b".repeat(64));
    let mut v4_missing_profile = certificate_base.clone();
    v4_missing_profile
        .as_object_mut()
        .expect("v4 certificate object")
        .remove("candidateProfile");
    let mut v4_missing_evidence = certificate_base.clone();
    v4_missing_evidence
        .as_object_mut()
        .expect("v4 certificate object")
        .remove("evidenceSha256");
    for (label, value) in [
        ("NativeRelink v4 relabeled as v2", v4_as_v2),
        ("NativeRelink future certificate", v4_future),
        ("NativeRelink/portable hybrid certificate", v4_hybrid),
        (
            "NativeRelink certificate without profile",
            v4_missing_profile,
        ),
        (
            "NativeRelink certificate without evidence hash",
            v4_missing_evidence,
        ),
    ] {
        std::fs::write(
            &certificate_path,
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();
        assert!(
            ck_forge::load_local_native_relink_evidence_sha256(
                &root,
                "arduino:avr:uno",
                "1.8.6",
                &cli_version,
                "arduino|avr|1.8.6|fixture-toolchain"
            )
            .is_none(),
            "{label} must not authorize NativeRelink"
        );
        assert!(
            ck_forge::load_local_qualification(
                &root,
                "arduino:avr:uno",
                "1.8.6",
                &cli_version,
                "arduino|avr|1.8.6|fixture-toolchain",
                &"f".repeat(64),
            )
            .is_none(),
            "{label} must not be treated as portable/local"
        );
    }
    std::fs::write(&certificate_path, &certificate_v4).unwrap();

    // Keep the original, valid payloads available for the independent
    // contract/policy/producer/subject-identity omissions below.
    let evidence_value: serde_json::Value =
        serde_json::from_slice(&evidence_v4).expect("parse valid v4 evidence");
    let report_value: serde_json::Value =
        serde_json::from_slice(&report_v4).expect("parse valid v4 report");
    let write_payload_variant =
        |label: &str, evidence: serde_json::Value, mut report: serde_json::Value| {
            let evidence_bytes = serde_json::to_vec_pretty(&evidence).unwrap();
            let evidence_sha256 = test_sha256(&evidence_bytes);
            report["evidenceSha256"] = serde_json::json!(evidence_sha256);
            let report_bytes = serde_json::to_vec_pretty(&report).unwrap();
            let report_sha256 = test_sha256(&report_bytes);
            let certificate = serde_json::json!({
                "schemaId": "ck.forge.local-performance-certificate",
                "schemaVersion": 4,
                "candidateProfile": "native-relink-compile-only",
                "evidenceSha256": evidence_sha256,
                "reportSha256": report_sha256
            });
            std::fs::write(&evidence_path, evidence_bytes).unwrap();
            std::fs::write(&report_path, report_bytes).unwrap();
            std::fs::write(
                &certificate_path,
                serde_json::to_vec_pretty(&certificate).unwrap(),
            )
            .unwrap();
            assert!(
                ck_forge::load_local_native_relink_evidence_sha256(
                    &root,
                    "arduino:avr:uno",
                    "1.8.6",
                    &cli_version,
                    "arduino|avr|1.8.6|fixture-toolchain"
                )
                .is_none(),
                "{label} must fail closed"
            );
        };
    let mut missing_contract_report = report_value.clone();
    missing_contract_report
        .as_object_mut()
        .expect("report object")
        .remove("ckContractId");
    write_payload_variant(
        "NativeRelink report without ckContractId",
        evidence_value.clone(),
        missing_contract_report,
    );
    let mut missing_policy_report = report_value.clone();
    missing_policy_report
        .as_object_mut()
        .expect("report object")
        .remove("policy");
    write_payload_variant(
        "NativeRelink report without policy",
        evidence_value.clone(),
        missing_policy_report,
    );
    let mut missing_producer_evidence = evidence_value.clone();
    missing_producer_evidence
        .get_mut("identity")
        .and_then(serde_json::Value::as_object_mut)
        .expect("evidence identity object")
        .remove("runnerSha256");
    write_payload_variant(
        "NativeRelink evidence without producer identity",
        missing_producer_evidence,
        report_value.clone(),
    );
    let mut missing_subject_evidence = evidence_value.clone();
    missing_subject_evidence
        .get_mut("identity")
        .and_then(serde_json::Value::as_object_mut)
        .expect("evidence identity object")
        .remove("fqbn");
    write_payload_variant(
        "NativeRelink evidence without subject identity",
        missing_subject_evidence,
        report_value.clone(),
    );
    std::fs::write(&evidence_path, &evidence_v4).unwrap();
    std::fs::write(&report_path, &report_v4).unwrap();
    std::fs::write(&certificate_path, &certificate_v4).unwrap();

    let mismatched_executable_sha256 = "e".repeat(64);
    let mut mismatched_evidence: serde_json::Value =
        serde_json::from_slice(&evidence_v4).expect("parse executable-bound evidence");
    mismatched_evidence["identity"]["productionExecutableSha256"] =
        serde_json::json!(mismatched_executable_sha256);
    mismatched_evidence["productionExecutable"]["before"]["executableSha256"] =
        serde_json::json!(mismatched_executable_sha256);
    mismatched_evidence["productionExecutable"]["after"]["executableSha256"] =
        serde_json::json!(mismatched_executable_sha256);
    let mismatched_evidence_bytes = serde_json::to_vec_pretty(&mismatched_evidence).unwrap();
    let mismatched_evidence_sha256 = test_sha256(&mismatched_evidence_bytes);

    let mut mismatched_report: serde_json::Value =
        serde_json::from_slice(&report_v4).expect("parse executable-bound report");
    mismatched_report["evidenceSha256"] = serde_json::json!(mismatched_evidence_sha256);
    mismatched_report["target"]["productionExecutableSha256"] =
        serde_json::json!(mismatched_executable_sha256);
    let target = &mismatched_report["target"];
    let mismatched_binding = serde_json::json!({
        "schemaId": "ck.forge.native-relink-local-binding",
        "schemaVersion": 2,
        "profile": "native-relink-compile-only",
        "fqbn": target["fqbn"],
        "coreVersion": target["coreVersion"],
        "toolchainKey": target["toolchainKey"],
        "cliVersion": target["cliVersion"],
        "cliExecutableSha256": target["cliExecutableSha256"],
        "hostIdentitySha256": target["hostIdentitySha256"],
        "productionExecutableSha256": target["productionExecutableSha256"],
        "sequenceSha256": target["sequenceSha256"],
        "ckContractId": current_forge_contract_id(),
        "nativeRelinkContractId": ck_forge::CK_FORGE_NATIVE_RELINK_COMPILE_ONLY_CONTRACT_ID
    });
    mismatched_report["qualificationKey"] = serde_json::json!(fixture_digest(&mismatched_binding));
    let mismatched_report_bytes = serde_json::to_vec_pretty(&mismatched_report).unwrap();
    let mismatched_report_sha256 = test_sha256(&mismatched_report_bytes);
    let mismatched_certificate = serde_json::json!({
        "schemaId": "ck.forge.local-performance-certificate",
        "schemaVersion": 4,
        "candidateProfile": "native-relink-compile-only",
        "evidenceSha256": mismatched_evidence_sha256,
        "reportSha256": mismatched_report_sha256
    });
    std::fs::write(&evidence_path, mismatched_evidence_bytes).unwrap();
    std::fs::write(&report_path, mismatched_report_bytes).unwrap();
    std::fs::write(
        &certificate_path,
        serde_json::to_vec_pretty(&mismatched_certificate).unwrap(),
    )
    .unwrap();
    assert!(
        ck_forge::load_local_native_relink_evidence_sha256(
            &root,
            "arduino:avr:uno",
            "1.8.6",
            &cli_version,
            "arduino|avr|1.8.6|fixture-toolchain"
        )
        .is_none(),
        "a fully rehashed certificate for another CK executable must fail closed"
    );
    std::fs::write(&evidence_path, evidence_v4).unwrap();
    std::fs::write(&report_path, report_v4).unwrap();
    std::fs::write(&certificate_path, certificate_v4).unwrap();
    for (fqbn, core, toolchain) in [
        (
            "arduino:avr:nano",
            "1.8.6",
            "arduino|avr|1.8.6|fixture-toolchain",
        ),
        (
            "arduino:avr:uno",
            "1.8.7",
            "arduino|avr|1.8.6|fixture-toolchain",
        ),
        (
            "arduino:avr:uno",
            "1.8.6",
            "arduino|avr|1.8.6|other-toolchain",
        ),
    ] {
        assert!(
            ck_forge::load_local_native_relink_evidence_sha256(
                &root,
                fqbn,
                core,
                &cli_version,
                toolchain
            )
            .is_none()
        );
    }
    assert!(
        ck_forge::load_local_native_relink_evidence_sha256(
            &root,
            "arduino:avr:uno",
            "1.8.6",
            "arduino-cli Version: 1.4.2",
            "arduino|avr|1.8.6|fixture-toolchain"
        )
        .is_none()
    );

    let other_root = root.with_extension("other-host-root");
    std::fs::create_dir_all(other_root.join("bin")).unwrap();
    let cli_name = if cfg!(windows) {
        "arduino-cli.exe"
    } else {
        "arduino-cli"
    };
    std::fs::copy(
        root.join("bin").join(cli_name),
        other_root.join("bin").join(cli_name),
    )
    .unwrap();
    let source_dir = root.join("state").join("qualifications").join(&key);
    let target_dir = other_root.join("state").join("qualifications").join(&key);
    std::fs::create_dir_all(&target_dir).unwrap();
    for file in ["evidence.json", "report.json", "certificate.json"] {
        std::fs::copy(source_dir.join(file), target_dir.join(file)).unwrap();
    }
    assert!(
        ck_forge::load_local_native_relink_evidence_sha256(
            &other_root,
            "arduino:avr:uno",
            "1.8.6",
            &cli_version,
            "arduino|avr|1.8.6|fixture-toolchain"
        )
        .is_none()
    );
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(other_root);
}
