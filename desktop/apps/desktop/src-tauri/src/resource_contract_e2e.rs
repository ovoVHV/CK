use super::*;
use serde_json::{json, Value};
use std::{fs, io::Write, path::Path};

fn zip_fixture(source: &Path, target: &Path, mutate: Option<(&str, Value)>) {
    let mut zip = zip::ZipWriter::new(fs::File::create(target).unwrap());
    let options = zip::write::SimpleFileOptions::default();
    let mut files: Vec<_> = walkdir::WalkDir::new(source)
        .into_iter()
        .map(Result::unwrap)
        .filter(|e| e.file_type().is_file())
        .collect();
    files.sort_by_key(|e| e.path().to_path_buf());
    for file in files {
        let name = file
            .path()
            .strip_prefix(source)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        zip.start_file(&name, options).unwrap();
        let bytes = match &mutate {
            Some((path, value)) if name == *path => serde_json::to_vec(value).unwrap(),
            _ => fs::read(file.path()).unwrap(),
        };
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap();
}

#[test]
fn resource_contract_e2e_install_export_and_reject_invalid() {
    // Keep the package transaction identical for every non-built-in fixture.
    // The fixture-specific ids are test metadata only; production validation
    // never dispatches on these values.
    let fixtures = [
        (
            "resource-contract-fixture",
            "orchard_fabric_board",
            "orchard_probe",
        ),
        (
            "resource-contract-fixture-esp32",
            "juniper_esp32_route_board",
            "juniper_route_probe",
        ),
        (
            "resource-contract-fixture-avr-complex",
            "copper_avr_complex_board",
            "copper_spi_probe",
        ),
    ];
    let temp = tempfile::tempdir().unwrap();
    let boards = temp.path().join("app-data/CK/boards");
    let runtime = temp.path().join("runtime");
    let mut exports = Vec::with_capacity(fixtures.len());

    for (fixture_name, board_id, library_id) in fixtures {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../examples")
            .join(fixture_name);
        let archive = temp.path().join(format!("{fixture_name}.zip"));
        zip_fixture(&fixture, &archive, None);
        let payload = install_board_package_archive_into(&archive, None, &boards, &runtime)
            .expect("real board + bundled V2 library ZIP install");
        let board: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(board["id"], board_id);
        // No fake Core/compiler is installed. Import acceptance is distinct
        // from compile readiness for every contract fixture.
        assert_eq!(board["usable"], false);
        resource_contract::validate_graph(&board["resource_graph"]).unwrap();
        let installed_board = boards.join(board_id);
        let installed_library =
            runtime.join(format!("board-package-libraries/{board_id}/{library_id}"));
        let board_report =
            package_quality::read_quality_report_with_integrity(&installed_board).unwrap();
        let library_report =
            package_quality::read_quality_report_with_integrity(&installed_library).unwrap();
        assert_eq!(board_report.error_count, 0);
        assert_eq!(library_report.error_count, 0);
        assert!(board_report
            .checks
            .iter()
            .any(|c| c.code == "resource-graph"));
        let (manifest, diagnostics) =
            lib_custom_registry::read_block_package_manifest(&installed_library, library_id);
        assert!(
            !diagnostics.iter().any(|d| d.severity == "error"),
            "{diagnostics:?}"
        );
        let entries = lib_custom_registry::block_search_entries(manifest.as_ref());
        let catalog = serde_json::to_value(&entries).unwrap();
        assert_eq!(catalog[0]["hardware"]["claims"]["version"], 1);
        assert_eq!(catalog[0]["metadata_source"], "v2");
        let installed_raw = fs::read(installed_board.join("board.json")).unwrap();
        let original: Value = serde_json::from_slice(&installed_raw).unwrap();
        assert_eq!(original["resource_graph"], board["resource_graph"]);
        let generator = fs::read(installed_library.join("blocks/ck-generator.json")).unwrap();
        assert_eq!(
            generator,
            fs::read(fixture.join(format!("libraries/{library_id}/blocks/ck-generator.json")))
                .unwrap()
        );

        // Invalid optional graph and undeclared input both fail before
        // replacing the installed package. Keep this negative transaction on
        // the original fixture so every additional fixture remains a clean
        // positive install/export case.
        if fixture_name == "resource-contract-fixture" {
            let mut bad_board = original.clone();
            bad_board["resource_graph"]["resources"][0]["parent"] = json!("absent");
            zip_fixture(&fixture, &archive, Some(("board.json", bad_board)));
            assert!(install_board_package_archive_into(&archive, None, &boards, &runtime).is_err());
            assert_eq!(
                fs::read(installed_board.join("board.json")).unwrap(),
                installed_raw
            );
            let mut bad_block: Value = serde_json::from_slice(
                &fs::read(fixture.join(format!("libraries/{library_id}/ck-blocks.json"))).unwrap(),
            )
            .unwrap();
            bad_block["blocks"][0]["hardware"]["claims"]["templates"][0]["discriminator"]["name"] =
                json!("UNDECLARED");
            zip_fixture(
                &fixture,
                &archive,
                Some((
                    format!("libraries/{library_id}/ck-blocks.json").as_str(),
                    bad_block,
                )),
            );
            assert!(install_board_package_archive_into(&archive, None, &boards, &runtime).is_err());
            assert_eq!(
                fs::read(installed_library.join("blocks/ck-generator.json")).unwrap(),
                generator
            );
        }

        let definitions: Value = serde_json::from_slice(
            &fs::read(installed_library.join("blocks/blocks.json")).unwrap(),
        )
        .unwrap();
        exports.push(json!({
            "fixture_id": fixture_name,
            "board": board,
            "catalog": catalog,
            "definitions": definitions,
            "installedManifest": original,
            "boardValidation": board_report,
            "libraryValidation": library_report
        }));
    }

    if let Some(path) = std::env::var_os("CK_RESOURCE_E2E_OUTPUT") {
        fs::write(
            path,
            serde_json::to_vec_pretty(&json!({"fixtures": exports})).unwrap(),
        )
        .unwrap();
    }
}
