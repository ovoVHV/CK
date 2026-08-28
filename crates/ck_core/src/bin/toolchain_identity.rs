use ck_core::builder::demo::toolchain_cache_key_from_root;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationIndex {
    schema_id: &'static str,
    schema_version: u32,
    identity_schema: &'static str,
    entries: Vec<MigrationEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationEntry {
    fqbn: String,
    core_version: String,
    portable_toolchain_key: String,
    evidence_toolchain_key: String,
}

struct PendingMigrationEntry {
    fqbn: String,
    core_version: String,
    evidence_toolchain_key: String,
}

fn generate_migration_index(root: &PathBuf, qualifications: PathBuf, output: PathBuf) {
    let mut pending = Vec::new();
    for directory in std::fs::read_dir(&qualifications)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", qualifications.display()))
    {
        let directory = directory
            .expect("failed to read qualification entry")
            .path();
        if !directory.is_dir() {
            continue;
        }
        let report_path = directory.join("report.json");
        if !report_path.is_file() {
            continue;
        }
        let report: Value =
            serde_json::from_slice(&std::fs::read(&report_path).unwrap_or_else(|error| {
                panic!("failed to read {}: {error}", report_path.display())
            }))
            .unwrap_or_else(|error| panic!("invalid {}: {error}", report_path.display()));
        let target = report.get("target").expect("qualification target missing");
        let fqbn = target
            .get("fqbn")
            .and_then(Value::as_str)
            .expect("qualification FQBN missing")
            .to_owned();
        let core_version = target
            .get("coreVersion")
            .and_then(Value::as_str)
            .expect("qualification Core version missing")
            .to_owned();
        let evidence_toolchain_key = target
            .get("toolchainKey")
            .and_then(Value::as_str)
            .expect("qualification toolchain key missing")
            .to_owned();
        pending.push(PendingMigrationEntry {
            fqbn,
            core_version,
            evidence_toolchain_key,
        });
    }
    let unique_fqbns = pending
        .iter()
        .map(|entry| entry.fqbn.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let cursor = AtomicUsize::new(0);
    let resolved = Mutex::new(Vec::with_capacity(unique_fqbns.len()));
    let workers = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .min(4)
        .min(unique_fqbns.len());
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    let index = cursor.fetch_add(1, Ordering::Relaxed);
                    let Some(fqbn) = unique_fqbns.get(index) else {
                        break;
                    };
                    let key = toolchain_cache_key_from_root(root, fqbn);
                    resolved
                        .lock()
                        .expect("portable identity result lock poisoned")
                        .push((fqbn.clone(), key));
                }
            });
        }
    });
    let portable = resolved
        .into_inner()
        .expect("portable identity result lock poisoned")
        .into_iter()
        .collect::<BTreeMap<_, _>>();
    let mut entries = pending
        .into_iter()
        .map(|entry| MigrationEntry {
            portable_toolchain_key: portable
                .get(&entry.fqbn)
                .expect("portable identity missing")
                .clone(),
            fqbn: entry.fqbn,
            core_version: entry.core_version,
            evidence_toolchain_key: entry.evidence_toolchain_key,
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        left.fqbn.cmp(&right.fqbn).then(
            left.evidence_toolchain_key
                .cmp(&right.evidence_toolchain_key),
        )
    });
    let document = MigrationIndex {
        schema_id: "ck.forge.portable-toolchain-migration",
        schema_version: 1,
        identity_schema: "ck_toolchain_cache_key_v13_portable_inputs",
        entries,
    };
    let bytes = serde_json::to_vec_pretty(&document).expect("serialize migration index");
    std::fs::write(&output, bytes)
        .unwrap_or_else(|error| panic!("failed to write {}: {error}", output.display()));
}

fn main() {
    let mut args = std::env::args_os().skip(1);
    let Some(root) = args.next().map(PathBuf::from) else {
        eprintln!(
            "usage: toolchain_identity <CK sysroot> <complete FQBN>... | --migration-index <qualification root> <output>"
        );
        std::process::exit(2);
    };
    let remaining = args.collect::<Vec<_>>();
    if remaining
        .first()
        .is_some_and(|value| value == "--migration-index")
    {
        let qualifications = remaining
            .get(1)
            .map(PathBuf::from)
            .expect("qualification root missing");
        let output = remaining
            .get(2)
            .map(PathBuf::from)
            .expect("output path missing");
        generate_migration_index(&root, qualifications, output);
        return;
    }
    let fqbns = remaining
        .into_iter()
        .map(|value| value.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    if fqbns.is_empty() {
        eprintln!("toolchain_identity requires at least one complete FQBN");
        std::process::exit(2);
    }
    for fqbn in fqbns {
        let key = toolchain_cache_key_from_root(&root, &fqbn);
        println!("{}\t{}", fqbn, key);
    }
}
