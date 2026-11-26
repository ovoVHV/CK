use crate::BoardDefinition;
use std::fs;
use tauri::{AppHandle, Manager};

fn read_validated_quality_report(
    path: &std::path::Path,
) -> Option<crate::package_quality::PackageQualityReport> {
    crate::package_quality::read_quality_report_with_integrity(path)
}

fn board_quality_report_is_runtime_usable(
    report: Option<&crate::package_quality::PackageQualityReport>,
    expected_package_id: &str,
) -> bool {
    report.is_some_and(|report| {
        report.package_id.as_deref() == Some(expected_package_id)
            && crate::package_quality::runtime_quality_report_is_trusted(Some(report), "board")
    })
}

#[tauri::command]
pub async fn get_custom_boards_v2(app: AppHandle) -> Result<Vec<BoardDefinition>, String> {
    let mut boards = Vec::new();
    let app_data_dir = crate::app_storage::desktop_dir(&app)
        .map_err(|e| format!("Failed to resolve AppData: {}", e))?;
    let boards_dir = app_data_dir.join("CK").join("boards");

    if boards_dir.exists() {
        if let Ok(entries) = fs::read_dir(&boards_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let json_path = path.join("board.json");
                    if json_path.exists() {
                        if let Ok(content) = fs::read_to_string(&json_path) {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(
                                content.trim_start_matches('\u{feff}'),
                            ) {
                                let id = json["id"].as_str().unwrap_or("").to_string();
                                let name =
                                    json["name"].as_str().unwrap_or("Unknown Board").to_string();
                                let version = json["version"].as_str().unwrap_or("").to_string();
                                let vendor = json["vendor"]
                                    .as_str()
                                    .unwrap_or("")
                                    .to_string();
                                let desc = json["description"].as_str().unwrap_or("").to_string();
                                let icon = json["icon"].as_str().unwrap_or("📦_DEBUG").to_string();
                                let base_fqbn = json["fqbn_base"].as_str().unwrap_or("");
                                let group = base_fqbn
                                    .split(':')
                                    .nth(1)
                                    .filter(|value| !value.is_empty())
                                    .unwrap_or("Custom");
                                let arduino_core = json["arduino_core"].clone();
                                let pins = json["pins"].as_array().cloned().unwrap_or_default();

                                let mut asset_path = path.to_string_lossy().to_string();

                                // Support "extends" for shared assets (blocks/generator)
                                if let Some(extends_rel) = json["extends"].as_str() {
                                    let extended_path = path.join(extends_rel);
                                    // Use fs::canonicalize to resolve ".." if possible, but it requires existence
                                    if let Ok(canon) = fs::canonicalize(&extended_path) {
                                        asset_path = canon.to_string_lossy().to_string();
                                        // On Windows, canonicalize adds \\?\ prefix which can confuse some tools/frontend
                                        if cfg!(target_os = "windows") {
                                            asset_path =
                                                asset_path.trim_start_matches(r"\\?\").to_string();
                                        }
                                    } else {
                                        // Fallback to simple join if not found (though should warn)
                                        // Or just keep it relative and let frontend handle? Frontend expects absolute.
                                        // Let's try to normalize simply or just use the joined path
                                        asset_path = extended_path.to_string_lossy().to_string();
                                    }
                                }

                                let mut config_options = None;
                                if let Some(menus) = json["custom_menus"].as_object() {
                                    let mut options_vec = Vec::new();
                                    for (key, val) in menus {
                                        let label =
                                            val["label"].as_str().unwrap_or(key).to_string();
                                        let mut values_vec = Vec::new();

                                        if let Some(opts) = val["options"].as_array() {
                                            for opt in opts {
                                                let v =
                                                    opt["value"].as_str().unwrap_or("").to_string();
                                                let l =
                                                    opt["label"].as_str().unwrap_or(&v).to_string();
                                                // Check if selected
                                                let is_sel =
                                                    if let Some(sel) = val["selected"].as_str() {
                                                        sel == v
                                                    } else {
                                                        false
                                                    };

                                                let mut val_obj = serde_json::Map::new();
                                                val_obj.insert(
                                                    "value".to_string(),
                                                    serde_json::Value::String(v),
                                                );
                                                val_obj.insert(
                                                    "value_label".to_string(),
                                                    serde_json::Value::String(l),
                                                );
                                                if is_sel {
                                                    val_obj.insert(
                                                        "selected".to_string(),
                                                        serde_json::Value::Bool(true),
                                                    );
                                                }
                                                values_vec.push(serde_json::Value::Object(val_obj));
                                            }
                                        }

                                        let mut opt_obj = serde_json::Map::new();
                                        opt_obj.insert(
                                            "option".to_string(),
                                            serde_json::Value::String(key.clone()),
                                        );
                                        opt_obj.insert(
                                            "option_label".to_string(),
                                            serde_json::Value::String(label),
                                        );
                                        opt_obj.insert(
                                            "values".to_string(),
                                            serde_json::Value::Array(values_vec),
                                        );

                                        options_vec.push(serde_json::Value::Object(opt_obj));
                                    }
                                    config_options = Some(options_vec);
                                }

                                if !id.is_empty() {
                                    let sysroot = crate::ck_root_dir();
                                    let core_status = crate::board_passport::ArduinoCoreRequirement::from_manifest_value(
                                        &arduino_core,
                                    )
                                    .ok()
                                    .map(|requirement| {
                                        crate::board_passport::evaluate_core_compatibility(
                                            &sysroot,
                                            &requirement,
                                        )
                                    });
                                    let lock_exists =
                                        path.join(crate::board_passport::BOARD_LOCK_FILE).exists();
                                    let library_root = crate::ck_root_dir()
                                        .join("board-package-libraries")
                                        .join(&id);
                                    let passport = crate::board_passport::read_passport(&path)
                                        .and_then(|passport| {
                                            crate::board_passport::evaluate_passport(
                                                passport,
                                                &json,
                                                &path,
                                                Some(&library_root),
                                                &sysroot,
                                            )
                                        })
                                        .ok();
                                    let quality_report = read_validated_quality_report(&path);
                                    let quality_usable = board_quality_report_is_runtime_usable(
                                        quality_report.as_ref(),
                                        &id,
                                    );
                                    let graph_error = json.get("resource_graph")
                                        .and_then(|graph| crate::resource_contract::validate_graph(graph).err());
                                    let usable = quality_usable
                                        && graph_error.is_none()
                                        && !(lock_exists && passport.is_none())
                                        && core_status.as_ref().is_some_and(|status| status.usable);
                                    let availability_error = if usable {
                                        None
                                    } else if graph_error.is_some() {
                                        graph_error
                                    } else if !quality_usable {
                                        Some(if quality_report.is_none() {
                                            "板卡包缺少完整且可供运行时信任的质量报告，请重新导入并体检。"
                                                .to_string()
                                        } else {
                                            "板卡包质量认证失败、已过期或内容哈希发生变化，请重新导入并体检。"
                                                .to_string()
                                        })
                                    } else if lock_exists && passport.is_none() {
                                        Some(
                                            "板卡锁文件与当前认证环境不一致，需要重新验证。"
                                                .to_string(),
                                        )
                                    } else {
                                        core_status
                                            .as_ref()
                                            .map(|status| status.message.clone())
                                            .filter(|message| !message.trim().is_empty())
                                            .or_else(|| {
                                                Some("板卡 Core 环境尚未就绪。".to_string())
                                            })
                                    };
                                    boards.push(BoardDefinition {
                                        resource_graph: json.get("resource_graph").cloned(),
                                        id,
                                        name,
                                        version,
                                        vendor,
                                        author: json["author"].as_str().map(str::to_owned),
                                        vendor_logo_path: json["vendor_logo"].as_str()
                                            .and_then(|logo| crate::board_vendor_logo::resolve(&path, logo))
                                            .map(|logo| logo.to_string_lossy().into_owned()),
                                        fqbn_base: base_fqbn.to_string(),
                                        pins,
                                        icon,
                                        group: group.to_string(),
                                        description: desc,
                                        path: asset_path,
                                        arduino_core: if arduino_core.is_null() {
                                            None
                                        } else {
                                            Some(arduino_core)
                                        },
                                        config_options,
                                        quality_report,
                                        core_status,
                                        passport,
                                        usable,
                                        availability_error,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(boards)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_content_change_invalidates_stale_quality_report() {
        let root =
            std::env::temp_dir().join(format!("ck_board_quality_refresh_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("board.json"), "{}").unwrap();
        let mut report = crate::package_quality::PackageQualityReport::new("board");
        report.source_content_sha256 =
            Some(crate::package_quality::hash_package_contents(&root).unwrap());
        report.pass("fixture", "fixture passed");
        report.finalize();
        crate::package_quality::write_quality_report(&root, &report).unwrap();

        fs::write(root.join("asset.txt"), "changed").unwrap();
        let refreshed = read_validated_quality_report(&root).unwrap();
        assert_eq!(refreshed.status, "failed");
        assert!(
            refreshed
                .checks
                .iter()
                .any(|check| check.code == "installed-content-changed")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn custom_board_runtime_requires_exact_certified_package_identity() {
        assert!(!board_quality_report_is_runtime_usable(None, "acme-c6"));

        let mut report = crate::package_quality::PackageQualityReport::new("board");
        report.package_id = Some("acme-c6".to_string());
        report.pass("fixture", "fixture passed");
        report.finalize();
        assert!(board_quality_report_is_runtime_usable(
            Some(&report),
            "acme-c6"
        ));
        assert!(!board_quality_report_is_runtime_usable(
            Some(&report),
            "other-c6"
        ));

        report.validated_consumers.clear();
        assert!(!board_quality_report_is_runtime_usable(
            Some(&report),
            "acme-c6"
        ));
        report
            .validated_consumers
            .push("runtime-loader".to_string());
        report.status = "pending".to_string();
        assert!(!board_quality_report_is_runtime_usable(
            Some(&report),
            "acme-c6"
        ));
    }
}
