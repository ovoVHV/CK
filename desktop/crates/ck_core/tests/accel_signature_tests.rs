use ck_core::builder::accel::enforce_cache_budget_for_roots;
use ck_core::builder::demo::canonical_prewarm_cli_version;
use ck_core::builder::signature::{
    BuildSignatureInput, compute_build_signature, normalize_and_sort_paths,
};
use ck_core::sysroot::Sysroot;
use std::fs;
use std::path::PathBuf;

#[test]
fn test_normalize_and_sort_paths_stable() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path();
    let a = root.join("BLib");
    let b = root.join("alib");
    fs::create_dir_all(&a).expect("mkdir a");
    fs::create_dir_all(&b).expect("mkdir b");

    let input = vec![
        b.clone(),
        a.clone(),
        PathBuf::from(b.to_string_lossy().to_string()),
    ];
    let sorted = normalize_and_sort_paths(&input);

    assert_eq!(sorted.len(), 2);
    let names: Vec<String> = sorted
        .iter()
        .filter_map(|p| p.file_name().map(|s| s.to_string_lossy().to_string()))
        .collect();
    assert_eq!(names, vec!["alib".to_string(), "BLib".to_string()]);
}

#[test]
fn test_build_signature_stable_for_same_input() {
    let libs = vec!["C:/libs/A".to_string(), "C:/libs/B".to_string()];
    let input = BuildSignatureInput {
        fqbn: "esp32:esp32:esp32c5:UploadSpeed=921600",
        cli_version: "arduino-cli 1.4.1",
        toolchain_key: "esp32|3.3.1|rv32",
        sorted_libs: &libs,
    };
    let sig1 = compute_build_signature(&input);
    let sig2 = compute_build_signature(&input);
    assert_eq!(sig1, sig2);
}

#[test]
fn test_enforce_cache_budget_removes_oldest() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path();
    let d1 = root.join("old_cache");
    let d2 = root.join("new_cache");
    fs::create_dir_all(&d1).expect("mkdir d1");
    fs::create_dir_all(&d2).expect("mkdir d2");

    fs::write(d1.join("a.bin"), vec![0u8; 80 * 1024]).expect("write d1");
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::write(d2.join("b.bin"), vec![0u8; 80 * 1024]).expect("write d2");

    // 100KB budget should trim one 80KB entry from ~160KB total.
    enforce_cache_budget_for_roots(100 * 1024, &[root.to_path_buf()]).expect("budget sweep");

    let d1_exists = d1.exists();
    let d2_exists = d2.exists();
    assert_ne!(d1_exists, d2_exists);
    assert!(d2_exists, "newer cache should be kept");
}

#[tokio::test]
async fn public_canonical_prewarm_cli_version_is_stable_and_bounded() {
    let temp = tempfile::tempdir().expect("tempdir");
    let sysroot = Sysroot::init(
        Some(temp.path().join("sysroot")),
        "ck-public-cli-version-test",
    )
    .await
    .expect("sysroot");

    let first = canonical_prewarm_cli_version(&sysroot);
    let second = canonical_prewarm_cli_version(&sysroot);
    assert!(!first.is_empty());
    assert!(first.len() <= 2 * 1024 * 1024);
    assert_eq!(first, second, "CLI identity must keep its process cache");
}
