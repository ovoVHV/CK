use crate::package_quality::{
    PackageQualityReport, base_fqbn_scope, hash_package_contents,
    read_quality_report_with_integrity, resolve_contained_existing_subdir,
    runtime_quality_report_is_trusted, runtime_quality_report_is_trusted_for_package,
    safe_relative_path, valid_package_id as quality_package_id, valid_semver,
    validate_local_package_tree, write_quality_report,
};
use crate::runtime_trust::{RuntimeActivationInfo, runtime_activation_for_package};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const USER_INSTALL_MARKER: &str = ".ck-user-installed.json";
const MAX_REGISTRY_PACKAGE_FILES: usize = 2_000;
const MAX_REGISTRY_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_REGISTRY_PACKAGE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_LIBRARY_ARCHIVE_FILES: usize = 5_000;
const MAX_LIBRARY_ARCHIVE_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_LIBRARY_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;

fn mark_user_installed(target_dir: &Path, source: &str) -> Result<(), String> {
    let marker = serde_json::json!({
        "schema_version": 1,
        "installed_by": "ck-library-manager",
        "source": source,
    });
    let payload = serde_json::to_vec_pretty(&marker)
        .map_err(|e| format!("Failed to create install marker: {}", e))?;
    fs::write(target_dir.join(USER_INSTALL_MARKER), payload)
        .map_err(|e| format!("Failed to record library provenance: {}", e))
}

fn replace_directory_transactionally(staged: &Path, target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("Invalid install target: {}", target.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("Failed to create install root: {}", e))?;
    let target_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("library");
    let backup = parent.join(format!(
        ".ck-backup-{}-{}",
        target_name,
        uuid::Uuid::new_v4()
    ));

    let had_existing = target.exists();
    if had_existing {
        fs::rename(target, &backup)
            .map_err(|e| format!("Failed to preserve existing library: {}", e))?;
    }
    if let Err(install_error) = fs::rename(staged, target) {
        if had_existing {
            if let Err(restore_error) = fs::rename(&backup, target) {
                return Err(format!(
                    "Install failed ({}) and existing library restore failed ({})",
                    install_error, restore_error
                ));
            }
        }
        return Err(format!(
            "Failed to activate staged library: {}",
            install_error
        ));
    }
    if had_existing {
        let _ = fs::remove_dir_all(backup);
    }
    Ok(())
}

// --- Helper: Install from ZIP (Refactored from import_library) ---
pub fn install_library_from_zip(
    zip_path: &Path,
    library_scope_id: &str,
    subfolder: Option<String>,
    require_block_package: bool,
) -> Result<String, String> {
    // Open Zip
    let file = fs::File::open(zip_path).map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Invalid zip archive: {}", e))?;
    crate::package_quality::validate_zip_archive(
        &mut archive,
        MAX_LIBRARY_ARCHIVE_FILES,
        MAX_LIBRARY_ARCHIVE_FILE_BYTES,
        MAX_LIBRARY_ARCHIVE_BYTES,
    )?;

    // Resolve Path
    if !quality_package_id(library_scope_id, false) {
        return Err("Library install scope contains unsafe characters".to_string());
    }
    let libs_dir = super::ck_root_dir()
        .join("libraries")
        .join(library_scope_id);

    if !libs_dir.exists() {
        fs::create_dir_all(&libs_dir).map_err(|e| e.to_string())?;
    }

    // Create unique temp extraction dir
    let temp_dir = libs_dir.join(format!("_temp_{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;

    let res = (|| -> Result<String, String> {
        archive
            .extract(&temp_dir)
            .map_err(|e| format!("Extraction failed: {}", e))?;

        let extract_root = resolve_zip_extract_root(&temp_dir)?;
        let board_manifest_roots = discover_board_manifest_roots(&extract_root);

        // Find library.json
        let mut final_source = temp_dir.clone();

        // If specific subfolder requested (e.g. for Monorepo via GitHub Zipball)
        if let Some(sub) = subfolder {
            let specific_path = resolve_contained_existing_subdir(&extract_root, &sub)?;
            if specific_path.join("library.json").is_file() {
                final_source = specific_path;
            } else {
                return Err(format!(
                    "Subfolder '{}' not found or missing library.json",
                    sub
                ));
            }
        } else {
            // Normal Discovery Logic (Root or First-Level)
            if temp_dir.join("library.json").exists() {
                final_source = temp_dir.clone();
            } else {
                // Check subfolders (single root folder case)
                for entry in fs::read_dir(&temp_dir).map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    let path = entry.path();
                    if path.is_dir() && path.join("library.json").exists() {
                        final_source = path;
                        break;
                    }
                }
            }
        }

        let found_json = final_source.join("library.json").exists();

        if !found_json {
            if !board_manifest_roots.is_empty() {
                return Err(
                    "Detected board package (board.json). Please import it from Board Manager, not Library Manager."
                        .to_string(),
                );
            }
            return Err(
                "Invalid library package: 'library.json' not found at root or in top-level folder."
                    .to_string(),
            );
        }

        if board_manifest_roots
            .iter()
            .any(|root| final_source.starts_with(root))
        {
            return Err(
                "Detected board package contents (board.json + libraries). Please install from Board Manager."
                    .to_string(),
            );
        }

        let quality_report = inspect_library_package(&final_source, require_block_package);
        quality_report.enforce()?;

        // Read ID from library.json
        let json_content =
            fs::read_to_string(final_source.join("library.json")).map_err(|e| e.to_string())?;
        let json: serde_json::Value = serde_json::from_str(strip_utf8_bom(&json_content))
            .map_err(|e| format!("Invalid library.json: {}", e))?;

        let id = json["id"]
            .as_str()
            .ok_or("library.json missing 'id' field")?
            .to_string();

        let safe_id = id;

        write_quality_report(&final_source, &quality_report)?;
        let target_dir = libs_dir.join(&safe_id);
        mark_user_installed(
            &final_source,
            if require_block_package {
                "local"
            } else {
                "registry"
            },
        )?;
        replace_directory_transactionally(&final_source, &target_dir)?;

        Ok(safe_id)
    })();

    // Cleanup temp
    let _ = fs::remove_dir_all(&temp_dir);
    res
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

fn strip_utf8_bom(input: &str) -> &str {
    input.strip_prefix('\u{feff}').unwrap_or(input)
}

fn normalized_package_subdir(value: &str) -> Result<String, String> {
    let relative = safe_relative_path(value)
        .filter(|path| {
            path.components()
                .any(|component| component != std::path::Component::CurDir)
        })
        .ok_or_else(|| format!("Unsafe package subdirectory: {}", value))?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn resolve_zip_extract_root(temp_dir: &Path) -> Result<PathBuf, String> {
    let entries: Vec<std::fs::DirEntry> = std::fs::read_dir(temp_dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    if entries.len() == 1 && entries[0].path().is_dir() {
        return Ok(entries[0].path());
    }
    Ok(temp_dir.to_path_buf())
}

fn discover_board_manifest_roots(root: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .max_depth(6)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if path.is_file() && path.file_name().and_then(|n| n.to_str()) == Some("board.json") {
            if let Some(parent) = path.parent() {
                out.push(parent.to_path_buf());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

fn validate_block_library_layout(root: &Path) -> Result<PackageQualityReport, String> {
    let report = inspect_library_package(root, true);
    report.enforce()?;
    Ok(report)
}

fn push_arch_tokens(out: &mut Vec<String>, raw: &str) {
    for token in raw.split(',') {
        let t = token.trim().to_lowercase();
        if t.is_empty() {
            continue;
        }
        if !out.iter().any(|v| v == &t) {
            out.push(t);
        }
    }
}

fn parse_architectures_from_library_json(json: &serde_json::Value) -> Vec<String> {
    let mut architectures: Vec<String> = Vec::new();

    if let Some(s) = json["architecture"].as_str() {
        push_arch_tokens(&mut architectures, s);
    }
    if let Some(s) = json["architectures"].as_str() {
        push_arch_tokens(&mut architectures, s);
    }
    if let Some(arr) = json["architectures"].as_array() {
        for a in arr {
            if let Some(s) = a.as_str() {
                push_arch_tokens(&mut architectures, s);
            }
        }
    }
    if let Some(s) = json["platform"].as_str() {
        push_arch_tokens(&mut architectures, s);
    }
    if let Some(s) = json["platforms"].as_str() {
        push_arch_tokens(&mut architectures, s);
    }
    if let Some(arr) = json["platforms"].as_array() {
        for a in arr {
            if let Some(s) = a.as_str() {
                push_arch_tokens(&mut architectures, s);
            }
        }
    }

    if architectures.is_empty() {
        architectures.push("*".to_string());
    }

    architectures
}

// --- Commands ---

#[tauri::command]
pub async fn fetch_custom_registry(
    url: String,
    provider: Option<String>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("CK-Desktop/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let provider = provider
        .unwrap_or_else(|| "auto".to_string())
        .trim()
        .to_lowercase();
    let auto_mode = provider.is_empty() || provider == "auto";
    let use_github = provider == "github" || (auto_mode && url.contains("github.com"));
    let use_gitee = provider == "gitee" || (auto_mode && url.contains("gitee.com"));

    if use_gitee {
        // Parse "https://gitee.com/owner/repo(.git)"
        let clean_url = url.trim_end_matches(".git");
        let parts: Vec<&str> = clean_url.split("gitee.com/").collect();
        if parts.len() < 2 {
            return Err("Invalid Gitee URL".to_string());
        }
        let path_parts: Vec<&str> = parts[1].split('/').filter(|s| !s.is_empty()).collect();
        if path_parts.len() < 2 {
            return Err("Invalid Gitee Repo Format".to_string());
        }
        let owner = path_parts[0];
        let repo = path_parts[1];

        // 1) Resolve default branch
        let api_url = format!("https://gitee.com/api/v5/repos/{}/{}", owner, repo);
        let mut default_branch = "master".to_string();
        if let Ok(resp) = client.get(&api_url).send().await {
            if resp.status().is_success() {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    if let Some(db) = json["default_branch"].as_str() {
                        default_branch = db.to_string();
                    }
                }
            }
        }

        // 2) Recursive tree scan (monorepo support)
        let tree_url = format!(
            "https://gitee.com/api/v5/repos/{}/{}/git/trees/{}?recursive=1",
            owner, repo, default_branch
        );

        let mut manifest_libraries = Vec::new();
        let mut has_board_package = false;

        if let Ok(tree_resp) = client.get(&tree_url).send().await {
            if tree_resp.status().is_success() {
                if let Ok(tree_json) = tree_resp.json::<serde_json::Value>().await {
                    if let Some(tree_arr) = tree_json["tree"].as_array() {
                        let mut board_roots: Vec<String> = tree_arr
                            .iter()
                            .filter_map(|node| {
                                if node["type"].as_str() != Some("blob") {
                                    return None;
                                }
                                let path = node["path"].as_str()?;
                                if !path.ends_with("board.json") {
                                    return None;
                                }
                                let parent = std::path::Path::new(path)
                                    .parent()
                                    .and_then(|p| p.to_str())
                                    .unwrap_or("")
                                    .trim_matches('/')
                                    .replace('\\', "/");
                                Some(parent)
                            })
                            .collect();
                        board_roots.sort();
                        board_roots.dedup();
                        has_board_package = !board_roots.is_empty();

                        let mut seen_manifest_paths = std::collections::HashSet::new();
                        for node in tree_arr {
                            if node["type"].as_str() != Some("blob") {
                                continue;
                            }
                            let Some(path) = node["path"].as_str() else {
                                continue;
                            };
                            if !path.ends_with("library.json") {
                                continue;
                            }

                            let parent = std::path::Path::new(path)
                                .parent()
                                .and_then(|p| p.to_str())
                                .unwrap_or("")
                                .trim_matches('/')
                                .replace('\\', "/");

                            let inside_board_package = board_roots.iter().any(|root| {
                                root.is_empty()
                                    || parent == *root
                                    || parent.starts_with(&format!("{}/", root))
                            });
                            if inside_board_package {
                                continue;
                            }

                            if !seen_manifest_paths.insert(path.to_string()) {
                                continue;
                            }

                            let raw_url = format!(
                                "https://gitee.com/{}/{}/raw/{}/{}",
                                owner, repo, default_branch, path
                            );
                            let lib_resp = match client.get(&raw_url).send().await {
                                Ok(v) => v,
                                Err(_) => continue,
                            };
                            if !lib_resp.status().is_success() {
                                continue;
                            }
                            let lib_text = match lib_resp.text().await {
                                Ok(v) => v,
                                Err(_) => continue,
                            };
                            let lib_json = match serde_json::from_str::<serde_json::Value>(
                                strip_utf8_bom(&lib_text),
                            ) {
                                Ok(v) => v,
                                Err(_) => continue,
                            };

                            let parent_opt = if parent.is_empty() {
                                None
                            } else {
                                Some(parent.clone())
                            };
                            let fallback_name = if let Some(p) = &parent_opt {
                                std::path::Path::new(p)
                                    .file_name()
                                    .and_then(|s| s.to_str())
                                    .unwrap_or(repo)
                                    .to_string()
                            } else {
                                repo.to_string()
                            };

                            let name = lib_json["name"]
                                .as_str()
                                .unwrap_or(&fallback_name)
                                .to_string();
                            let id = lib_json["id"]
                                .as_str()
                                .unwrap_or(&fallback_name)
                                .to_string();
                            let ver = lib_json["version"].as_str().unwrap_or("1.0.0").to_string();
                            let desc = lib_json["description"]
                                .as_str()
                                .or_else(|| lib_json["sentence"].as_str())
                                .unwrap_or("Library from source")
                                .to_string();
                            let author = lib_json["author"].as_str().unwrap_or(owner).to_string();
                            let architectures = parse_architectures_from_library_json(&lib_json);

                            // Use gitee-raw:// scheme so install_library_from_url
                            // downloads files individually via Gitee raw API
                            // (Gitee archive URLs return HTML, not ZIP)
                            let mut zip_url = if let Some(subdir) = &parent_opt {
                                format!(
                                    "gitee-raw://{}/{}/{}#{}",
                                    owner, repo, default_branch, subdir
                                )
                            } else {
                                format!("gitee-raw://{}/{}/{}", owner, repo, default_branch)
                            };

                            manifest_libraries.push(serde_json::json!({
                                "id": id,
                                "name": name,
                                "version": ver,
                                "author": author,
                                "description": desc,
                                "url": zip_url,
                                "icon": "",
                                "architectures": architectures
                            }));
                        }
                    }
                }
            }
        }

        if manifest_libraries.is_empty() && has_board_package {
            return Err(
                "Repository appears to be a board package. Please import it from Board Manager."
                    .to_string(),
            );
        }
        if manifest_libraries.is_empty() {
            return Err("No library.json found in this Gitee repository.".to_string());
        }

        let registry = serde_json::json!({ "libraries": manifest_libraries });
        return Ok(registry.to_string());
    }

    // GitHub Auto-Discovery Logic
    if use_github
        && url.contains("github.com")
        && !url.ends_with(".json")
        && !url.contains("raw.githubusercontent.com")
    {
        // Try to parse owner/repo
        // Supported formats:
        // https://github.com/owner/repo
        // https://github.com/owner/repo/
        let parts: Vec<&str> = url.split('/').collect();
        // Index of "github.com"
        if let Some(idx) = parts.iter().position(|&r| r.contains("github.com")) {
            if idx + 2 < parts.len() {
                let owner = parts[idx + 1];
                let repo = parts[idx + 2].trim_end_matches(".git");

                // Use /releases?per_page=1 to get latest release metadata as fallback.
                let api_url = format!(
                    "https://api.github.com/repos/{}/{}/releases?per_page=1",
                    owner, repo
                );

                let resp = client
                    .get(&api_url)
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

                // Release-derived entries are fallback only.
                let mut release_libraries = Vec::new();
                // Manifest-derived entries are preferred (accurate arch/compat fields).
                let mut manifest_libraries = Vec::new();

                // 1. Try to get Releases
                if let Some(arr) = json.as_array() {
                    if let Some(release) = arr.get(0) {
                        let version = release["tag_name"].as_str().unwrap_or("latest").to_string();
                        if let Some(assets) = release["assets"].as_array() {
                            for asset in assets {
                                let name = asset["name"].as_str().unwrap_or("");
                                if name.ends_with(".zip") {
                                    let download_url = asset["browser_download_url"]
                                        .as_str()
                                        .unwrap_or("")
                                        .to_string();
                                    let file_stem = std::path::Path::new(name)
                                        .file_stem()
                                        .and_then(|s| s.to_str())
                                        .unwrap_or(name)
                                        .to_string();

                                    // Architecture Detection
                                    let mut architectures = Vec::new();
                                    let lower_name = file_stem.to_lowercase();
                                    if lower_name.contains("esp32c5") {
                                        architectures.push("esp32c5");
                                    } else if lower_name.contains("esp32c3") {
                                        architectures.push("esp32c3");
                                    } else if lower_name.contains("esp32") {
                                        architectures.push("esp32");
                                    } else if lower_name.contains("avr")
                                        || lower_name.contains("uno")
                                    {
                                        architectures.push("avr");
                                    } else {
                                        architectures.push("*");
                                    }

                                    release_libraries.push(serde_json::json!({
                                        "id": file_stem.clone(),
                                        "name": file_stem,
                                        "version": version,
                                        "author": owner,
                                        "description": format!("Release {}", version),
                                        "url": download_url,
                                        "icon": "",
                                        "architectures": architectures
                                    }));
                                }
                            }
                        }
                    }
                }

                // 2. Try to discover library.json files from source tree (recursive monorepo support)
                let repo_url = format!("https://api.github.com/repos/{}/{}", owner, repo);
                if let Ok(repo_resp) = client.get(&repo_url).send().await {
                    if repo_resp.status().is_success() {
                        if let Ok(repo_json) = repo_resp.json::<serde_json::Value>().await {
                            if let Some(default_branch) = repo_json["default_branch"].as_str() {
                                let tree_url = format!(
                                    "https://api.github.com/repos/{}/{}/git/trees/{}?recursive=1",
                                    owner, repo, default_branch
                                );
                                if let Ok(tree_resp) = client.get(&tree_url).send().await {
                                    if tree_resp.status().is_success() {
                                        if let Ok(tree_json) =
                                            tree_resp.json::<serde_json::Value>().await
                                        {
                                            if let Some(tree_arr) = tree_json["tree"].as_array() {
                                                let mut board_roots: Vec<String> = tree_arr
                                                    .iter()
                                                    .filter_map(|node| {
                                                        if node["type"].as_str() != Some("blob") {
                                                            return None;
                                                        }
                                                        let path = node["path"].as_str()?;
                                                        if !path.ends_with("board.json") {
                                                            return None;
                                                        }
                                                        let parent = std::path::Path::new(path)
                                                            .parent()
                                                            .and_then(|p| p.to_str())
                                                            .unwrap_or("")
                                                            .trim_matches('/')
                                                            .replace('\\', "/");
                                                        Some(parent)
                                                    })
                                                    .collect();
                                                board_roots.sort();
                                                board_roots.dedup();
                                                let has_board_package = !board_roots.is_empty();

                                                let mut seen_manifest_paths =
                                                    std::collections::HashSet::new();
                                                for node in tree_arr {
                                                    if node["type"].as_str() != Some("blob") {
                                                        continue;
                                                    }
                                                    let Some(path) = node["path"].as_str() else {
                                                        continue;
                                                    };
                                                    if !path.ends_with("library.json") {
                                                        continue;
                                                    }

                                                    let parent = std::path::Path::new(path)
                                                        .parent()
                                                        .and_then(|p| p.to_str())
                                                        .unwrap_or("")
                                                        .trim_matches('/')
                                                        .replace('\\', "/");

                                                    let inside_board_package =
                                                        board_roots.iter().any(|root| {
                                                            root.is_empty()
                                                                || parent == *root
                                                                || parent.starts_with(&format!(
                                                                    "{}/",
                                                                    root
                                                                ))
                                                        });
                                                    if inside_board_package {
                                                        continue;
                                                    }

                                                    if !seen_manifest_paths.insert(path.to_string())
                                                    {
                                                        continue;
                                                    }

                                                    let raw_url = format!(
                                                        "https://raw.githubusercontent.com/{}/{}/{}/{}",
                                                        owner, repo, default_branch, path
                                                    );
                                                    let lib_resp =
                                                        match client.get(&raw_url).send().await {
                                                            Ok(v) => v,
                                                            Err(_) => continue,
                                                        };
                                                    if !lib_resp.status().is_success() {
                                                        continue;
                                                    }
                                                    let lib_text = match lib_resp.text().await {
                                                        Ok(v) => v,
                                                        Err(_) => continue,
                                                    };
                                                    let lib_json = match serde_json::from_str::<
                                                        serde_json::Value,
                                                    >(
                                                        strip_utf8_bom(&lib_text)
                                                    ) {
                                                        Ok(v) => v,
                                                        Err(_) => continue,
                                                    };

                                                    let parent_opt = if parent.is_empty() {
                                                        None
                                                    } else {
                                                        Some(parent.clone())
                                                    };
                                                    let fallback_name = if let Some(p) = &parent_opt
                                                    {
                                                        std::path::Path::new(p)
                                                            .file_name()
                                                            .and_then(|s| s.to_str())
                                                            .unwrap_or(repo)
                                                            .to_string()
                                                    } else {
                                                        repo.to_string()
                                                    };

                                                    let name = lib_json["name"]
                                                        .as_str()
                                                        .unwrap_or(&fallback_name)
                                                        .to_string();
                                                    let id = lib_json["id"]
                                                        .as_str()
                                                        .unwrap_or(&fallback_name)
                                                        .to_string();
                                                    let ver = lib_json["version"]
                                                        .as_str()
                                                        .unwrap_or("1.0.0")
                                                        .to_string();
                                                    let desc = lib_json["description"]
                                                        .as_str()
                                                        .or_else(|| lib_json["sentence"].as_str())
                                                        .unwrap_or("Library from source")
                                                        .to_string();
                                                    let author = lib_json["author"]
                                                        .as_str()
                                                        .unwrap_or(owner)
                                                        .to_string();
                                                    let architectures =
                                                        parse_architectures_from_library_json(
                                                            &lib_json,
                                                        );

                                                    let mut zip_url = format!(
                                                        "https://api.github.com/repos/{}/{}/zipball/{}",
                                                        owner, repo, default_branch
                                                    );
                                                    if let Some(subdir) = &parent_opt {
                                                        zip_url = format!(
                                                            "{}#subdir={}",
                                                            zip_url, subdir
                                                        );
                                                    }

                                                    manifest_libraries.push(serde_json::json!({
                                                        "id": id,
                                                        "name": name,
                                                        "version": ver,
                                                        "author": author,
                                                        "description": desc,
                                                        "url": zip_url,
                                                        "icon": "",
                                                        "architectures": architectures
                                                    }));
                                                }

                                                if manifest_libraries.is_empty()
                                                    && has_board_package
                                                {
                                                    return Err(
                                                        "Repository appears to be a board package. Please import it from Board Manager."
                                                            .to_string(),
                                                    );
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                let libraries = if !manifest_libraries.is_empty() {
                    manifest_libraries
                } else {
                    release_libraries
                };

                if libraries.is_empty() {
                    return Err("No Releases (.zip) or Source (library.json) found.".to_string());
                }

                // Return synthetic registry
                let registry = serde_json::json!({
                    "libraries": libraries
                });
                return Ok(registry.to_string());
            }
        }
    }

    // Default: Fetch simple JSON
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Request failed: {}", resp.status()));
    }

    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(text)
}

/// Return the contents of install_debug.log (for frontend diagnostic)
#[tauri::command]
pub fn get_install_debug_log() -> Result<String, String> {
    let log_path = super::ck_root_dir().join("install_debug.log");
    if log_path.exists() {
        std::fs::read_to_string(&log_path).map_err(|e| e.to_string())
    } else {
        Ok(format!("No log file found at {:?}", log_path))
    }
}

/// Append a line to the diagnostic log at ck_root_dir()/install_debug.log
fn debug_log(msg: &str) {
    let log_path = super::ck_root_dir().join("install_debug.log");
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("[{}] {}\n", timestamp, msg);
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .and_then(|mut f| f.write_all(line.as_bytes()));
}

#[tauri::command]
pub async fn install_library_from_url(
    app: AppHandle,
    url: String,
    board: String,
    board_package_id: Option<String>,
) -> Result<String, String> {
    let library_scope_id = library_install_scope_id(&app, &board, board_package_id.as_deref())?;
    debug_log("=== install_library_from_url START ===");
    debug_log(&format!("ck_root_dir = {:?}", super::ck_root_dir()));
    debug_log(&format!("url = {}, board = {}", url, board));

    // Check for fragment (subdir or gitee-raw path)
    let (clean_url, subdir) = if let Some(idx) = url.find('#') {
        let frag = url[idx + 1..].to_string();
        let sub = if frag.starts_with("subdir=") {
            Some(normalized_package_subdir(&frag["subdir=".len()..])?)
        } else {
            Some(normalized_package_subdir(&frag)?)
        };
        (&url[..idx], sub)
    } else {
        (url.as_str(), None)
    };

    let client = reqwest::Client::builder()
        .user_agent("CK-Desktop/1.0")
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| {
            let msg = format!("Client error: {}", e);
            debug_log(&msg);
            msg
        })?;

    // --- gitee-raw:// scheme: download files individually via Gitee raw API ---
    if url.starts_with("gitee-raw://") {
        // Format: gitee-raw://{owner}/{repo}/{branch}#{subdir}
        let path_part = clean_url.trim_start_matches("gitee-raw://");
        let parts: Vec<&str> = path_part.splitn(3, '/').collect();
        if parts.len() < 3 {
            return Err(format!("Invalid gitee-raw URL: {}", url));
        }
        let (owner, repo, branch) = (parts[0], parts[1], parts[2]);
        debug_log(&format!(
            "gitee-raw -> owner={}, repo={}, branch={}, subdir={:?}",
            owner, repo, branch, subdir
        ));
        let result = install_gitee_raw_inner(
            &client,
            owner,
            repo,
            branch,
            subdir.as_deref(),
            &library_scope_id,
        )
        .await;
        match &result {
            Ok(id) => debug_log(&format!("Gitee install OK: id={}", id)),
            Err(e) => debug_log(&format!("Gitee install FAILED: {}", e)),
        }
        debug_log("=== install_library_from_url END ===");
        return result;
    }

    // --- Gitee archive URL fallback (legacy URLs) ---
    if clean_url.contains("gitee.com") && clean_url.contains("/repository/archive/") {
        debug_log("Detected Gitee archive URL -> switching to raw-file download");
        let result =
            install_gitee_via_raw(&client, clean_url, subdir.as_deref(), &library_scope_id).await;
        match &result {
            Ok(id) => debug_log(&format!("Gitee install OK: id={}", id)),
            Err(e) => debug_log(&format!("Gitee install FAILED: {}", e)),
        }
        debug_log("=== install_library_from_url END ===");
        return result;
    }

    // --- Normal ZIP download (GitHub, direct URLs) ---
    let download_url = if clean_url.contains("api.github.com") && clean_url.contains("/zipball/") {
        if clean_url.contains("/repos/") {
            let after_repos = clean_url.split("/repos/").nth(1).unwrap_or("");
            let segments: Vec<&str> = after_repos.split('/').collect();
            if segments.len() >= 4 {
                format!(
                    "https://github.com/{}/{}/archive/refs/heads/{}.zip",
                    segments[0], segments[1], segments[3]
                )
            } else {
                clean_url.to_string()
            }
        } else {
            clean_url.to_string()
        }
    } else {
        clean_url.to_string()
    };

    debug_log(&format!("download_url = {}", download_url));
    let res = client.get(&download_url).send().await.map_err(|e| {
        let msg = format!("Download failed: {}", e);
        debug_log(&msg);
        msg
    })?;

    let status = res.status();
    let content_type = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string();
    debug_log(&format!("HTTP {}, content-type: {}", status, content_type));

    if !status.is_success() {
        let msg = format!("Download error: {}", status);
        debug_log(&msg);
        return Err(msg);
    }

    let body_bytes = res.bytes().await.map_err(|e| {
        let msg = format!("Read body failed: {}", e);
        debug_log(&msg);
        msg
    })?;
    debug_log(&format!("Downloaded {} bytes", body_bytes.len()));

    // Validate ZIP magic bytes
    if body_bytes.len() < 4 || body_bytes[0] != 0x50 || body_bytes[1] != 0x4B {
        let preview = String::from_utf8_lossy(&body_bytes[..std::cmp::min(500, body_bytes.len())]);
        let msg = format!(
            "下载的文件不是ZIP格式 ({})\n预览: {}",
            content_type, preview
        );
        debug_log(&msg);
        return Err(msg);
    }

    let temp_path = std::env::temp_dir().join(format!("ck_lib_{}.zip", uuid::Uuid::new_v4()));
    fs::write(&temp_path, &body_bytes).map_err(|e| {
        let msg = e.to_string();
        debug_log(&msg);
        msg
    })?;

    let install_res = install_library_from_zip(&temp_path, &library_scope_id, subdir, false);
    match &install_res {
        Ok(id) => debug_log(&format!("Install OK: {}", id)),
        Err(e) => debug_log(&format!("Install FAILED: {}", e)),
    }
    let _ = fs::remove_file(&temp_path);
    debug_log("=== install_library_from_url END ===");
    install_res
}

/// Install a library from Gitee by downloading files individually via raw URLs.
/// Gitee's /repository/archive/ endpoint returns HTML (requires JS rendering),
/// so we use the API to get the file tree, then download each file via /raw/ endpoint.
async fn install_gitee_via_raw(
    client: &reqwest::Client,
    archive_url: &str,
    subdir: Option<&str>,
    library_scope_id: &str,
) -> Result<String, String> {
    // Parse owner/repo/branch from archive URL
    // Format: https://gitee.com/{owner}/{repo}/repository/archive/{branch}.zip
    let without_scheme = archive_url
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let parts: Vec<&str> = without_scheme.split('/').collect();
    if parts.len() < 6 {
        return Err(format!("Invalid Gitee archive URL: {}", archive_url));
    }
    let owner = parts[1];
    let repo = parts[2];
    let branch = parts[5]
        .trim_end_matches(".zip")
        .trim_end_matches(".tar.gz");
    install_gitee_raw_inner(client, owner, repo, branch, subdir, library_scope_id).await
}

/// Core Gitee raw-file download logic.
async fn install_gitee_raw_inner(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    branch: &str,
    subdir: Option<&str>,
    library_scope_id: &str,
) -> Result<String, String> {
    debug_log(&format!(
        "Gitee raw: owner={}, repo={}, branch={}, subdir={:?}",
        owner, repo, branch, subdir
    ));

    // 1. Fetch file tree via API
    let tree_url = format!(
        "https://gitee.com/api/v5/repos/{}/{}/git/trees/{}?recursive=1",
        owner, repo, branch
    );
    debug_log(&format!("Fetching tree: {}", tree_url));
    let tree_resp = client
        .get(&tree_url)
        .send()
        .await
        .map_err(|e| format!("Gitee tree API failed: {}", e))?;
    if !tree_resp.status().is_success() {
        return Err(format!("Gitee tree API error: {}", tree_resp.status()));
    }
    let tree_json: serde_json::Value = tree_resp
        .json()
        .await
        .map_err(|e| format!("Parse tree JSON failed: {}", e))?;
    let tree_arr = tree_json["tree"]
        .as_array()
        .ok_or("Gitee tree has no 'tree' array")?;

    // 2. Filter files by subdir prefix
    let prefix = subdir
        .map(normalized_package_subdir)
        .transpose()?
        .unwrap_or_default();
    let prefix_with_slash = if prefix.is_empty() {
        String::new()
    } else {
        format!("{}/", prefix)
    };
    let mut files: Vec<(String, String)> = Vec::new(); // (relative_path, raw_url)
    for node in tree_arr {
        if node["type"].as_str() != Some("blob") {
            continue;
        }
        let Some(path) = node["path"].as_str() else {
            continue;
        };
        let relative = if prefix.is_empty() {
            path.to_string()
        } else if let Some(rel) = path.strip_prefix(&prefix_with_slash) {
            rel.to_string()
        } else {
            continue;
        };
        if relative.is_empty() {
            continue;
        }
        let raw_url = format!(
            "https://gitee.com/{}/{}/raw/{}/{}",
            owner, repo, branch, path
        );
        files.push((relative, raw_url));
    }

    if files.is_empty() {
        return Err(format!(
            "No files found{}",
            if prefix.is_empty() {
                String::new()
            } else {
                format!(" under '{}'", prefix)
            }
        ));
    }
    debug_log(&format!("{} files to download", files.len()));

    // 3. Must have library.json
    if !files.iter().any(|(rel, _)| rel == "library.json") {
        return Err("library.json not found in target directory".to_string());
    }
    if files.len() > MAX_REGISTRY_PACKAGE_FILES {
        return Err(format!(
            "Registry package has too many files: {} > {}",
            files.len(),
            MAX_REGISTRY_PACKAGE_FILES
        ));
    }

    // 4. Download into a same-volume staging directory. The installed version
    // remains untouched until every file passes the quality gate.
    if !quality_package_id(library_scope_id, false) {
        return Err("Library install scope contains unsafe characters".to_string());
    }
    let libraries_dir = super::ck_root_dir()
        .join("libraries")
        .join(library_scope_id);
    fs::create_dir_all(&libraries_dir).map_err(|e| format!("mkdir failed: {}", e))?;
    let staging_dir = libraries_dir.join(format!(".ck-staging-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&staging_dir).map_err(|e| format!("staging mkdir failed: {}", e))?;

    let total = files.len();
    let mut ok = 0usize;
    let mut total_bytes = 0u64;
    for (rel, raw_url) in &files {
        let relative_path = match safe_relative_path(rel) {
            Some(path) => path,
            None => {
                let _ = fs::remove_dir_all(&staging_dir);
                return Err(format!("Unsafe registry package path: {}", rel));
            }
        };
        let dest = staging_dir.join(relative_path);
        if let Some(p) = dest.parent() {
            fs::create_dir_all(p).map_err(|e| {
                let _ = fs::remove_dir_all(&staging_dir);
                format!("Failed to create staging directory for {}: {}", rel, e)
            })?;
        }
        match client.get(raw_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                if resp
                    .content_length()
                    .is_some_and(|length| length > MAX_REGISTRY_FILE_BYTES)
                {
                    let _ = fs::remove_dir_all(&staging_dir);
                    return Err(format!("Registry file is too large: {}", rel));
                }
                if let Ok(bytes) = resp.bytes().await {
                    let length = bytes.len() as u64;
                    total_bytes = total_bytes.saturating_add(length);
                    if length > MAX_REGISTRY_FILE_BYTES || total_bytes > MAX_REGISTRY_PACKAGE_BYTES
                    {
                        let _ = fs::remove_dir_all(&staging_dir);
                        return Err(format!(
                            "Registry package exceeds size limits while downloading {}",
                            rel
                        ));
                    }
                    if fs::write(&dest, &bytes).is_ok() {
                        ok += 1;
                        continue;
                    }
                }
                debug_log(&format!("Failed to save: {}", rel));
            }
            Ok(resp) => debug_log(&format!("HTTP {} for {}", resp.status(), rel)),
            Err(e) => debug_log(&format!("Error downloading {}: {}", rel, e)),
        }
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(format!("Failed to download registry file: {}", rel));
    }
    debug_log(&format!(
        "Downloaded {}/{} files ({} bytes) into staging",
        ok, total, total_bytes
    ));

    if ok != total {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(format!(
            "Incomplete registry package: {}/{} files",
            ok, total
        ));
    }

    let install_result = (|| -> Result<String, String> {
        let quality_report = inspect_library_package(&staging_dir, false);
        quality_report.enforce()?;
        let library_json = fs::read_to_string(staging_dir.join("library.json"))
            .map_err(|e| format!("Failed to read staged library.json: {}", e))?;
        let manifest: serde_json::Value = serde_json::from_str(strip_utf8_bom(&library_json))
            .map_err(|e| format!("Invalid staged library.json: {}", e))?;
        let id = manifest["id"]
            .as_str()
            .ok_or("library.json missing 'id'")?
            .to_string();
        if !quality_package_id(&id, false) {
            return Err(format!("Invalid library package id: {}", id));
        }
        debug_log(&format!("Library id={} passed quality gate", id));
        write_quality_report(&staging_dir, &quality_report)?;
        mark_user_installed(&staging_dir, "registry")?;
        replace_directory_transactionally(&staging_dir, &libraries_dir.join(&id))?;
        Ok(id)
    })();
    if install_result.is_err() {
        let _ = fs::remove_dir_all(&staging_dir);
    }
    install_result
}

#[tauri::command]
pub async fn import_library(
    app: AppHandle,
    path: String,
    board: String,
    board_package_id: Option<String>,
) -> Result<String, String> {
    let p = PathBuf::from(path);
    let library_scope_id = library_install_scope_id(&app, &board, board_package_id.as_deref())?;

    if let Some(ext) = p.extension() {
        if ext.eq_ignore_ascii_case("json") {
            if p.file_name().and_then(|name| name.to_str()) != Some("library.json") {
                return Err(
                    "Local library import must select the standard library.json manifest."
                        .to_string(),
                );
            }
            // Import from local JSON file by copying its parent directory
            let parent_dir = p.parent().ok_or("Invalid JSON path")?;
            if !parent_dir.join(BLOCK_PACKAGE_MANIFEST_FILE).is_file() {
                return Err(format!(
                    "Local block library import requires {} next to library.json.",
                    BLOCK_PACKAGE_MANIFEST_FILE
                ));
            }
            validate_local_package_tree(
                parent_dir,
                MAX_LIBRARY_ARCHIVE_FILES,
                MAX_LIBRARY_ARCHIVE_FILE_BYTES,
                MAX_LIBRARY_ARCHIVE_BYTES,
            )?;

            // Resolve Path
            let libs_dir = super::ck_root_dir()
                .join("libraries")
                .join(&library_scope_id);
            if !libs_dir.exists() {
                fs::create_dir_all(&libs_dir).map_err(|e| e.to_string())?;
            }

            // Read ID from library.json
            let json_content = fs::read_to_string(&p).map_err(|e| e.to_string())?;
            let json: serde_json::Value = serde_json::from_str(strip_utf8_bom(&json_content))
                .map_err(|e| format!("Invalid library.json: {}", e))?;

            let id = json["id"]
                .as_str()
                .ok_or("library.json missing 'id' field")?
                .to_string();

            let safe_id = id;
            let target_dir = libs_dir.join(&safe_id);
            let staging_dir = libs_dir.join(format!(".ck-staging-{}", uuid::Uuid::new_v4()));
            let install_result = (|| -> Result<String, String> {
                copy_dir_recursive(parent_dir, &staging_dir)
                    .map_err(|e| format!("Failed to stage library files: {}", e))?;
                validate_local_package_tree(
                    &staging_dir,
                    MAX_LIBRARY_ARCHIVE_FILES,
                    MAX_LIBRARY_ARCHIVE_FILE_BYTES,
                    MAX_LIBRARY_ARCHIVE_BYTES,
                )?;
                let quality_report = validate_block_library_layout(&staging_dir)?;
                write_quality_report(&staging_dir, &quality_report)?;
                mark_user_installed(&staging_dir, "local")?;
                replace_directory_transactionally(&staging_dir, &target_dir)?;
                Ok(safe_id)
            })();
            if install_result.is_err() {
                let _ = fs::remove_dir_all(staging_dir);
            }
            return install_result;
        }
    }

    install_library_from_zip(&p, &library_scope_id, None, true)
}

// --- Library Manager ---

const BLOCK_PACKAGE_MANIFEST_FILE: &str = "ck-blocks.json";
const STANDARD_BLOCKS_PATH: &str = "blocks/blocks.json";
const STANDARD_GENERATOR_PATH: &str = "blocks/ck-generator.json";
const STANDARD_TOOLBOX_PATH: &str = "blocks/toolbox.json";

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, Default)]
pub struct BlockPackageCompatibility {
    #[serde(default)]
    pub boards: Vec<String>,
    #[serde(default)]
    pub architectures: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, Default)]
pub struct BlockPackageEntrypoints {
    pub blocks: Option<String>,
    pub generator: Option<String>,
    pub toolbox: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct BlockPackageLicense {
    pub spdx_id: String,
    pub file: String,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct BlockManifestEntry {
    #[serde(rename = "type")]
    pub block_type: String,
    pub display_name: String,
    pub description: String,
    pub category: Option<String>,
    pub kind: Option<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub fields: Vec<serde_json::Value>,
    #[serde(default)]
    pub inputs: Vec<serde_json::Value>,
    pub output: Option<serde_json::Value>,
    #[serde(default)]
    pub requires: Vec<String>,
    #[serde(default)]
    pub examples: Vec<serde_json::Value>,
    pub semantics: Option<serde_json::Value>,
    #[serde(default)]
    pub dependencies: Vec<serde_json::Value>,
    pub hardware: Option<serde_json::Value>,
    pub generation: Option<serde_json::Value>,
    #[serde(default)]
    pub constraints: Vec<serde_json::Value>,
    #[serde(default)]
    pub errors: Vec<serde_json::Value>,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct BlockPackageManifest {
    pub schema_version: u32,
    pub id: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    pub license: Option<BlockPackageLicense>,
    #[serde(default)]
    pub compatibility: BlockPackageCompatibility,
    #[serde(default)]
    pub dependencies: Vec<serde_json::Value>,
    #[serde(default)]
    pub entrypoints: BlockPackageEntrypoints,
    #[serde(default)]
    pub blocks: Vec<BlockManifestEntry>,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct BlockSearchEntry {
    #[serde(rename = "type")]
    pub block_type: String,
    pub category: Option<String>,
    pub display_name: String,
    pub description: String,
    pub kind: Option<String>,
    pub keywords: Vec<String>,
    pub fields: Vec<serde_json::Value>,
    pub inputs: Vec<serde_json::Value>,
    pub output: Option<serde_json::Value>,
    pub requires: Vec<String>,
    pub metadata_schema_version: u32,
    pub metadata_source: String,
    pub metadata_completeness: Vec<String>,
    pub semantics: Option<serde_json::Value>,
    pub dependencies: Vec<serde_json::Value>,
    pub output_contract: Option<serde_json::Value>,
    pub hardware: Option<serde_json::Value>,
    pub generation: Option<serde_json::Value>,
    pub constraints: Vec<serde_json::Value>,
    pub examples: Vec<serde_json::Value>,
    pub errors: Vec<serde_json::Value>,
    pub package_license: Option<BlockPackageLicense>,
    pub library_id: String,
    pub source: String,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct LibraryDiagnostic {
    pub code: String,
    pub message: String,
    pub severity: String,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, Default)]
pub struct ResolvedBlockEntrypoints {
    pub blocks: Option<String>,
    pub generator: Option<String>,
    pub toolbox: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct LibraryManifest {
    pub name: String,
    pub version: String,
    pub author: Option<String>,
    pub maintainer: Option<String>,
    pub sentence: Option<String>,
    pub paragraph: Option<String>,
    pub website: Option<String>,
    pub category: Option<String>,
    pub architectures: Option<Vec<String>>,
    pub includes: Option<Vec<String>>,
    pub id: Option<String>, // Extended field
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct LibraryInfo {
    pub id: String, // Folder name or ID from json
    pub entry_key: String,
    pub folder_name: String,
    pub name: String,
    pub version: String,
    pub path: String,     // Absolute path
    pub location: String, // "Bundled", "Board", "Arch", "Global"
    pub scope_detail: Option<String>,
    pub manifest: Option<LibraryManifest>,
    pub assets_path: Option<String>, // Path to 'assets' folder if exists
    #[serde(default)]
    pub has_blocks: bool,
    #[serde(default)]
    pub has_toolbox: bool,
    #[serde(default)]
    pub has_generator: bool,
    pub block_manifest: Option<BlockPackageManifest>,
    #[serde(default)]
    pub block_search_entries: Vec<BlockSearchEntry>,
    #[serde(default)]
    pub block_entrypoints: ResolvedBlockEntrypoints,
    #[serde(default)]
    pub diagnostics: Vec<LibraryDiagnostic>,
    #[serde(default)]
    pub user_installed: bool,
    pub quality_report: Option<PackageQualityReport>,
    pub runtime_activation: RuntimeActivationInfo,
}

fn library_diagnostic(code: &str, severity: &str, message: impl Into<String>) -> LibraryDiagnostic {
    LibraryDiagnostic {
        code: code.to_string(),
        severity: severity.to_string(),
        message: message.into(),
    }
}

fn valid_package_id(value: &str) -> bool {
    quality_package_id(value, true)
}

fn valid_block_type(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(ch) if ch.is_ascii_alphabetic())
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn safe_relative_entrypoint(value: &str) -> Option<PathBuf> {
    safe_relative_path(value)
}

pub(crate) fn declarative_entrypoint_allowed(label: &str, value: &str) -> bool {
    let extension = Path::new(value)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match label {
        "blocks" | "generator" => extension == "json",
        "toolbox" => matches!(extension.as_str(), "json" | "xml"),
        _ => false,
    }
}

fn entrypoint_is_javascript(value: Option<&String>) -> bool {
    value.is_some_and(|value| {
        Path::new(value)
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "js" | "mjs" | "cjs"
                )
            })
    })
}

fn read_or_bootstrap_managed_declarative_quality_report(
    root: &Path,
    package_id: &str,
    complete_declarative_runtime: bool,
    user_installed: bool,
    diagnostics: &mut Vec<LibraryDiagnostic>,
) -> Option<PackageQualityReport> {
    let existing = read_quality_report_with_integrity(root);
    if existing.is_some() || !complete_declarative_runtime || user_installed {
        return existing;
    }

    // CK-distributed packages in older installations predate persisted quality
    // reports. Bootstrap them once through the exact same static gate used by
    // imports. Never refresh an existing stale/failed report here: content
    // changes must remain visible and require an explicit re-import/recheck.
    let report = inspect_library_package(root, true);
    if report.package_id.as_deref() != Some(package_id) {
        diagnostics.push(library_diagnostic(
            "managed-quality-bootstrap-id-mismatch",
            "error",
            "The managed declarative package failed its package-id binding check.",
        ));
        return None;
    }
    if let Err(error) = write_quality_report(root, &report) {
        diagnostics.push(library_diagnostic(
            "managed-quality-bootstrap-failed",
            "error",
            format!(
                "The managed declarative package could not persist its first-scan quality report: {}",
                error
            ),
        ));
        return None;
    }
    diagnostics.push(library_diagnostic(
        "managed-quality-bootstrapped",
        "info",
        "Generated the missing first-scan quality report with the standard declarative package gate.",
    ));
    read_quality_report_with_integrity(root)
}

fn read_block_package_manifest(
    root: &Path,
    folder_name: &str,
) -> (Option<BlockPackageManifest>, Vec<LibraryDiagnostic>) {
    let path = root.join(BLOCK_PACKAGE_MANIFEST_FILE);
    if !path.is_file() {
        return (None, Vec::new());
    }

    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) => {
            return (
                None,
                vec![library_diagnostic(
                    "invalid-manifest",
                    "error",
                    format!("Cannot read {}: {}", BLOCK_PACKAGE_MANIFEST_FILE, error),
                )],
            );
        }
    };
    let raw_json = match serde_json::from_str::<serde_json::Value>(strip_utf8_bom(&raw)) {
        Ok(value) => value,
        Err(error) => {
            return (
                None,
                vec![library_diagnostic(
                    "invalid-manifest",
                    "error",
                    format!("Invalid {}: {}", BLOCK_PACKAGE_MANIFEST_FILE, error),
                )],
            );
        }
    };
    let manifest = match serde_json::from_value::<BlockPackageManifest>(raw_json.clone()) {
        Ok(manifest) => manifest,
        Err(error) => {
            return (
                None,
                vec![library_diagnostic(
                    "invalid-manifest",
                    "error",
                    format!("Invalid {}: {}", BLOCK_PACKAGE_MANIFEST_FILE, error),
                )],
            );
        }
    };

    let mut diagnostics = Vec::new();
    let package_text_valid = manifest
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
        && manifest
            .description
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some();
    let entrypoints_complete = manifest.entrypoints.blocks.is_some()
        && manifest.entrypoints.generator.is_some()
        && manifest.entrypoints.toolbox.is_some();
    if !matches!(manifest.schema_version, 1 | 2)
        || !valid_package_id(&manifest.id)
        || !package_text_valid
        || !entrypoints_complete
    {
        diagnostics.push(library_diagnostic(
            "invalid-manifest",
            "error",
            format!(
                "{} requires schema_version 1 or 2, an ASCII package id, package text and all entrypoints.",
                BLOCK_PACKAGE_MANIFEST_FILE
            ),
        ));
        return (None, diagnostics);
    }
    if manifest.id != folder_name {
        diagnostics.push(library_diagnostic(
            "id-mismatch",
            "warning",
            format!(
                "Block package id '{}' differs from folder '{}'.",
                manifest.id, folder_name
            ),
        ));
    }

    let mut seen_types = std::collections::HashSet::new();
    for block in &manifest.blocks {
        if !valid_block_type(&block.block_type)
            || block.display_name.trim().is_empty()
            || block.description.trim().is_empty()
        {
            diagnostics.push(library_diagnostic(
                "invalid-manifest",
                "error",
                format!(
                    "Block '{}' needs a valid type, display_name and description.",
                    block.block_type
                ),
            ));
        }
        if !seen_types.insert(block.block_type.clone()) {
            diagnostics.push(library_diagnostic(
                "duplicate-block-type",
                "error",
                format!(
                    "Block type '{}' is declared more than once.",
                    block.block_type
                ),
            ));
        }
    }
    if manifest.blocks.is_empty() {
        diagnostics.push(library_diagnostic(
            "missing-block-catalog",
            "warning",
            "No blocks are declared; AI discovery will be limited to toolbox inference.",
        ));
    }
    if manifest.schema_version == 2 {
        validate_v2_block_manifest(root, &raw_json, &manifest, &mut diagnostics);
    }
    for (label, value) in [
        ("blocks", manifest.entrypoints.blocks.as_deref()),
        ("generator", manifest.entrypoints.generator.as_deref()),
        ("toolbox", manifest.entrypoints.toolbox.as_deref()),
    ] {
        if let Some(value) = value {
            if safe_relative_entrypoint(value).is_none() {
                diagnostics.push(library_diagnostic(
                    "unsafe-entrypoint",
                    "error",
                    format!("Unsafe {} entrypoint: {}", label, value),
                ));
            } else if !declarative_entrypoint_allowed(label, value) {
                diagnostics.push(library_diagnostic(
                    "legacy-javascript-disabled",
                    "error",
                    format!(
                        "{} entrypoint '{}' is executable or unsupported. CK 1.0 accepts JSON block definitions, ck-generator JSON, and JSON/XML toolbox data only.",
                        label, value
                    ),
                ));
            }
        }
    }

    if diagnostics.iter().any(|item| item.severity == "error") {
        (None, diagnostics)
    } else {
        (Some(manifest), diagnostics)
    }
}

fn v2_metadata_error(
    diagnostics: &mut Vec<LibraryDiagnostic>,
    location: &str,
    message: impl Into<String>,
) {
    diagnostics.push(library_diagnostic(
        "invalid-v2-metadata",
        "error",
        format!("{}: {}", location, message.into()),
    ));
}

fn has_non_empty_string(object: &serde_json::Map<String, serde_json::Value>, key: &str) -> bool {
    object
        .get(key)
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

fn string_array(value: Option<&serde_json::Value>) -> bool {
    value.is_some_and(|value| {
        value.as_array().is_some_and(|items| {
            let mut seen = HashSet::new();
            items.iter().all(|item| {
                item.as_str()
                    .map(str::trim)
                    .is_some_and(|text| !text.is_empty() && seen.insert(text.to_string()))
            })
        })
    })
}

fn only_allowed_keys(
    object: &serde_json::Map<String, serde_json::Value>,
    allowed: &[&str],
) -> Vec<String> {
    object
        .keys()
        .filter(|key| !allowed.contains(&key.as_str()))
        .cloned()
        .collect()
}

fn reject_unknown_v2_keys(
    object: &serde_json::Map<String, serde_json::Value>,
    allowed: &[&str],
    location: &str,
    diagnostics: &mut Vec<LibraryDiagnostic>,
) {
    let unknown = only_allowed_keys(object, allowed);
    if !unknown.is_empty() {
        v2_metadata_error(
            diagnostics,
            location,
            format!("unknown fields: {}", unknown.join(", ")),
        );
    }
}

fn valid_spdx_id(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '+' | '(' | ')'))
}

fn valid_dependency_version(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    semver::Version::parse(trimmed).is_ok()
        || semver::VersionReq::parse(trimmed).is_ok()
        || semver::VersionReq::parse(&trimmed.split_whitespace().collect::<Vec<_>>().join(", "))
            .is_ok()
}

fn validate_v2_dependency(
    value: &serde_json::Value,
    location: &str,
    diagnostics: &mut Vec<LibraryDiagnostic>,
) -> Vec<String> {
    let Some(object) = value.as_object() else {
        v2_metadata_error(diagnostics, location, "dependency must be an object");
        return Vec::new();
    };
    reject_unknown_v2_keys(
        object,
        &[
            "kind", "id", "version", "headers", "optional", "reason", "license",
        ],
        location,
        diagnostics,
    );
    let kind = object
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if !matches!(
        kind,
        "arduino-library" | "core" | "header" | "tool" | "capability"
    ) || !has_non_empty_string(object, "id")
    {
        v2_metadata_error(
            diagnostics,
            location,
            "dependency requires a supported kind and non-empty id",
        );
    }
    if let Some(version) = object.get("version") {
        if !version.as_str().is_some_and(valid_dependency_version) {
            v2_metadata_error(
                diagnostics,
                location,
                "version is not a valid SemVer selector",
            );
        }
    }
    if object.contains_key("headers") && !string_array(object.get("headers")) {
        v2_metadata_error(
            diagnostics,
            location,
            "headers must be unique non-empty strings",
        );
    }
    for key in ["reason", "license"] {
        if object.contains_key(key) && !has_non_empty_string(object, key) {
            v2_metadata_error(diagnostics, location, format!("{} must be non-empty", key));
        }
    }
    object
        .get("headers")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_string)
        .collect()
}

fn validate_v2_block_manifest(
    root: &Path,
    raw: &serde_json::Value,
    manifest: &BlockPackageManifest,
    diagnostics: &mut Vec<LibraryDiagnostic>,
) {
    let Some(top) = raw.as_object() else {
        v2_metadata_error(diagnostics, "ck-blocks.json", "root must be an object");
        return;
    };
    let unknown = only_allowed_keys(
        top,
        &[
            "schema_version",
            "id",
            "display_name",
            "description",
            "keywords",
            "license",
            "compatibility",
            "dependencies",
            "entrypoints",
            "blocks",
        ],
    );
    if !unknown.is_empty() {
        v2_metadata_error(
            diagnostics,
            "ck-blocks.json",
            format!("unknown top-level fields: {}", unknown.join(", ")),
        );
    }
    if let Some(blocks) = top.get("blocks").and_then(serde_json::Value::as_array) {
        let required = [
            "type",
            "display_name",
            "description",
            "category",
            "kind",
            "semantics",
            "fields",
            "inputs",
            "output",
            "dependencies",
            "hardware",
            "generation",
            "constraints",
            "examples",
            "errors",
        ];
        let allowed = [
            "type",
            "display_name",
            "description",
            "category",
            "kind",
            "keywords",
            "semantics",
            "fields",
            "inputs",
            "output",
            "dependencies",
            "hardware",
            "generation",
            "constraints",
            "examples",
            "errors",
        ];
        for (index, block) in blocks.iter().enumerate() {
            let Some(object) = block.as_object() else {
                v2_metadata_error(
                    diagnostics,
                    &format!("blocks[{}]", index),
                    "block must be an object",
                );
                continue;
            };
            let missing = required
                .iter()
                .filter(|key| !object.contains_key(**key))
                .copied()
                .collect::<Vec<_>>();
            let unknown = only_allowed_keys(object, &allowed);
            if !missing.is_empty() {
                v2_metadata_error(
                    diagnostics,
                    &format!("blocks[{}]", index),
                    format!("missing required fields: {}", missing.join(", ")),
                );
            }
            if !unknown.is_empty() {
                v2_metadata_error(
                    diagnostics,
                    &format!("blocks[{}]", index),
                    format!("unknown fields: {}", unknown.join(", ")),
                );
            }
        }
    }
    if top.contains_key("keywords") && !string_array(top.get("keywords")) {
        v2_metadata_error(
            diagnostics,
            "keywords",
            "keywords must be unique non-empty strings",
        );
    }
    if let Some(object) = top
        .get("compatibility")
        .and_then(serde_json::Value::as_object)
    {
        reject_unknown_v2_keys(
            object,
            &["boards", "architectures"],
            "compatibility",
            diagnostics,
        );
    }
    if let Some(object) = top
        .get("entrypoints")
        .and_then(serde_json::Value::as_object)
    {
        reject_unknown_v2_keys(
            object,
            &["blocks", "generator", "toolbox"],
            "entrypoints",
            diagnostics,
        );
    }

    let Some(license) = manifest.license.as_ref() else {
        v2_metadata_error(diagnostics, "license", "v2 requires spdx_id and file");
        return validate_v2_blocks(root, manifest, diagnostics);
    };
    if !valid_spdx_id(&license.spdx_id) {
        v2_metadata_error(
            diagnostics,
            "license.spdx_id",
            "invalid SPDX identifier syntax",
        );
    }
    match safe_relative_path(&license.file) {
        Some(path) if root.join(&path).is_file() => {}
        Some(_) => v2_metadata_error(
            diagnostics,
            "license.file",
            "declared license file does not exist",
        ),
        None => v2_metadata_error(
            diagnostics,
            "license.file",
            "license path must stay inside the package",
        ),
    }
    let license_object = top.get("license").and_then(serde_json::Value::as_object);
    if let Some(object) = license_object {
        let unknown = only_allowed_keys(object, &["spdx_id", "file"]);
        if !unknown.is_empty() {
            v2_metadata_error(
                diagnostics,
                "license",
                format!("unknown fields: {}", unknown.join(", ")),
            );
        }
    }

    let mut dependency_headers = HashSet::new();
    for (index, dependency) in manifest.dependencies.iter().enumerate() {
        dependency_headers.extend(validate_v2_dependency(
            dependency,
            &format!("dependencies[{}]", index),
            diagnostics,
        ));
    }
    validate_v2_blocks_with_headers(root, manifest, &dependency_headers, diagnostics);
}

fn validate_v2_blocks(
    root: &Path,
    manifest: &BlockPackageManifest,
    diagnostics: &mut Vec<LibraryDiagnostic>,
) {
    validate_v2_blocks_with_headers(root, manifest, &HashSet::new(), diagnostics);
}

fn validate_v2_blocks_with_headers(
    root: &Path,
    manifest: &BlockPackageManifest,
    package_headers: &HashSet<String>,
    diagnostics: &mut Vec<LibraryDiagnostic>,
) {
    if manifest.blocks.is_empty() {
        v2_metadata_error(diagnostics, "blocks", "v2 requires at least one block");
        return;
    }
    for (block_index, block) in manifest.blocks.iter().enumerate() {
        let location = format!("blocks[{}] ({})", block_index, block.block_type);
        validate_v2_block(root, block, package_headers, &location, diagnostics);
    }
}

fn validate_v2_block(
    root: &Path,
    block: &BlockManifestEntry,
    package_headers: &HashSet<String>,
    location: &str,
    diagnostics: &mut Vec<LibraryDiagnostic>,
) {
    if block
        .category
        .as_deref()
        .is_none_or(|value| value.trim().is_empty())
        || block
            .kind
            .as_deref()
            .is_none_or(|kind| !matches!(kind, "statement" | "value" | "hat" | "terminal"))
    {
        v2_metadata_error(
            diagnostics,
            location,
            "v2 block requires category and a supported kind",
        );
    }
    let mut field_names = HashSet::new();
    for (index, field) in block.fields.iter().enumerate() {
        let Some(object) = field.as_object() else {
            v2_metadata_error(
                diagnostics,
                location,
                format!("field {} must be an object", index),
            );
            continue;
        };
        reject_unknown_v2_keys(
            object,
            &[
                "name",
                "kind",
                "description",
                "required",
                "default",
                "options",
            ],
            &format!("{}.fields[{}]", location, index),
            diagnostics,
        );
        let name = object
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if !valid_symbol_name(name)
            || !field_names.insert(name.to_string())
            || !has_non_empty_string(object, "kind")
            || !has_non_empty_string(object, "description")
        {
            v2_metadata_error(
                diagnostics,
                location,
                format!("field {} requires unique name, kind and description", index),
            );
        }
        if let Some(options) = object.get("options") {
            let valid_options = options.as_array().is_some_and(|items| {
                items.iter().all(|item| {
                    item.as_object().is_some_and(|option| {
                        only_allowed_keys(option, &["label", "value"]).is_empty()
                            && option
                                .get("label")
                                .and_then(serde_json::Value::as_str)
                                .is_some()
                            && option
                                .get("value")
                                .and_then(serde_json::Value::as_str)
                                .is_some()
                    })
                })
            });
            if !valid_options {
                v2_metadata_error(
                    diagnostics,
                    location,
                    format!(
                        "field {} options must contain only string label/value pairs",
                        index
                    ),
                );
            }
        }
    }
    let mut input_names = HashSet::new();
    for (index, input) in block.inputs.iter().enumerate() {
        let Some(object) = input.as_object() else {
            v2_metadata_error(
                diagnostics,
                location,
                format!("input {} must be an object", index),
            );
            continue;
        };
        reject_unknown_v2_keys(
            object,
            &[
                "name",
                "kind",
                "description",
                "required",
                "check",
                "default",
            ],
            &format!("{}.inputs[{}]", location, index),
            diagnostics,
        );
        let name = object
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let kind = object
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if !valid_symbol_name(name)
            || !input_names.insert(name.to_string())
            || !matches!(kind, "value" | "statement")
            || !has_non_empty_string(object, "description")
        {
            v2_metadata_error(
                diagnostics,
                location,
                format!("input {} requires unique name, kind and description", index),
            );
        }
        if let Some(check) = object.get("check") {
            let valid_check = check.as_str().is_some_and(|value| !value.trim().is_empty())
                || string_array(Some(check));
            if !valid_check {
                v2_metadata_error(
                    diagnostics,
                    location,
                    format!(
                        "input {} check must be a type string or unique type array",
                        index
                    ),
                );
            }
        }
    }

    let semantics_object = block
        .semantics
        .as_ref()
        .and_then(serde_json::Value::as_object);
    if let Some(object) = semantics_object {
        reject_unknown_v2_keys(
            object,
            &["purpose", "behavior", "side_effects", "concepts"],
            &format!("{}.semantics", location),
            diagnostics,
        );
    }
    let semantics_valid = semantics_object.is_some_and(|object| {
        has_non_empty_string(object, "purpose")
            && has_non_empty_string(object, "behavior")
            && string_array(object.get("side_effects"))
            && string_array(object.get("concepts"))
    });
    if !semantics_valid {
        v2_metadata_error(
            diagnostics,
            location,
            "semantics requires purpose, behavior, side_effects and concepts",
        );
    }

    let output_object = block.output.as_ref().and_then(serde_json::Value::as_object);
    if let Some(object) = output_object {
        reject_unknown_v2_keys(
            object,
            &["connection", "types", "description", "unit", "nullable"],
            &format!("{}.output", location),
            diagnostics,
        );
    }
    let output_valid = output_object.is_some_and(|object| {
            let connection = object.get("connection").and_then(serde_json::Value::as_str);
            let types = object.get("types").and_then(serde_json::Value::as_array);
            matches!((connection, types), (Some("none"), Some(items)) if items.is_empty())
                || matches!((connection, types), (Some("value"), Some(items)) if !items.is_empty() && items.iter().all(|item| item.as_str().is_some_and(|text| !text.trim().is_empty())))
        });
    if !output_valid {
        v2_metadata_error(diagnostics, location, "output contract is invalid");
    }
    if block.kind.as_deref() == Some("value")
        && block
            .output
            .as_ref()
            .and_then(|value| value.get("connection"))
            .and_then(serde_json::Value::as_str)
            != Some("value")
    {
        v2_metadata_error(diagnostics, location, "value block must return a value");
    }

    let mut headers = package_headers.clone();
    for (index, dependency) in block.dependencies.iter().enumerate() {
        headers.extend(validate_v2_dependency(
            dependency,
            &format!("{}.dependencies[{}]", location, index),
            diagnostics,
        ));
    }

    validate_v2_hardware(block, &field_names, &input_names, location, diagnostics);
    validate_v2_generation(block, &headers, location, diagnostics);
    validate_v2_constraints(block, &field_names, &input_names, location, diagnostics);
    validate_v2_examples(root, block, location, diagnostics);
    validate_v2_errors(block, location, diagnostics);
}

fn validate_v2_hardware(
    block: &BlockManifestEntry,
    field_names: &HashSet<String>,
    input_names: &HashSet<String>,
    location: &str,
    diagnostics: &mut Vec<LibraryDiagnostic>,
) {
    let Some(hardware) = block
        .hardware
        .as_ref()
        .and_then(serde_json::Value::as_object)
    else {
        v2_metadata_error(diagnostics, location, "hardware.resources is required");
        return;
    };
    reject_unknown_v2_keys(
        hardware,
        &["resources", "boards", "architectures", "notes"],
        &format!("{}.hardware", location),
        diagnostics,
    );
    let Some(resources) = hardware
        .get("resources")
        .and_then(serde_json::Value::as_array)
    else {
        v2_metadata_error(diagnostics, location, "hardware.resources must be an array");
        return;
    };
    for (index, resource) in resources.iter().enumerate() {
        let Some(object) = resource.as_object() else {
            v2_metadata_error(
                diagnostics,
                location,
                format!("hardware resource {} must be an object", index),
            );
            continue;
        };
        reject_unknown_v2_keys(
            object,
            &[
                "kind",
                "id",
                "source",
                "access",
                "sharing",
                "quantity",
                "capabilities",
                "description",
            ],
            &format!("{}.hardware.resources[{}]", location, index),
            diagnostics,
        );
        let kind = object
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if !matches!(
            kind,
            "gpio"
                | "adc"
                | "pwm"
                | "i2c"
                | "spi"
                | "uart"
                | "timer"
                | "interrupt"
                | "network"
                | "filesystem"
                | "flash"
                | "ram"
                | "other"
        ) || !has_non_empty_string(object, "description")
        {
            v2_metadata_error(
                diagnostics,
                location,
                format!(
                    "hardware resource {} has invalid kind or description",
                    index
                ),
            );
        }
        if object
            .get("access")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !matches!(value, "read" | "write" | "read-write" | "reserve"))
            || object
                .get("sharing")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !matches!(value, "exclusive" | "shared" | "board-defined"))
            || object
                .get("quantity")
                .is_some_and(|value| value.as_u64().is_none_or(|quantity| quantity == 0))
            || (object.contains_key("capabilities") && !string_array(object.get("capabilities")))
        {
            v2_metadata_error(
                diagnostics,
                location,
                format!(
                    "hardware resource {} access, sharing, quantity or capabilities is invalid",
                    index
                ),
            );
        }
        let Some(source) = object.get("source") else {
            continue;
        };
        let Some(source) = source.as_object() else {
            v2_metadata_error(
                diagnostics,
                location,
                format!("hardware resource {} source must be an object", index),
            );
            continue;
        };
        reject_unknown_v2_keys(
            source,
            &["kind", "name", "value"],
            &format!("{}.hardware.resources[{}].source", location, index),
            diagnostics,
        );
        let source_kind = source
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let source_name = source
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let valid = match source_kind {
            "field" => field_names.contains(source_name),
            "input" => input_names.contains(source_name),
            "fixed" => source.contains_key("value"),
            "board-default" => true,
            _ => false,
        };
        if !valid {
            v2_metadata_error(
                diagnostics,
                location,
                format!(
                    "hardware resource {} source does not reference a declared field/input or fixed value",
                    index
                ),
            );
        }
    }
}

fn validate_v2_generation(
    block: &BlockManifestEntry,
    dependency_headers: &HashSet<String>,
    location: &str,
    diagnostics: &mut Vec<LibraryDiagnostic>,
) {
    let Some(generation) = block
        .generation
        .as_ref()
        .and_then(serde_json::Value::as_object)
    else {
        v2_metadata_error(diagnostics, location, "generation contract is required");
        return;
    };
    reject_unknown_v2_keys(
        generation,
        &[
            "language",
            "shape",
            "deterministic",
            "includes",
            "calls",
            "emissions",
            "notes",
        ],
        &format!("{}.generation", location),
        diagnostics,
    );
    let shape = generation
        .get("shape")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let expected_shape = match block.kind.as_deref() {
        Some("value") => "expression",
        Some("hat") => "event",
        _ => "statement",
    };
    let emissions = generation
        .get("emissions")
        .and_then(serde_json::Value::as_array);
    if generation
        .get("language")
        .and_then(serde_json::Value::as_str)
        != Some("arduino-cpp")
        || shape != expected_shape
        || generation
            .get("deterministic")
            .and_then(serde_json::Value::as_bool)
            .is_none()
        || emissions.is_none_or(Vec::is_empty)
    {
        v2_metadata_error(
            diagnostics,
            location,
            format!(
                "generation requires arduino-cpp, deterministic flag, non-empty emissions and shape '{}'",
                expected_shape
            ),
        );
    }
    for key in ["includes", "calls", "notes"] {
        if generation.contains_key(key) && !string_array(generation.get(key)) {
            v2_metadata_error(
                diagnostics,
                location,
                format!("generation.{} is invalid", key),
            );
        }
    }
    for include in generation
        .get("includes")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
    {
        if !dependency_headers.contains(include) {
            v2_metadata_error(
                diagnostics,
                location,
                format!(
                    "generated include '{}' is not declared by package or block dependencies",
                    include
                ),
            );
        }
    }
    if let Some(emissions) = emissions {
        for (index, emission) in emissions.iter().enumerate() {
            let Some(object) = emission.as_object() else {
                v2_metadata_error(
                    diagnostics,
                    location,
                    format!("generation emission {} must be an object", index),
                );
                continue;
            };
            reject_unknown_v2_keys(
                object,
                &["section", "description", "template"],
                &format!("{}.generation.emissions[{}]", location, index),
                diagnostics,
            );
            let section = object
                .get("section")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            if !matches!(
                section,
                "include" | "global" | "setup" | "loop" | "statement" | "expression"
            ) || !has_non_empty_string(object, "description")
            {
                v2_metadata_error(
                    diagnostics,
                    location,
                    format!("generation emission {} is invalid", index),
                );
            }
        }
    }
}

fn validate_v2_constraints(
    block: &BlockManifestEntry,
    field_names: &HashSet<String>,
    input_names: &HashSet<String>,
    location: &str,
    diagnostics: &mut Vec<LibraryDiagnostic>,
) {
    let mut ids = HashSet::new();
    for (index, constraint) in block.constraints.iter().enumerate() {
        let Some(object) = constraint.as_object() else {
            v2_metadata_error(
                diagnostics,
                location,
                format!("constraint {} must be an object", index),
            );
            continue;
        };
        reject_unknown_v2_keys(
            object,
            &[
                "id",
                "severity",
                "description",
                "check",
                "message",
                "recovery",
            ],
            &format!("{}.constraints[{}]", location, index),
            diagnostics,
        );
        let id = object
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let severity = object
            .get("severity")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if !quality_package_id(id, true)
            || !ids.insert(id.to_string())
            || !matches!(severity, "info" | "warning" | "error")
            || !has_non_empty_string(object, "description")
            || !has_non_empty_string(object, "message")
        {
            v2_metadata_error(
                diagnostics,
                location,
                format!(
                    "constraint {} requires unique id, severity and messages",
                    index
                ),
            );
        }
        let Some(check) = object.get("check").and_then(serde_json::Value::as_object) else {
            continue;
        };
        reject_unknown_v2_keys(
            check,
            &["target", "operator", "value"],
            &format!("{}.constraints[{}].check", location, index),
            diagnostics,
        );
        let target = check
            .get("target")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let operator = check
            .get("operator")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if target.trim().is_empty()
            || !matches!(
                operator,
                "equals"
                    | "not-equals"
                    | "one-of"
                    | "range"
                    | "matches"
                    | "requires"
                    | "conflicts-with"
                    | "board-capability"
            )
        {
            v2_metadata_error(
                diagnostics,
                location,
                format!("constraint {} check target/operator is invalid", id),
            );
        }
        if let Some(name) = target.strip_prefix("field.") {
            if !field_names.contains(name) {
                v2_metadata_error(
                    diagnostics,
                    location,
                    format!("constraint {} references unknown field '{}'", id, name),
                );
            }
        } else if let Some(name) = target.strip_prefix("input.") {
            if !input_names.contains(name) {
                v2_metadata_error(
                    diagnostics,
                    location,
                    format!("constraint {} references unknown input '{}'", id, name),
                );
            }
        }
    }
}

fn validate_v2_examples(
    root: &Path,
    block: &BlockManifestEntry,
    location: &str,
    diagnostics: &mut Vec<LibraryDiagnostic>,
) {
    if block.examples.is_empty() {
        v2_metadata_error(diagnostics, location, "v2 requires at least one example");
        return;
    }
    let mut ids = HashSet::new();
    for (index, example) in block.examples.iter().enumerate() {
        let Some(object) = example.as_object() else {
            v2_metadata_error(
                diagnostics,
                location,
                format!("example {} must be a structured object", index),
            );
            continue;
        };
        reject_unknown_v2_keys(
            object,
            &[
                "id",
                "title",
                "description",
                "field_values",
                "input_values",
                "project",
                "generated_code",
                "expected_code_contains",
                "expected_behavior",
                "boards",
            ],
            &format!("{}.examples[{}]", location, index),
            diagnostics,
        );
        let id = object
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if !quality_package_id(id, true)
            || !ids.insert(id.to_string())
            || !has_non_empty_string(object, "title")
            || !has_non_empty_string(object, "description")
            || !has_non_empty_string(object, "expected_behavior")
        {
            v2_metadata_error(
                diagnostics,
                location,
                format!(
                    "example {} requires unique id, title, description and expected_behavior",
                    index
                ),
            );
        }
        for key in ["expected_code_contains", "boards"] {
            if object.contains_key(key) && !string_array(object.get(key)) {
                v2_metadata_error(
                    diagnostics,
                    location,
                    format!(
                        "example {} {} must contain unique non-empty strings",
                        id, key
                    ),
                );
            }
        }
        for key in ["project", "generated_code"] {
            let Some(raw_path) = object.get(key).and_then(serde_json::Value::as_str) else {
                continue;
            };
            match safe_relative_path(raw_path) {
                Some(path) if root.join(&path).is_file() => {}
                Some(_) => v2_metadata_error(
                    diagnostics,
                    location,
                    format!("example {} {} file does not exist", id, key),
                ),
                None => v2_metadata_error(
                    diagnostics,
                    location,
                    format!("example {} {} path escapes the package", id, key),
                ),
            }
        }
    }
}

fn validate_v2_errors(
    block: &BlockManifestEntry,
    location: &str,
    diagnostics: &mut Vec<LibraryDiagnostic>,
) {
    let mut codes = HashSet::new();
    for (index, error) in block.errors.iter().enumerate() {
        let Some(object) = error.as_object() else {
            v2_metadata_error(
                diagnostics,
                location,
                format!("error {} must be an object", index),
            );
            continue;
        };
        reject_unknown_v2_keys(
            object,
            &["code", "severity", "message", "cause", "recovery"],
            &format!("{}.errors[{}]", location, index),
            diagnostics,
        );
        let code = object
            .get("code")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let valid_code = code
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_uppercase())
            && code
                .chars()
                .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_');
        let severity = object
            .get("severity")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if !valid_code
            || !codes.insert(code.to_string())
            || !matches!(severity, "info" | "warning" | "error")
            || !has_non_empty_string(object, "message")
            || !has_non_empty_string(object, "cause")
            || !has_non_empty_string(object, "recovery")
        {
            v2_metadata_error(
                diagnostics,
                location,
                format!(
                    "error {} requires unique code, severity, message, cause and recovery",
                    index
                ),
            );
        }
    }
}

fn resolve_entrypoint(
    root: &Path,
    configured: Option<&str>,
    fallbacks: &[&str],
) -> Option<PathBuf> {
    if let Some(configured) = configured {
        let relative = safe_relative_entrypoint(configured)?;
        let candidate = root.join(relative);
        return candidate.is_file().then_some(candidate);
    }
    fallbacks
        .iter()
        .map(|relative| root.join(relative))
        .find(|candidate| candidate.is_file())
}

fn resolve_block_entrypoints(
    root: &Path,
    manifest: Option<&BlockPackageManifest>,
    diagnostics: &mut Vec<LibraryDiagnostic>,
) -> ResolvedBlockEntrypoints {
    let standard_layout = manifest.is_some();
    let (blocks_fallbacks, generator_fallbacks, toolbox_fallbacks): (&[&str], &[&str], &[&str]) =
        if standard_layout {
            (
                &[STANDARD_BLOCKS_PATH, "block.json"],
                &[STANDARD_GENERATOR_PATH],
                &[STANDARD_TOOLBOX_PATH],
            )
        } else {
            (
                &[
                    "block.json",
                    "blocks.js",
                    "block/blocks.js",
                    STANDARD_BLOCKS_PATH,
                    "src/blocks.js",
                ],
                &[
                    "generator.js",
                    "generator/generator.js",
                    STANDARD_GENERATOR_PATH,
                    "src/generator.js",
                ],
                &["toolbox.json", "toolbox.xml", STANDARD_TOOLBOX_PATH],
            )
        };

    let blocks = resolve_entrypoint(
        root,
        manifest.and_then(|item| item.entrypoints.blocks.as_deref()),
        blocks_fallbacks,
    );
    let generator = resolve_entrypoint(
        root,
        manifest.and_then(|item| item.entrypoints.generator.as_deref()),
        generator_fallbacks,
    );
    let toolbox = resolve_entrypoint(
        root,
        manifest.and_then(|item| item.entrypoints.toolbox.as_deref()),
        toolbox_fallbacks,
    );

    if manifest.is_none() && (blocks.is_some() || generator.is_some() || toolbox.is_some()) {
        diagnostics.push(library_diagnostic(
            "legacy-layout",
            "info",
            "Legacy Blockly layout detected; migrate to ck-blocks.json and blocks/.",
        ));
    }
    for (code, label, path) in [
        ("missing-blocks", "block definitions", blocks.as_ref()),
        ("missing-generator", "Arduino generator", generator.as_ref()),
        ("missing-toolbox", "toolbox category", toolbox.as_ref()),
    ] {
        if path.is_none() {
            diagnostics.push(library_diagnostic(
                code,
                "warning",
                format!("Missing {} entrypoint.", label),
            ));
        }
    }

    ResolvedBlockEntrypoints {
        blocks: blocks.map(|path| path.to_string_lossy().into_owned()),
        generator: generator.map(|path| path.to_string_lossy().into_owned()),
        toolbox: toolbox.map(|path| path.to_string_lossy().into_owned()),
    }
}

pub(crate) fn inspect_library_package(
    root: &Path,
    require_block_package: bool,
) -> PackageQualityReport {
    let mut report = PackageQualityReport::new(if require_block_package {
        "block-library"
    } else {
        "arduino-library"
    });

    let library_path = root.join("library.json");
    let library_json = match fs::read_to_string(&library_path) {
        Ok(raw) => match serde_json::from_str::<serde_json::Value>(strip_utf8_bom(&raw)) {
            Ok(value) if value.is_object() => {
                report.pass("library-manifest", "library.json is valid JSON.");
                Some(value)
            }
            Ok(_) => {
                report.error(
                    "invalid-library-manifest",
                    "library.json must be a JSON object.",
                );
                None
            }
            Err(error) => {
                report.error(
                    "invalid-library-manifest",
                    format!("library.json is invalid: {}", error),
                );
                None
            }
        },
        Err(error) => {
            report.error(
                "missing-library-manifest",
                format!("Cannot read library.json: {}", error),
            );
            None
        }
    };

    let package_id = library_json
        .as_ref()
        .and_then(|json| json.get("id"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    report.package_id = package_id.clone();
    match package_id.as_deref() {
        Some(id) if quality_package_id(id, true) => {
            report.pass("package-id", format!("Package id '{}' is path-safe.", id));
        }
        Some(id) => report.error(
            "invalid-package-id",
            format!(
                "Package id '{}' must start with an ASCII letter or digit and contain only letters, digits, '.', '_' or '-'.",
                id
            ),
        ),
        None => report.error(
            "missing-package-id",
            "library.json requires a non-empty id.",
        ),
    }

    if let Some(json) = library_json.as_ref() {
        for field in ["name", "version"] {
            if json
                .get(field)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .is_none_or(str::is_empty)
            {
                report.error(
                    "missing-library-metadata",
                    format!("library.json requires a non-empty '{}'.", field),
                );
            }
        }
        if let Some(version) = json.get("version").and_then(serde_json::Value::as_str) {
            if valid_semver(version) {
                report.pass(
                    "semantic-version",
                    format!("Version {} is valid SemVer.", version),
                );
            } else {
                report.error(
                    "invalid-version",
                    format!("library.json version '{}' is not valid SemVer.", version),
                );
            }
        }
        let has_description = ["description", "sentence", "paragraph"]
            .iter()
            .any(|field| {
                json.get(*field)
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
            });
        if has_description {
            report.pass("package-description", "Package description is present.");
        } else {
            report.warn(
                "missing-description",
                "Add description, sentence or paragraph metadata for human and AI discovery.",
            );
        }
        let has_author = ["author", "maintainer"]
            .iter()
            .any(|field| manifest_person_text(json.get(*field)).is_some());
        if has_author {
            report.pass("package-author", "Package author or maintainer is present.");
        } else {
            report.warn(
                "missing-author",
                "Add author or maintainer metadata so third-party ownership is traceable.",
            );
        }
    }

    inspect_arduino_library_discovery_contract(root, library_json.as_ref(), &mut report);

    let block_manifest_path = root.join(BLOCK_PACKAGE_MANIFEST_FILE);
    if block_manifest_path.is_file() {
        inspect_block_contract(root, package_id.as_deref().unwrap_or_default(), &mut report);
    } else if require_block_package {
        report.error(
            "missing-block-manifest",
            format!(
                "A block library import requires {} at the package root.",
                BLOCK_PACKAGE_MANIFEST_FILE
            ),
        );
    } else {
        report.pass(
            "block-contract-optional",
            "No Blockly contract is declared; package is treated as an Arduino-only library.",
        );
    }

    if package_has_license(root) {
        report.pass("license", "A package license file is present.");
    } else {
        report.warn(
            "missing-license",
            "No LICENSE or COPYING file was found at the package root.",
        );
    }

    match hash_package_contents(root) {
        Ok(hash) => {
            report.source_content_sha256 = Some(hash);
            report.pass(
                "content-hash",
                "Package contents were fingerprinted with SHA-256.",
            );
        }
        Err(error) => report.error("content-hash-failed", error),
    }
    report.finalize();
    report
}

fn inspect_arduino_library_discovery_contract(
    root: &Path,
    library_json: Option<&serde_json::Value>,
    report: &mut PackageQualityReport,
) {
    let source_root = root.join("src");
    let has_cpp_sources = source_root.is_dir()
        && walkdir::WalkDir::new(&source_root)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .any(|entry| {
                entry.file_type().is_file()
                    && entry
                        .path()
                        .extension()
                        .and_then(|value| value.to_str())
                        .is_some_and(|extension| {
                            matches!(
                                extension.to_ascii_lowercase().as_str(),
                                "h" | "hh"
                                    | "hpp"
                                    | "hxx"
                                    | "inc"
                                    | "ipp"
                                    | "tpp"
                                    | "c"
                                    | "cc"
                                    | "cpp"
                                    | "cxx"
                                    | "s"
                            )
                        })
            });
    if !has_cpp_sources {
        report.pass(
            "arduino-discovery-not-required",
            "Package has no Arduino C/C++ sources requiring library.properties discovery.",
        );
        return;
    }

    let json_includes = library_json
        .and_then(|json| json.get("includes"))
        .map(|value| inspect_public_header_list(value, &source_root, "library.json", report));
    let path = root.join("library.properties");
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) => {
            if error.kind() == std::io::ErrorKind::NotFound && library_json.is_some() {
                report.warn(
                    "missing-arduino-library-properties",
                    "The package has recursive Arduino sources under src/ but no library.properties. CK can build it through the library.json compatibility adapter; standard Arduino tools may not discover it until library.properties is added.",
                );
                report.pass(
                    "ck-arduino-compatibility-adapter",
                    "A valid library.json allows CK to preserve the recursive src/ layout through its Arduino compatibility adapter.",
                );
            } else {
                report.error(
                    "missing-arduino-library-properties",
                    format!(
                        "Packages with Arduino C/C++ sources need readable library.properties or a valid library.json compatibility contract: {}",
                        error
                    ),
                );
            }
            return;
        }
    };
    let properties = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect::<std::collections::HashMap<_, _>>();
    for key in ["name", "version", "architectures"] {
        if properties.get(key).is_none_or(|value| value.is_empty()) {
            report.error(
                "invalid-arduino-library-properties",
                format!("library.properties requires a non-empty '{}'.", key),
            );
        }
    }
    if let Some(version) = properties.get("version") {
        if !valid_semver(version) {
            report.error(
                "invalid-arduino-library-version",
                format!(
                    "library.properties version '{}' is not valid SemVer.",
                    version
                ),
            );
        }
        if let Some(json_version) = library_json
            .and_then(|json| json.get("version"))
            .and_then(serde_json::Value::as_str)
        {
            if version != json_version {
                report.error(
                    "arduino-library-version-mismatch",
                    format!(
                        "library.properties version '{}' does not match library.json version '{}'.",
                        version, json_version
                    ),
                );
            }
        }
    }
    let property_includes = properties.get("includes").map(|includes| {
        let headers = includes
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        if headers.is_empty() {
            report.error(
                "invalid-arduino-public-header",
                "library.properties includes must contain at least one safe relative header path.",
            );
        }
        inspect_public_header_paths(
            headers.iter().map(String::as_str),
            &source_root,
            "library.properties",
            report,
        )
    });
    if properties.get("includes").is_none() {
        report.warn(
            "missing-arduino-includes",
            "Add an includes list to library.properties for public headers. Arduino only exposes src/ as the include root; nested public headers must be named as paths such as drivers/Sensor.h.",
        );
    }
    if let (Some(json_headers), Some(property_headers)) =
        (json_includes.as_ref(), property_includes.as_ref())
    {
        if json_headers != property_headers {
            report.error(
                "arduino-public-header-mismatch",
                format!(
                    "library.json includes {:?} do not match library.properties includes {:?}.",
                    json_headers, property_headers
                ),
            );
        }
    } else if json_includes.is_some() && property_includes.is_none() {
        report.warn(
            "arduino-public-header-contract-incomplete",
            "library.json declares public headers, but library.properties has no includes field. CK can use the manifest, while standard Arduino include actions only expose root src/ headers by default.",
        );
    }
    if !report.checks.iter().any(|check| {
        matches!(
            check.code.as_str(),
            "missing-arduino-library-properties"
                | "invalid-arduino-library-properties"
                | "invalid-arduino-library-version"
                | "arduino-library-version-mismatch"
                | "invalid-arduino-public-header"
                | "missing-arduino-public-header"
                | "arduino-public-header-mismatch"
        ) && check.status == "error"
    }) {
        report.pass(
            "arduino-library-discovery",
            "library.properties matches the CK manifest; src/ remains the only include root and its source subdirectories are compiled recursively.",
        );
    }
}

fn inspect_public_header_list(
    value: &serde_json::Value,
    source_root: &Path,
    source_name: &str,
    report: &mut PackageQualityReport,
) -> std::collections::BTreeSet<String> {
    let headers = match value {
        serde_json::Value::String(header) => vec![header.as_str()],
        serde_json::Value::Array(items) => {
            let mut headers = Vec::with_capacity(items.len());
            for item in items {
                if let Some(header) = item.as_str() {
                    headers.push(header);
                } else {
                    report.error(
                        "invalid-arduino-public-header",
                        format!("{} includes must contain only strings.", source_name),
                    );
                }
            }
            headers
        }
        _ => {
            report.error(
                "invalid-arduino-public-header",
                format!(
                    "{} includes must be a string or an array of strings.",
                    source_name
                ),
            );
            Vec::new()
        }
    };
    if headers.is_empty() {
        report.error(
            "invalid-arduino-public-header",
            format!("{} includes must not be empty.", source_name),
        );
    }
    inspect_public_header_paths(headers, source_root, source_name, report)
}

fn inspect_public_header_paths<'a>(
    headers: impl IntoIterator<Item = &'a str>,
    source_root: &Path,
    source_name: &str,
    report: &mut PackageQualityReport,
) -> std::collections::BTreeSet<String> {
    let mut normalized_headers = std::collections::BTreeSet::new();
    for header in headers {
        let header = header.trim();
        let Some(relative) = safe_relative_path(header).filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    matches!(
                        extension.to_ascii_lowercase().as_str(),
                        "h" | "hh" | "hpp" | "hxx" | "inc" | "ipp" | "tpp"
                    )
                })
        }) else {
            report.error(
                "invalid-arduino-public-header",
                format!(
                    "{} includes '{}' is not a safe relative header path under src/.",
                    source_name, header
                ),
            );
            continue;
        };
        let normalized = relative
            .components()
            .filter_map(|component| match component {
                std::path::Component::Normal(value) => Some(value.to_string_lossy()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/");
        if !normalized_headers.insert(normalized.clone()) {
            report.error(
                "invalid-arduino-public-header",
                format!("{} includes '{}' more than once.", source_name, normalized),
            );
        }
        if !source_root.join(&relative).is_file() {
            report.error(
                "missing-arduino-public-header",
                format!(
                    "{} includes '{}' but src/{} does not exist.",
                    source_name, header, normalized
                ),
            );
        }
    }
    normalized_headers
}

fn inspect_block_contract(root: &Path, library_id: &str, report: &mut PackageQualityReport) {
    let (manifest, mut diagnostics) = read_block_package_manifest(root, library_id);
    let entrypoints = resolve_block_entrypoints(root, manifest.as_ref(), &mut diagnostics);
    for diagnostic in diagnostics {
        let must_block = matches!(
            diagnostic.code.as_str(),
            "invalid-manifest"
                | "unsafe-entrypoint"
                | "id-mismatch"
                | "missing-block-catalog"
                | "duplicate-block-type"
                | "missing-blocks"
                | "missing-generator"
                | "missing-toolbox"
        );
        if must_block || diagnostic.severity == "error" {
            report.error(&diagnostic.code, diagnostic.message);
        } else if diagnostic.severity == "warning" || diagnostic.severity == "info" {
            report.warn(&diagnostic.code, diagnostic.message);
        }
    }

    let Some(manifest) = manifest else {
        return;
    };
    if manifest.blocks.is_empty() {
        report.error(
            "missing-block-catalog",
            "ck-blocks.json must declare every block exposed by the package.",
        );
        return;
    }
    report.pass(
        "block-catalog",
        format!("{} block type(s) are declared.", manifest.blocks.len()),
    );
    inspect_block_semantics(&manifest, report);
    inspect_compatibility(&manifest.compatibility, report);

    let declared: BTreeSet<String> = manifest
        .blocks
        .iter()
        .map(|block| block.block_type.clone())
        .collect();
    if let Some(toolbox_path) = entrypoints.toolbox.as_deref().map(Path::new) {
        match parse_toolbox_block_types(toolbox_path) {
            Ok(toolbox_types) => {
                let missing = declared
                    .difference(&toolbox_types)
                    .cloned()
                    .collect::<Vec<_>>();
                let undeclared = toolbox_types
                    .difference(&declared)
                    .cloned()
                    .collect::<Vec<_>>();
                if missing.is_empty() && undeclared.is_empty() {
                    report.pass(
                        "toolbox-catalog-consistency",
                        "Toolbox block types match ck-blocks.json.",
                    );
                } else {
                    if !missing.is_empty() {
                        report.error(
                            "toolbox-missing-blocks",
                            format!(
                                "Declared block types missing from toolbox: {}.",
                                missing.join(", ")
                            ),
                        );
                    }
                    if !undeclared.is_empty() {
                        report.error(
                            "toolbox-undeclared-blocks",
                            format!(
                                "Toolbox exposes block types not declared in ck-blocks.json: {}.",
                                undeclared.join(", ")
                            ),
                        );
                    }
                }
            }
            Err(error) => report.error("invalid-toolbox", error),
        }
    }

    if let Some(blocks_path) = entrypoints.blocks.as_deref().map(Path::new) {
        inspect_blocks_source(blocks_path, &declared, report);
    }
    if let Some(generator_path) = entrypoints.generator.as_deref().map(Path::new) {
        inspect_generator_source(generator_path, &declared, report);
    }
    if let (Some(blocks_path), Some(generator_path)) = (
        entrypoints.blocks.as_deref().map(Path::new),
        entrypoints.generator.as_deref().map(Path::new),
    ) {
        inspect_parameter_contract_consistency(&manifest, blocks_path, generator_path, report);
    }
}

fn inspect_block_semantics(manifest: &BlockPackageManifest, report: &mut PackageQualityReport) {
    let error_count_before = report
        .checks
        .iter()
        .filter(|check| check.status == "error")
        .count();
    for block in &manifest.blocks {
        let kind = block.kind.as_deref().unwrap_or("statement");
        if !matches!(kind, "statement" | "value" | "hat" | "terminal") {
            report.error(
                "invalid-block-kind",
                format!(
                    "Block '{}' has unsupported kind '{}'.",
                    block.block_type, kind
                ),
            );
        }
        let has_output = if manifest.schema_version == 2 {
            block
                .output
                .as_ref()
                .and_then(|value| value.get("connection"))
                .and_then(serde_json::Value::as_str)
                == Some("value")
        } else {
            block.output.as_ref().is_some_and(|value| !value.is_null())
        };
        if kind == "value" && !has_output {
            report.error(
                "missing-block-output",
                format!("Value block '{}' must declare output.", block.block_type),
            );
        } else if kind != "value" && has_output {
            report.error(
                "unexpected-block-output",
                format!(
                    "Non-value block '{}' must not declare output.",
                    block.block_type
                ),
            );
        }

        let mut field_names = HashSet::new();
        for field in &block.fields {
            let Some(object) = field.as_object() else {
                report.error(
                    "invalid-block-field",
                    format!("Block '{}' contains a non-object field.", block.block_type),
                );
                continue;
            };
            let name = object
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            if !valid_symbol_name(name) || !field_names.insert(name.to_string()) {
                report.error(
                    "invalid-block-field",
                    format!(
                        "Block '{}' has an invalid or duplicate field name '{}'.",
                        block.block_type, name
                    ),
                );
            }
            if object.get("kind").and_then(serde_json::Value::as_str) == Some("dropdown") {
                let options = object.get("options").and_then(serde_json::Value::as_array);
                if options.is_none_or(Vec::is_empty) {
                    report.error(
                        "invalid-dropdown-field",
                        format!(
                            "Dropdown field '{}.{}' requires non-empty options.",
                            block.block_type, name
                        ),
                    );
                } else if let Some(default) = object.get("default") {
                    let contains_default = options.is_some_and(|items| {
                        items.iter().any(|item| item.get("value") == Some(default))
                    });
                    if !contains_default {
                        report.error(
                            "invalid-dropdown-default",
                            format!(
                                "Dropdown default for '{}.{}' is not present in options.",
                                block.block_type, name
                            ),
                        );
                    }
                }
            }
        }

        let mut input_names = HashSet::new();
        for input in &block.inputs {
            let Some(object) = input.as_object() else {
                report.error(
                    "invalid-block-input",
                    format!("Block '{}' contains a non-object input.", block.block_type),
                );
                continue;
            };
            let name = object
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let kind = object
                .get("kind")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("value");
            if !valid_symbol_name(name)
                || !input_names.insert(name.to_string())
                || !matches!(kind, "value" | "statement")
            {
                report.error(
                    "invalid-block-input",
                    format!(
                        "Block '{}' has an invalid or duplicate input '{}'.",
                        block.block_type, name
                    ),
                );
            }
        }
    }
    let error_count_after = report
        .checks
        .iter()
        .filter(|check| check.status == "error")
        .count();
    if error_count_after == error_count_before {
        report.pass(
            "block-semantics",
            "Block kinds, fields, inputs and outputs are internally consistent.",
        );
    }
}

fn inspect_compatibility(
    compatibility: &BlockPackageCompatibility,
    report: &mut PackageQualityReport,
) {
    if compatibility.boards.is_empty() && compatibility.architectures.is_empty() {
        report.warn(
            "missing-compatibility",
            "Declare compatible boards or architectures so incompatible blocks can be filtered.",
        );
        return;
    }
    let invalid_boards = compatibility
        .boards
        .iter()
        .filter(|pattern| !valid_board_pattern(pattern))
        .cloned()
        .collect::<Vec<_>>();
    let invalid_architectures = compatibility
        .architectures
        .iter()
        .filter(|architecture| {
            architecture.as_str() != "*" && !quality_package_id(architecture.as_str(), false)
        })
        .cloned()
        .collect::<Vec<_>>();
    if invalid_boards.is_empty() && invalid_architectures.is_empty() {
        report.pass("compatibility", "Compatibility selectors are well-formed.");
    } else {
        report.error(
            "invalid-compatibility",
            format!(
                "Invalid board patterns [{}] or architectures [{}].",
                invalid_boards.join(", "),
                invalid_architectures.join(", ")
            ),
        );
    }
}

fn valid_board_pattern(value: &str) -> bool {
    if value == "*" {
        return true;
    }
    let parts = value.split(':').collect::<Vec<_>>();
    parts.len() == 3
        && parts
            .iter()
            .enumerate()
            .all(|(index, part)| (index == 2 && *part == "*") || quality_package_id(part, false))
}

fn valid_symbol_name(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(ch) if ch.is_ascii_alphabetic() || ch == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn package_has_license(root: &Path) -> bool {
    ["LICENSE", "LICENSE.txt", "LICENSE.md", "COPYING"]
        .iter()
        .any(|name| root.join(name).is_file())
}

fn text_has_external_or_inline_resource(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    [
        "http:",
        "https:",
        "file:",
        "data:",
        "blob:",
        "ftp:",
        "ws:",
        "wss:",
        "javascript:",
        "vbscript:",
        "url(",
    ]
    .iter()
    .any(|token| lower.contains(token))
        || lower.trim_start().starts_with("//")
}

fn validate_declarative_json_resources(value: &serde_json::Value) -> Result<(), String> {
    fn visit(
        value: &serde_json::Value,
        path: &str,
        depth: usize,
        nodes: &mut usize,
    ) -> Result<(), String> {
        *nodes += 1;
        if *nodes > 10_000 || depth > 64 {
            return Err("Declarative data exceeds the structural safety limit.".to_string());
        }
        match value {
            serde_json::Value::String(text) => {
                if text_has_external_or_inline_resource(text) {
                    return Err(format!(
                        "{} contains an external or inline resource reference.",
                        path
                    ));
                }
            }
            serde_json::Value::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    visit(item, &format!("{}[{}]", path, index), depth + 1, nodes)?;
                }
            }
            serde_json::Value::Object(object) => {
                if object
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|value| value.eq_ignore_ascii_case("field_image"))
                {
                    return Err(format!(
                        "{} uses field_image, which is disabled for third-party declarative data.",
                        path
                    ));
                }
                for (key, child) in object {
                    let normalized = key.to_ascii_lowercase();
                    if matches!(
                        normalized.as_str(),
                        "__proto__" | "prototype" | "constructor"
                    ) {
                        return Err(format!("{}.{} uses a prototype-sensitive key.", path, key));
                    }
                    if matches!(normalized.as_str(), "src" | "href" | "xlink:href" | "url")
                        && !child.is_null()
                        && child.as_str() != Some("")
                    {
                        return Err(format!(
                            "{}.{} is a resource-bearing field and is disabled.",
                            path, key
                        ));
                    }
                    if matches!(normalized.as_str(), "callbackkey" | "custom") {
                        return Err(format!(
                            "{}.{} may invoke a runtime callback and is disabled.",
                            path, key
                        ));
                    }
                    visit(child, &format!("{}.{}", path, key), depth + 1, nodes)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    let mut nodes = 0;
    visit(value, "declarative data", 0, &mut nodes)
}

fn parse_toolbox_block_types(path: &Path) -> Result<BTreeSet<String>, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Cannot read toolbox entrypoint: {}", error))?;
    if raw.len() > 512 * 1024 {
        return Err("Toolbox exceeds the 512 KiB limit.".to_string());
    }
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        let json: serde_json::Value = serde_json::from_str(strip_utf8_bom(&raw))
            .map_err(|error| format!("Invalid toolbox JSON: {}", error))?;
        validate_declarative_json_resources(&json)?;
        let mut types = BTreeSet::new();
        collect_json_toolbox_types(&json, &mut types);
        return Ok(types);
    }

    let lower = raw.to_ascii_lowercase();
    if lower.contains("<!doctype")
        || lower.contains("<!entity")
        || lower.contains("<?xml-stylesheet")
        || [
            "<script",
            "<image",
            "<img",
            "<iframe",
            "<object",
            "<embed",
            "<link",
            "<style",
            "<foreignobject",
        ]
        .iter()
        .any(|tag| lower.contains(tag))
        || text_has_external_or_inline_resource(&raw)
    {
        return Err(
            "Toolbox XML contains an external, inline, or resource-capable construct.".to_string(),
        );
    }
    let mut reader = quick_xml::Reader::from_str(strip_utf8_bom(&raw));
    reader.config_mut().trim_text(true);
    let mut types = BTreeSet::new();
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(event))
            | Ok(quick_xml::events::Event::Empty(event)) => {
                for attribute in event.attributes() {
                    let attribute = attribute
                        .map_err(|error| format!("Invalid toolbox attribute: {}", error))?;
                    let key = String::from_utf8_lossy(attribute.key.as_ref()).to_ascii_lowercase();
                    let value = attribute
                        .decode_and_unescape_value(reader.decoder())
                        .map_err(|error| format!("Invalid toolbox attribute: {}", error))?;
                    if matches!(
                        key.as_str(),
                        "src" | "href" | "xlink:href" | "callbackkey" | "custom"
                    ) || text_has_external_or_inline_resource(&value)
                    {
                        return Err(format!(
                            "Toolbox XML attribute '{}' is resource-capable or external.",
                            key
                        ));
                    }
                    if event.name().as_ref() == b"block"
                        && key == "type"
                        && !value.trim().is_empty()
                    {
                        types.insert(value.into_owned());
                    }
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(format!("Invalid toolbox XML: {}", error)),
        }
    }
    Ok(types)
}

fn collect_json_toolbox_types(value: &serde_json::Value, out: &mut BTreeSet<String>) {
    match value {
        serde_json::Value::Object(object) => {
            if object.get("kind").and_then(serde_json::Value::as_str) == Some("block") {
                if let Some(block_type) = object.get("type").and_then(serde_json::Value::as_str) {
                    out.insert(block_type.to_string());
                }
            }
            for child in object.values() {
                collect_json_toolbox_types(child, out);
            }
        }
        serde_json::Value::Array(items) => {
            for child in items {
                collect_json_toolbox_types(child, out);
            }
        }
        _ => {}
    }
}

fn path_has_json_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
}

fn json_block_definition_types(source: &str) -> Result<BTreeSet<String>, String> {
    if source.len() > 512 * 1024 {
        return Err("Block definitions exceed the 512 KiB limit.".to_string());
    }
    let value: serde_json::Value = serde_json::from_str(strip_utf8_bom(source))
        .map_err(|error| format!("Block definitions must be strict JSON: {}", error))?;
    validate_declarative_json_resources(&value)?;
    let definitions: Vec<&serde_json::Value> = match &value {
        serde_json::Value::Array(items) => items.iter().collect(),
        serde_json::Value::Object(object) => {
            if let Some(items) = object.get("blocks").and_then(serde_json::Value::as_array) {
                items.iter().collect()
            } else if object.get("type").is_some() {
                vec![&value]
            } else {
                return Err(
                    "Block definitions must be an array, a {\"blocks\": [...]} object, or one block object."
                        .to_string(),
                );
            }
        }
        _ => {
            return Err(
                "Block definitions must be a JSON array or object containing block definitions."
                    .to_string(),
            );
        }
    };
    if definitions.is_empty() || definitions.len() > 256 {
        return Err("Block definitions must contain between 1 and 256 blocks.".to_string());
    }

    let mut types = BTreeSet::new();
    for (index, definition) in definitions.into_iter().enumerate() {
        let object = definition
            .as_object()
            .ok_or_else(|| format!("Block definition {} must be an object.", index))?;
        let block_type = object
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if !valid_block_type(block_type) || !types.insert(block_type.to_string()) {
            return Err(format!(
                "Block definition {} has an invalid or duplicate type.",
                index
            ));
        }
    }
    Ok(types)
}

#[derive(Debug, Clone, Default)]
struct BlockDefinitionContract {
    fields: BTreeSet<String>,
    value_inputs: BTreeSet<String>,
    statement_inputs: BTreeSet<String>,
    shape: String,
}

#[derive(Debug, Clone, Default)]
struct GeneratorRuleContract {
    kind: String,
    fields: BTreeSet<String>,
    value_inputs: BTreeSet<String>,
    statement_inputs: BTreeSet<String>,
}

fn declarative_block_definitions(
    source: &str,
) -> Result<BTreeMap<String, BlockDefinitionContract>, String> {
    // Keep the security/resource validation in one place. This second parse
    // only extracts the names and connection shape needed for the cross-file
    // contract; it must never make an invalid definitions document valid.
    json_block_definition_types(source)?;
    let value: serde_json::Value = serde_json::from_str(strip_utf8_bom(source))
        .map_err(|error| format!("Block definitions must be strict JSON: {}", error))?;
    let definitions: Vec<&serde_json::Value> = match &value {
        serde_json::Value::Array(items) => items.iter().collect(),
        serde_json::Value::Object(object) => object
            .get("blocks")
            .and_then(serde_json::Value::as_array)
            .map(|items| items.iter().collect())
            .unwrap_or_else(|| vec![&value]),
        _ => Vec::new(),
    };
    let mut contracts = BTreeMap::new();
    for (index, definition) in definitions.into_iter().enumerate() {
        let object = definition
            .as_object()
            .ok_or_else(|| format!("Block definition {} must be an object.", index))?;
        let block_type = object
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        let output = object.contains_key("output");
        let previous = object.contains_key("previousStatement");
        let next = object.contains_key("nextStatement");
        let shape = match (output, previous, next) {
            (true, false, false) => "value",
            (false, true, true) => "statement",
            (false, false, true) => "hat",
            (false, true, false) => "terminal",
            _ => "unknown",
        }
        .to_string();
        let mut contract = BlockDefinitionContract {
            shape,
            ..BlockDefinitionContract::default()
        };
        let mut arg_keys = object
            .keys()
            .filter(|key| {
                key.strip_prefix("args").is_some_and(|suffix| {
                    !suffix.is_empty() && suffix.chars().all(|ch| ch.is_ascii_digit())
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        arg_keys.sort();
        for key in arg_keys {
            let args = object
                .get(&key)
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| format!("Block definition {}.{} must be an array.", index, key))?;
            for (arg_index, argument) in args.iter().enumerate() {
                let argument = argument.as_object().ok_or_else(|| {
                    format!(
                        "Block definition {}.{}[{}] must be an object.",
                        index, key, arg_index
                    )
                })?;
                let argument_type = argument
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let name = argument
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let target = if argument_type.starts_with("field_") {
                    // Unnamed field_label values are presentation-only. Every
                    // named field is part of the generator/metadata contract.
                    if name.is_empty() {
                        continue;
                    }
                    &mut contract.fields
                } else if argument_type == "input_value" {
                    &mut contract.value_inputs
                } else if argument_type == "input_statement" {
                    &mut contract.statement_inputs
                } else {
                    continue;
                };
                if !valid_symbol_name(name) || !target.insert(name.to_string()) {
                    return Err(format!(
                        "Block definition '{}' contains an invalid or duplicate argument name '{}'.",
                        block_type, name
                    ));
                }
            }
        }
        contracts.insert(block_type, contract);
    }
    Ok(contracts)
}

fn collect_generator_placeholders(
    value: &str,
    location: &str,
    contract: &mut GeneratorRuleContract,
) -> Result<(), String> {
    validate_generator_template(value, location)?;
    let mut cursor = 0usize;
    while let Some(relative_start) = value[cursor..].find("{{") {
        let start = cursor + relative_start;
        let relative_end = value[start + 2..]
            .find("}}")
            .ok_or_else(|| format!("{} contains an unterminated placeholder.", location))?;
        let end = start + 2 + relative_end;
        let token = &value[start + 2..end];
        let (kind, name) = token
            .split_once(':')
            .ok_or_else(|| format!("{} contains an invalid placeholder.", location))?;
        match kind {
            "field" | "field_json" => {
                contract.fields.insert(name.to_string());
            }
            "value" => {
                contract.value_inputs.insert(name.to_string());
            }
            "statement" => {
                contract.statement_inputs.insert(name.to_string());
            }
            _ => return Err(format!("{} contains an invalid placeholder.", location)),
        }
        cursor = end + 2;
    }
    Ok(())
}

fn declarative_generator_contracts(
    source: &str,
) -> Result<BTreeMap<String, GeneratorRuleContract>, String> {
    declarative_generator_types(source)?;
    let value: serde_json::Value = serde_json::from_str(strip_utf8_bom(source))
        .map_err(|error| format!("ck-generator must be strict JSON: {}", error))?;
    let rules = value
        .get("rules")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "ck-generator rules must be an array.".to_string())?;
    let mut contracts = BTreeMap::new();
    for (index, rule) in rules.iter().enumerate() {
        let object = rule
            .as_object()
            .ok_or_else(|| format!("ck-generator rule {} must be an object.", index))?;
        let block_type = object
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        let mut contract = GeneratorRuleContract {
            kind: object
                .get("kind")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
            ..GeneratorRuleContract::default()
        };
        let template = object
            .get("template")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        collect_generator_placeholders(
            template,
            &format!("ck-generator rule {}.template", index),
            &mut contract,
        )?;
        for section in ["includes", "declarations", "setup"] {
            if let Some(artifacts) = object.get(section).and_then(serde_json::Value::as_object) {
                for (key, template) in artifacts {
                    let template = template.as_str().ok_or_else(|| {
                        format!(
                            "ck-generator rule {}.{}.{} must be a string.",
                            index, section, key
                        )
                    })?;
                    collect_generator_placeholders(
                        template,
                        &format!("ck-generator rule {}.{}.{}", index, section, key),
                        &mut contract,
                    )?;
                }
            }
        }
        contracts.insert(block_type, contract);
    }
    Ok(contracts)
}

fn manifest_named_values(
    values: &[serde_json::Value],
    location: &str,
) -> Result<BTreeSet<String>, String> {
    let mut names = BTreeSet::new();
    for (index, value) in values.iter().enumerate() {
        let name = value
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if !valid_symbol_name(name) || !names.insert(name.to_string()) {
            return Err(format!(
                "{}.{} has an invalid or duplicate name.",
                location, index
            ));
        }
    }
    Ok(names)
}

fn manifest_input_values(
    values: &[serde_json::Value],
    location: &str,
) -> Result<(BTreeSet<String>, BTreeSet<String>), String> {
    let mut value_inputs = BTreeSet::new();
    let mut statement_inputs = BTreeSet::new();
    let mut all = BTreeSet::new();
    for (index, value) in values.iter().enumerate() {
        let name = value
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let kind = value
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if !valid_symbol_name(name) || !all.insert(name.to_string()) {
            return Err(format!(
                "{}.{} has an invalid or duplicate name.",
                location, index
            ));
        }
        match kind {
            "value" => {
                value_inputs.insert(name.to_string());
            }
            "statement" => {
                statement_inputs.insert(name.to_string());
            }
            _ => {
                return Err(format!("{}.{} has an invalid kind.", location, index));
            }
        }
    }
    Ok((value_inputs, statement_inputs))
}

fn set_difference_label(left: &BTreeSet<String>, right: &BTreeSet<String>) -> String {
    left.difference(right)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ")
}

fn inspect_parameter_contract_consistency(
    manifest: &BlockPackageManifest,
    blocks_path: &Path,
    generator_path: &Path,
    report: &mut PackageQualityReport,
) {
    let blocks_source = match fs::read_to_string(blocks_path) {
        Ok(value) => value,
        Err(_) => return,
    };
    let generator_source = match fs::read_to_string(generator_path) {
        Ok(value) => value,
        Err(_) => return,
    };
    let definitions = match declarative_block_definitions(&blocks_source) {
        Ok(value) => value,
        Err(_) => return,
    };
    let generators = match declarative_generator_contracts(&generator_source) {
        Ok(value) => value,
        Err(_) => return,
    };
    let error_count_before = report
        .checks
        .iter()
        .filter(|check| check.status == "error")
        .count();
    for (index, block) in manifest.blocks.iter().enumerate() {
        let Some(definition) = definitions.get(&block.block_type) else {
            continue;
        };
        let Some(generator) = generators.get(&block.block_type) else {
            continue;
        };
        // v2 makes `kind` a required machine contract. Legacy v1 packages may
        // omit it, so in that one case derive the expected generator kind from
        // the actual Blockly connection shape instead of silently treating a
        // valid value block as a statement block.
        let declared_shape = block.kind.as_deref();
        let expected_shape = declared_shape.unwrap_or(definition.shape.as_str());
        let expected_generator_kind = if expected_shape == "value" {
            "expression"
        } else {
            "statement"
        };
        if generator.kind != expected_generator_kind {
            let shape_source = if declared_shape.is_some() {
                "metadata"
            } else {
                "Blockly definition"
            };
            report.error(
                "generator-kind-mismatch",
                format!(
                    "Block '{}' is '{}' in {} but its generator kind is '{}'.",
                    block.block_type, expected_shape, shape_source, generator.kind
                ),
            );
        }
        if definition.shape == "unknown" {
            report.error(
                "block-shape-mismatch",
                format!(
                    "Block '{}' has an ambiguous Blockly connection shape.",
                    block.block_type
                ),
            );
        } else if declared_shape.is_some() && definition.shape != expected_shape {
            report.error(
                "block-shape-mismatch",
                format!(
                    "Block '{}' is '{}' metadata but its Blockly connection shape is '{}'.",
                    block.block_type, expected_shape, definition.shape
                ),
            );
        }

        // A generator may intentionally leave a presentation-only field
        // unused, but it must never reference a field/input absent from the
        // strict Blockly definition. This rule also protects legacy v1 data.
        for (used, declared, label) in [
            (&generator.fields, &definition.fields, "field"),
            (
                &generator.value_inputs,
                &definition.value_inputs,
                "value input",
            ),
            (
                &generator.statement_inputs,
                &definition.statement_inputs,
                "statement input",
            ),
        ] {
            let missing = set_difference_label(used, declared);
            if !missing.is_empty() {
                report.error(
                    "generator-placeholder-mismatch",
                    format!(
                        "Block '{}' generator references undeclared {} name(s): {}.",
                        block.block_type, label, missing
                    ),
                );
            }
        }

        if manifest.schema_version != 2 {
            continue;
        }
        let metadata_fields =
            match manifest_named_values(&block.fields, &format!("blocks[{}].fields", index)) {
                Ok(value) => value,
                Err(error) => {
                    report.error("invalid-v2-parameter-contract", error);
                    continue;
                }
            };
        let (metadata_values, metadata_statements) =
            match manifest_input_values(&block.inputs, &format!("blocks[{}].inputs", index)) {
                Ok(value) => value,
                Err(error) => {
                    report.error("invalid-v2-parameter-contract", error);
                    continue;
                }
            };
        for (metadata, definition_values, label) in [
            (&metadata_fields, &definition.fields, "field"),
            (&metadata_values, &definition.value_inputs, "value input"),
            (
                &metadata_statements,
                &definition.statement_inputs,
                "statement input",
            ),
        ] {
            let missing_definition = set_difference_label(metadata, definition_values);
            let missing_metadata = set_difference_label(definition_values, metadata);
            if !missing_definition.is_empty() || !missing_metadata.is_empty() {
                report.error(
                    "block-definition-parameter-mismatch",
                    format!(
                        "Block '{}' {} metadata/definition mismatch (metadata only: [{}], definition only: [{}]).",
                        block.block_type, label, missing_definition, missing_metadata
                    ),
                );
            }
        }
        for (used, metadata, label) in [
            (&generator.fields, &metadata_fields, "field"),
            (&generator.value_inputs, &metadata_values, "value input"),
            (
                &generator.statement_inputs,
                &metadata_statements,
                "statement input",
            ),
        ] {
            let missing = set_difference_label(used, metadata);
            if !missing.is_empty() {
                report.error(
                    "generator-metadata-parameter-mismatch",
                    format!(
                        "Block '{}' generator references {} name(s) absent from v2 metadata: {}.",
                        block.block_type, label, missing
                    ),
                );
            }
        }
    }
    let error_count_after = report
        .checks
        .iter()
        .filter(|check| check.status == "error")
        .count();
    if error_count_after == error_count_before {
        report.pass(
            "parameter-contract-consistency",
            "Blockly arguments, v2 metadata, generator placeholders, and connection shapes agree.",
        );
    }
}

fn valid_generator_artifact_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '-'))
}

fn validate_generator_template(value: &str, location: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 16 * 1024 || value.contains('\0') {
        return Err(format!("{} must be a non-empty bounded string.", location));
    }

    let bytes = value.as_bytes();
    let mut cursor = 0;
    while let Some(relative_start) = value[cursor..].find("{{") {
        let start = cursor + relative_start;
        let Some(relative_end) = value[start + 2..].find("}}") else {
            return Err(format!(
                "{} contains an unterminated placeholder.",
                location
            ));
        };
        let end = start + 2 + relative_end;
        let token = &value[start + 2..end];
        let Some((kind, name)) = token.split_once(':') else {
            return Err(format!("{} contains an invalid placeholder.", location));
        };
        if !matches!(kind, "field" | "field_json" | "value" | "statement")
            || !valid_symbol_name(name)
        {
            return Err(format!("{} contains an invalid placeholder.", location));
        }
        cursor = end + 2;
    }
    if bytes.windows(2).any(|pair| pair == b"}}") {
        let mut open_count = 0usize;
        let mut close_count = 0usize;
        for pair in bytes.windows(2) {
            if pair == b"{{" {
                open_count += 1;
            } else if pair == b"}}" {
                close_count += 1;
            }
        }
        if open_count != close_count {
            return Err(format!("{} contains an unmatched placeholder.", location));
        }
    }
    Ok(())
}

fn validate_generator_artifacts(
    rule: &serde_json::Map<String, serde_json::Value>,
    section: &str,
    rule_index: usize,
) -> Result<(), String> {
    let Some(value) = rule.get(section) else {
        return Ok(());
    };
    let object = value.as_object().ok_or_else(|| {
        format!(
            "ck-generator rule {}.{} must be an object.",
            rule_index, section
        )
    })?;
    if object.len() > 16 {
        return Err(format!(
            "ck-generator rule {}.{} contains too many entries.",
            rule_index, section
        ));
    }
    for (key, template) in object {
        if !valid_generator_artifact_key(key) {
            return Err(format!(
                "ck-generator rule {}.{} has an invalid key.",
                rule_index, section
            ));
        }
        let template = template.as_str().ok_or_else(|| {
            format!(
                "ck-generator rule {}.{}.{} must be a string.",
                rule_index, section, key
            )
        })?;
        validate_generator_template(
            template,
            &format!("ck-generator rule {}.{}.{}", rule_index, section, key),
        )?;
    }
    Ok(())
}

fn declarative_generator_types(source: &str) -> Result<BTreeSet<String>, String> {
    if source.len() > 512 * 1024 {
        return Err("ck-generator document exceeds the 512 KiB limit.".to_string());
    }
    let value: serde_json::Value = serde_json::from_str(strip_utf8_bom(source))
        .map_err(|error| format!("ck-generator must be strict JSON: {}", error))?;
    let document = value
        .as_object()
        .ok_or_else(|| "ck-generator root must be an object.".to_string())?;
    let allowed_root = ["schema", "version", "rules"];
    if document
        .keys()
        .any(|key| !allowed_root.contains(&key.as_str()))
    {
        return Err("ck-generator root contains unsupported fields.".to_string());
    }
    if document.get("schema").and_then(serde_json::Value::as_str) != Some("ck-generator")
        || document.get("version").and_then(serde_json::Value::as_u64) != Some(1)
    {
        return Err("Unsupported ck-generator schema or version.".to_string());
    }
    let rules = document
        .get("rules")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "ck-generator rules must be an array.".to_string())?;
    if rules.is_empty() || rules.len() > 128 {
        return Err("ck-generator rules must contain between 1 and 128 rules.".to_string());
    }

    let allowed_rule = [
        "type",
        "kind",
        "template",
        "order",
        "includes",
        "declarations",
        "setup",
    ];
    let mut types = BTreeSet::new();
    let mut total_template_bytes = 0usize;
    for (index, rule) in rules.iter().enumerate() {
        let object = rule
            .as_object()
            .ok_or_else(|| format!("ck-generator rule {} must be an object.", index))?;
        if object
            .keys()
            .any(|key| !allowed_rule.contains(&key.as_str()))
        {
            return Err(format!(
                "ck-generator rule {} contains unsupported fields.",
                index
            ));
        }
        let block_type = object
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if !valid_block_type(block_type) || !types.insert(block_type.to_string()) {
            return Err(format!(
                "ck-generator rule {} has an invalid or duplicate block type.",
                index
            ));
        }
        if !matches!(
            object.get("kind").and_then(serde_json::Value::as_str),
            Some("statement" | "expression")
        ) {
            return Err(format!("ck-generator rule {} has an invalid kind.", index));
        }
        let template = object
            .get("template")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| format!("ck-generator rule {} requires a template.", index))?;
        validate_generator_template(template, &format!("ck-generator rule {}.template", index))?;
        total_template_bytes += template.len();
        if let Some(order) = object.get("order") {
            let valid_order = order.as_u64().is_some_and(|value| value <= 99);
            if !valid_order {
                return Err(format!("ck-generator rule {} has an invalid order.", index));
            }
        }
        for section in ["includes", "declarations", "setup"] {
            validate_generator_artifacts(object, section, index)?;
            if let Some(artifacts) = object.get(section).and_then(serde_json::Value::as_object) {
                total_template_bytes += artifacts
                    .values()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::len)
                    .sum::<usize>();
            }
        }
        if total_template_bytes > 384 * 1024 {
            return Err("ck-generator templates exceed the 384 KiB aggregate limit.".to_string());
        }
    }
    Ok(types)
}

fn inspect_blocks_source(
    path: &Path,
    declared: &BTreeSet<String>,
    report: &mut PackageQualityReport,
) {
    if !path_has_json_extension(path) {
        report.error(
            "legacy-javascript-disabled",
            "Executable Blockly block definitions are disabled. Use strict JSON block definitions.",
        );
        return;
    }
    let source = match fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) => {
            report.error(
                "unreadable-blocks-entrypoint",
                format!("Cannot read block definitions: {}", error),
            );
            return;
        }
    };
    if source.trim().is_empty() {
        report.error(
            "empty-blocks-entrypoint",
            "Block definitions file is empty.",
        );
        return;
    }
    let registered = match json_block_definition_types(&source) {
        Ok(types) => types,
        Err(error) => {
            report.error("invalid-block-definitions", error);
            return;
        }
    };
    let missing = declared
        .difference(&registered)
        .cloned()
        .collect::<Vec<_>>();
    let undeclared = registered.difference(declared).cloned().collect::<Vec<_>>();
    if missing.is_empty() {
        report.pass(
            "block-registrations",
            "Every declared block has a JSON definition.",
        );
    } else {
        report.error(
            "missing-block-registration",
            format!("Missing Blockly registrations: {}.", missing.join(", ")),
        );
    }
    if !undeclared.is_empty() {
        report.error(
            "undeclared-block-definition",
            format!(
                "JSON definitions contain undeclared block types: {}.",
                undeclared.join(", ")
            ),
        );
    }
}

fn inspect_generator_source(
    path: &Path,
    declared: &BTreeSet<String>,
    report: &mut PackageQualityReport,
) {
    if !path_has_json_extension(path) {
        report.error(
            "legacy-javascript-disabled",
            "Executable Arduino generator JavaScript is disabled. Use ck-generator JSON.",
        );
        return;
    }
    let source = match fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) => {
            report.error(
                "unreadable-generator-entrypoint",
                format!("Cannot read Arduino generator: {}", error),
            );
            return;
        }
    };
    if source.trim().is_empty() {
        report.error(
            "empty-generator-entrypoint",
            "Arduino generator file is empty.",
        );
        return;
    }
    let registered = match declarative_generator_types(&source) {
        Ok(types) => types,
        Err(error) => {
            report.error("invalid-declarative-generator", error);
            return;
        }
    };
    let missing = declared
        .difference(&registered)
        .cloned()
        .collect::<Vec<_>>();
    let undeclared = registered.difference(declared).cloned().collect::<Vec<_>>();
    if missing.is_empty() {
        report.pass(
            "generator-registrations",
            "Every declared block has a ck-generator rule.",
        );
    } else {
        report.error(
            "missing-generator-registration",
            format!("Missing Arduino generators: {}.", missing.join(", ")),
        );
    }
    if !undeclared.is_empty() {
        report.error(
            "undeclared-generator-registration",
            format!(
                "ck-generator contains undeclared block types: {}.",
                undeclared.join(", ")
            ),
        );
    }
}

fn block_search_entries(manifest: Option<&BlockPackageManifest>) -> Vec<BlockSearchEntry> {
    let Some(manifest) = manifest else {
        return Vec::new();
    };
    manifest
        .blocks
        .iter()
        .map(|block| {
            let mut keywords = manifest.keywords.clone();
            keywords.extend(block.keywords.clone());
            keywords.extend(
                block
                    .block_type
                    .split('_')
                    .filter(|part| !part.is_empty())
                    .map(str::to_string),
            );
            keywords.sort();
            keywords.dedup();
            let mut dependencies = manifest.dependencies.clone();
            dependencies.extend(block.dependencies.clone());
            let metadata_completeness = if manifest.schema_version == 2 {
                [
                    "semantics",
                    "dependencies",
                    "output",
                    "hardware",
                    "generation",
                    "constraints",
                    "examples",
                    "errors",
                ]
                .into_iter()
                .map(str::to_string)
                .collect()
            } else {
                Vec::new()
            };
            BlockSearchEntry {
                block_type: block.block_type.clone(),
                category: block.category.clone(),
                display_name: block.display_name.clone(),
                description: block.description.clone(),
                kind: block.kind.clone(),
                keywords,
                fields: block.fields.clone(),
                inputs: block.inputs.clone(),
                output: block.output.clone(),
                requires: block.requires.clone(),
                metadata_schema_version: manifest.schema_version,
                metadata_source: if manifest.schema_version == 2 {
                    "v2".to_string()
                } else {
                    "v1-adapted".to_string()
                },
                metadata_completeness,
                semantics: block.semantics.clone(),
                dependencies,
                output_contract: (manifest.schema_version == 2)
                    .then(|| block.output.clone())
                    .flatten(),
                hardware: block.hardware.clone(),
                generation: block.generation.clone(),
                constraints: block.constraints.clone(),
                examples: block.examples.clone(),
                errors: block.errors.clone(),
                package_license: manifest.license.clone(),
                library_id: manifest.id.clone(),
                source: "manifest".to_string(),
            }
        })
        .collect()
}

fn parse_manifest_string_array(
    json: &serde_json::Value,
    primary: &str,
    aliases: &[&str],
) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for key in std::iter::once(primary).chain(aliases.iter().copied()) {
        let Some(value) = json.get(key) else {
            continue;
        };
        match value {
            serde_json::Value::String(raw) => {
                for part in raw.split([',', ';']) {
                    let token = part.trim();
                    if !token.is_empty() && !out.iter().any(|v| v == token) {
                        out.push(token.to_string());
                    }
                }
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    if let Some(raw) = item.as_str() {
                        let token = raw.trim();
                        if !token.is_empty() && !out.iter().any(|v| v == token) {
                            out.push(token.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

fn manifest_person_text(value: Option<&serde_json::Value>) -> Option<String> {
    fn append_person(value: &serde_json::Value, people: &mut Vec<String>) {
        match value {
            serde_json::Value::String(raw) => {
                let name = raw.trim();
                if !name.is_empty() && !people.iter().any(|existing| existing == name) {
                    people.push(name.to_string());
                }
            }
            serde_json::Value::Object(person) => {
                if let Some(name) = person
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                {
                    if !people.iter().any(|existing| existing == name) {
                        people.push(name.to_string());
                    }
                }
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    append_person(item, people);
                }
            }
            _ => {}
        }
    }

    let mut people = Vec::new();
    if let Some(value) = value {
        append_person(value, &mut people);
    }
    (!people.is_empty()).then(|| people.join(", "))
}

fn read_library_manifest(root: &Path) -> Option<LibraryManifest> {
    let json_path = root.join("library.json");
    let content = fs::read_to_string(json_path).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(strip_utf8_bom(&content)).ok()?;
    let name = json
        .get("name")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())?;
    let version = json
        .get("version")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "Unknown".to_string());

    Some(LibraryManifest {
        name,
        version,
        author: manifest_person_text(json.get("author")),
        maintainer: manifest_person_text(json.get("maintainer")),
        sentence: json
            .get("sentence")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        paragraph: json
            .get("paragraph")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        website: json
            .get("website")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        category: json
            .get("category")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        architectures: parse_manifest_string_array(
            &json,
            "architectures",
            &["architecture", "platforms", "platform"],
        ),
        includes: parse_manifest_string_array(&json, "includes", &[]),
        id: json
            .get("id")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
    })
}

fn directory_has_root_headers(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|entries| {
            entries.filter_map(Result::ok).any(|e| {
                let name = e.file_name().to_string_lossy().to_lowercase();
                name.ends_with(".h") || name.ends_with(".hpp")
            })
        })
        .unwrap_or(false)
}

fn looks_like_library_dir(path: &Path) -> bool {
    path.join("library.json").exists()
        || path.join("src").is_dir()
        || directory_has_root_headers(path)
}

fn normalize_library_entry_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase()
}

fn fqbn_architecture(board: Option<&str>) -> Option<String> {
    let fqbn = board?.trim();
    if fqbn.is_empty() {
        return None;
    }
    let mut parts = fqbn.split(':');
    let _package = parts.next()?;
    let arch = parts.next()?.trim();
    if arch.is_empty() {
        None
    } else {
        Some(arch.to_ascii_lowercase())
    }
}

fn architecture_list_allows(values: &[String], board_arch: Option<&str>) -> bool {
    if values.is_empty() || values.iter().any(|value| value.trim() == "*") {
        return true;
    }
    let Some(board_arch) = board_arch else {
        return true;
    };
    values
        .iter()
        .any(|value| value.trim().eq_ignore_ascii_case(board_arch))
}

fn board_pattern_matches(pattern: &str, board: &str) -> bool {
    let pattern = pattern.trim().to_ascii_lowercase();
    let board = board.trim().to_ascii_lowercase();
    if pattern == "*" {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix('*') {
        return board.starts_with(prefix);
    }
    board == pattern
}

fn block_package_is_compatible(
    manifest: &BlockPackageManifest,
    board: Option<&str>,
    board_arch: Option<&str>,
) -> bool {
    if !architecture_list_allows(&manifest.compatibility.architectures, board_arch) {
        return false;
    }
    if manifest.compatibility.boards.is_empty() {
        return true;
    }
    let Some(board) = board else {
        return true;
    };
    manifest
        .compatibility
        .boards
        .iter()
        .any(|pattern| board_pattern_matches(pattern, board))
}

/// Resolve the on-disk board-library scope without conflating a compiler FQBN
/// with a third-party board-package id. Built-in/FQBN scopes keep the legacy
/// colon-to-underscore directory contract, while custom package ids map to
/// their exact package directory.
fn board_library_scope_id(board: Option<&str>, board_package_id: Option<&str>) -> Option<String> {
    match (board, board_package_id) {
        (Some(fqbn), Some(package_id)) if package_id != fqbn => Some(package_id.to_string()),
        (Some(fqbn), _) => Some(fqbn.replace(':', "_")),
        (None, Some(package_id)) => Some(package_id.to_string()),
        (None, None) => None,
    }
}

fn custom_board_package_quality_is_trusted(
    board_root: &Path,
    expected_package_id: &str,
    expected_fqbn: &str,
) -> bool {
    let manifest = fs::read_to_string(board_root.join("board.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(strip_utf8_bom(&raw)).ok());
    let Some(manifest) = manifest else {
        return false;
    };
    if manifest.get("id").and_then(serde_json::Value::as_str) != Some(expected_package_id)
        || manifest
            .get("fqbn_base")
            .and_then(serde_json::Value::as_str)
            != Some(expected_fqbn)
    {
        return false;
    }
    let report = read_quality_report_with_integrity(board_root);
    report.as_ref().is_some_and(|report| {
        report.package_kind == "board"
            && report.package_id.as_deref() == Some(expected_package_id)
            && runtime_quality_report_is_trusted(Some(report), "board")
    })
}

pub(crate) fn custom_board_package_runtime_is_trusted(
    app: &AppHandle,
    package_id: &str,
    expected_fqbn: &str,
) -> bool {
    let Ok(app_data) = app.path().app_data_dir() else {
        return false;
    };
    let board_root = app_data.join("CK").join("boards").join(package_id);
    if !custom_board_package_quality_is_trusted(&board_root, package_id, expected_fqbn) {
        return false;
    }
    let manifest = match fs::read_to_string(board_root.join("board.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(strip_utf8_bom(&raw)).ok())
    {
        Some(manifest) => manifest,
        None => return false,
    };
    let core_ready = manifest
        .get("arduino_core")
        .and_then(|value| {
            crate::board_passport::ArduinoCoreRequirement::from_manifest_value(value).ok()
        })
        .map(|requirement| {
            crate::board_passport::evaluate_core_compatibility(&super::ck_root_dir(), &requirement)
                .usable
        })
        .unwrap_or(false);
    if !core_ready {
        return false;
    }
    let lock_path = board_root.join(crate::board_passport::BOARD_LOCK_FILE);
    if lock_path.exists() {
        let library_root = super::ck_root_dir()
            .join("board-package-libraries")
            .join(package_id);
        let passport_ready = crate::board_passport::read_passport(&board_root)
            .and_then(|passport| {
                crate::board_passport::evaluate_passport(
                    passport,
                    &manifest,
                    &board_root,
                    Some(&library_root),
                    &super::ck_root_dir(),
                )
            })
            .is_ok_and(|passport| {
                !passport
                    .invalidated_reasons
                    .iter()
                    .any(|reason| reason == "installed_content_changed")
            });
        if !passport_ready {
            return false;
        }
    }
    true
}

pub(crate) fn library_install_scope_id(
    app: &AppHandle,
    board: &str,
    board_package_id: Option<&str>,
) -> Result<String, String> {
    let board_scope = base_fqbn_scope(board)?;
    let package_id = board_package_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(package_id) = package_id else {
        return Ok(board_scope.replace(':', "_"));
    };
    if package_id == board_scope {
        return Ok(board_scope.replace(':', "_"));
    }
    if !quality_package_id(package_id, false) {
        return Err("Board package id contains unsafe characters".to_string());
    }
    if !custom_board_package_runtime_is_trusted(app, package_id, &board_scope) {
        return Err(format!(
            "Board package {} is missing, stale, uncertified, or not ready; library import was blocked.",
            package_id
        ));
    }
    Ok(package_id.to_string())
}

#[tauri::command]
pub async fn get_all_libraries(
    app: AppHandle,
    board: Option<String>,
    board_package_id: Option<String>,
) -> Result<Vec<LibraryInfo>, String> {
    let board = board.as_deref().map(base_fqbn_scope).transpose()?;
    let board_package_id = board_package_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(package_id) = board_package_id.as_deref() {
        if !quality_package_id(package_id, false)
            && package_id != board.as_deref().unwrap_or_default()
        {
            return Err("Board package id contains unsafe characters".to_string());
        }
    }
    let custom_board_package_id = board_package_id
        .as_deref()
        .filter(|package_id| Some(*package_id) != board.as_deref());
    let custom_board_scope_trusted = custom_board_package_id.is_none_or(|package_id| {
        board
            .as_deref()
            .is_some_and(|fqbn| custom_board_package_runtime_is_trusted(&app, package_id, fqbn))
    });
    if !custom_board_scope_trusted {
        log::warn!(
            "Ignoring untrusted board-package library scope: {}",
            custom_board_package_id.unwrap_or("unknown")
        );
    }
    let board_scope = custom_board_scope_trusted
        .then(|| board_library_scope_id(board.as_deref(), board_package_id.as_deref()))
        .flatten();
    let mut libraries: Vec<LibraryInfo> = Vec::new();
    let mut seen_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    let board_arch = fqbn_architecture(board.as_deref());

    // Helper to scan a directory
    let scan_dir = |path: PathBuf,
                    location: &str,
                    scope_detail: Option<String>,
                    require_trusted_executable: bool,
                    libs: &mut Vec<LibraryInfo>,
                    seen: &mut std::collections::HashSet<String>| {
        if let Ok(entries) = fs::read_dir(&path) {
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if path.is_dir() {
                    // Keep board package folders out of library listing.
                    if path.join("board.json").exists() {
                        continue;
                    }

                    if !looks_like_library_dir(&path) {
                        continue;
                    }

                    let folder_name = path
                        .file_name()
                        .and_then(|v| v.to_str())
                        .unwrap_or_default()
                        .to_string();
                    let manifest = read_library_manifest(&path);

                    // Use ID from manifest or folder name
                    let id = manifest
                        .as_ref()
                        .and_then(|m| m.id.clone())
                        .unwrap_or_else(|| folder_name.clone());
                    let entry_key = normalize_library_entry_key(&path);
                    if seen.insert(entry_key.clone()) {
                        let assets_path = path.join("assets");
                        let assets = if assets_path.exists() {
                            Some(assets_path.to_string_lossy().to_string())
                        } else {
                            None
                        };

                        let (mut block_manifest, mut diagnostics) =
                            read_block_package_manifest(&path, &folder_name);
                        let library_architectures = manifest
                            .as_ref()
                            .and_then(|item| item.architectures.as_deref())
                            .unwrap_or(&[]);
                        if !architecture_list_allows(library_architectures, board_arch.as_deref())
                            || block_manifest.as_ref().is_some_and(|item| {
                                !block_package_is_compatible(
                                    item,
                                    board.as_deref(),
                                    board_arch.as_deref(),
                                )
                            })
                        {
                            continue;
                        }
                        let mut block_entrypoints = resolve_block_entrypoints(
                            &path,
                            block_manifest.as_ref(),
                            &mut diagnostics,
                        );
                        let mut block_search_entries =
                            block_search_entries(block_manifest.as_ref());
                        let mut has_blocks = block_entrypoints.blocks.is_some();
                        let mut has_toolbox = block_entrypoints.toolbox.is_some();
                        let mut has_generator = block_entrypoints.generator.is_some();
                        let legacy_javascript_present =
                            entrypoint_is_javascript(block_entrypoints.blocks.as_ref())
                                || entrypoint_is_javascript(block_entrypoints.generator.as_ref())
                                || entrypoint_is_javascript(block_entrypoints.toolbox.as_ref());
                        let complete_declarative_runtime = [
                            ("blocks", block_entrypoints.blocks.as_deref()),
                            ("generator", block_entrypoints.generator.as_deref()),
                            ("toolbox", block_entrypoints.toolbox.as_deref()),
                        ]
                        .into_iter()
                        .all(|(label, value)| {
                            value.is_some_and(|value| declarative_entrypoint_allowed(label, value))
                        });
                        let user_installed = path.join(USER_INSTALL_MARKER).is_file();
                        let quality_report = read_or_bootstrap_managed_declarative_quality_report(
                            &path,
                            &id,
                            complete_declarative_runtime,
                            user_installed,
                            &mut diagnostics,
                        );
                        let declarative_quality_trusted = complete_declarative_runtime
                            && runtime_quality_report_is_trusted_for_package(
                                quality_report.as_ref(),
                                "block-library",
                                &id,
                            );
                        let mut runtime_activation = if declarative_quality_trusted {
                            RuntimeActivationInfo {
                                state: "declarative-safe".to_string(),
                                executable_present: false,
                                package_id: id.clone(),
                                content_sha256: quality_report
                                    .as_ref()
                                    .and_then(|report| report.source_content_sha256.clone()),
                                approved_at: None,
                                reason: "The certified runtime contains declarative JSON data only; no third-party JavaScript is executed.".to_string(),
                            }
                        } else if complete_declarative_runtime {
                            RuntimeActivationInfo {
                                state: "quality-blocked".to_string(),
                                executable_present: false,
                                package_id: id.clone(),
                                content_sha256: quality_report
                                    .as_ref()
                                    .and_then(|report| report.source_content_sha256.clone()),
                                approved_at: None,
                                reason: "The declarative runtime is missing an intact quality report certified for the runtime loader.".to_string(),
                            }
                        } else {
                            runtime_activation_for_package(
                                &app,
                                &id,
                                quality_report.as_ref(),
                                false,
                            )
                        };
                        if legacy_javascript_present {
                            diagnostics.push(library_diagnostic(
                                "legacy-javascript-disabled",
                                "error",
                                "Executable Blockly JavaScript is disabled in CK 1.0. Exact-hash approval is an identity record, not a sandbox; migrate to JSON block definitions and ck-generator JSON.",
                            ));
                            has_blocks = false;
                            has_toolbox = false;
                            has_generator = false;
                            block_entrypoints = ResolvedBlockEntrypoints::default();
                            block_manifest = None;
                            block_search_entries.clear();
                            runtime_activation = RuntimeActivationInfo {
                                state: "legacy-disabled".to_string(),
                                executable_present: true,
                                package_id: id.clone(),
                                content_sha256: quality_report
                                    .as_ref()
                                    .and_then(|report| report.source_content_sha256.clone()),
                                approved_at: None,
                                reason: "Legacy JavaScript has no strong isolation runtime and cannot execute in the main WebView.".to_string(),
                            };
                        } else if require_trusted_executable {
                            if !complete_declarative_runtime
                                && (has_blocks || has_toolbox || has_generator)
                            {
                                diagnostics.push(library_diagnostic(
                                    "incomplete-declarative-runtime",
                                    "warning",
                                    "The block runtime is incomplete. CK requires JSON block definitions, ck-generator JSON, and a JSON/XML toolbox before activation.",
                                ));
                            }
                        }

                        libs.push(LibraryInfo {
                            id,
                            entry_key,
                            folder_name: folder_name.clone(),
                            name: manifest
                                .as_ref()
                                .map(|m| m.name.clone())
                                .unwrap_or_else(|| folder_name.clone()),
                            version: manifest
                                .as_ref()
                                .map(|m| m.version.clone())
                                .unwrap_or_else(|| "Unknown".to_string()),
                            path: path.to_string_lossy().to_string(),
                            location: location.to_string(),
                            scope_detail: scope_detail.clone(),
                            manifest,
                            assets_path: assets,
                            has_blocks,
                            has_toolbox,
                            has_generator,
                            block_manifest,
                            block_search_entries,
                            block_entrypoints,
                            diagnostics,
                            user_installed,
                            quality_report,
                            runtime_activation,
                        });
                    }
                }
            }
        }
    };

    // 1. Bundled Libraries (Highest Priority)
    if let Some(board_scope_id) = board_scope.as_deref() {
        // Resolve board ID (simplified logic, assuming custom board ID is passed or standard FQBN)
        // For custom boards, bundled libs are in `AppData/CK/boards/<id>/libraries`
        // We need to resolve ID from FQBN if it's a custom board.
        // Assuming `board` arg is the full FQBN or ID.
        // If it's a custom board ID (e.g. from board selector), we can check directly.

        if let Ok(app_data) = app.path().app_data_dir() {
            // Heuristic: Try to find folder matching the board string directly first?
            // Or parse FQBN?
            // Let's assume `board` is what `BoardPackage.id` is.
            let board_lib_path = app_data
                .join("CK")
                .join("boards")
                .join(board_scope_id)
                .join("libraries");
            if board_lib_path.exists() {
                scan_dir(
                    board_lib_path,
                    "Bundled",
                    Some(board_scope_id.to_string()),
                    true,
                    &mut libraries,
                    &mut seen_paths,
                );
            }
        }
    }

    // 2. Board Specific
    // - New: Documents/CK/board-package-libraries/<board>
    // - Legacy: Documents/CK/libraries/<board>
    {
        let ck_root = super::ck_root_dir();
        if let Some(board_scope_id) = board_scope.as_deref() {
            let safe_id = board_scope_id.to_string();
            let board_pkg_libs = ck_root.join("board-package-libraries").join(&safe_id);
            if board_pkg_libs.exists() {
                scan_dir(
                    board_pkg_libs,
                    "BoardPackage",
                    Some(safe_id.clone()),
                    true,
                    &mut libraries,
                    &mut seen_paths,
                );
            }

            let legacy_board_libs = ck_root.join("libraries").join(&safe_id);
            if legacy_board_libs.exists() {
                scan_dir(
                    legacy_board_libs,
                    "Board",
                    Some(safe_id),
                    true,
                    &mut libraries,
                    &mut seen_paths,
                );
            }
        }
    }

    // 3. Architecture Specific (ck_root/libraries/<arch>)
    if let Some(arch) = board_arch.clone() {
        let arch_libs = super::ck_root_dir().join("libraries").join(&arch);
        if arch_libs.exists() {
            scan_dir(
                arch_libs,
                "Arch",
                Some(arch),
                true,
                &mut libraries,
                &mut seen_paths,
            );
        }
    }

    // 4. Global Libraries (ck_root/libraries)
    {
        let global_libs = super::ck_root_dir().join("libraries");
        scan_dir(
            global_libs,
            "Global",
            None,
            true,
            &mut libraries,
            &mut seen_paths,
        );
    }

    libraries.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
            .then_with(|| a.version.cmp(&b.version))
            .then_with(|| a.location.cmp(&b.location))
            .then_with(|| a.path.cmp(&b.path))
    });

    // --- Smart dedup: when multiple libraries share the same normalized name,
    // keep only the best candidate per name (highest priority location + newest version).
    // Priority mirrors the compile-time resolution order in pick_best_candidate_for_header:
    //   BoardPackage / Board (board-specific) > Arch > Bundled > Global
    // Board-specific libraries take precedence because they contain code tuned for
    // the current board; generic/global copies of the same library should not shadow them.
    let location_priority = |loc: &str| -> u8 {
        match loc {
            "BoardPackage" => 5,
            "Board" => 4,
            "Arch" => 3,
            "Bundled" => 2,
            "Global" => 1,
            _ => 0,
        }
    };
    let mut best_by_name: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for (idx, lib) in libraries.iter().enumerate() {
        let normalized_name = lib
            .name
            .chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>();
        let name_key = if normalized_name.is_empty() {
            format!("id:{}", lib.id.to_ascii_lowercase())
        } else {
            normalized_name
        };
        match best_by_name.get(&name_key) {
            Some(&best_idx) => {
                let best = &libraries[best_idx];
                let current_priority = location_priority(&lib.location);
                let best_priority = location_priority(&best.location);
                let replace = if current_priority != best_priority {
                    current_priority > best_priority
                } else {
                    match (
                        super::parse_version_rank(&lib.version),
                        super::parse_version_rank(&best.version),
                    ) {
                        (Some(current), Some(previous)) => current > previous,
                        _ => lib.version > best.version,
                    }
                };
                if replace {
                    best_by_name.insert(name_key, idx);
                }
            }
            None => {
                best_by_name.insert(name_key, idx);
            }
        }
    }
    let keep_indices: std::collections::HashSet<usize> = best_by_name.into_values().collect();
    let mut deduped: Vec<LibraryInfo> = libraries
        .into_iter()
        .enumerate()
        .filter(|(idx, _)| keep_indices.contains(idx))
        .map(|(_, lib)| lib)
        .collect();

    let mut block_owners: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for library in &mut deduped {
        for block in &library.block_search_entries {
            if let Some(owner) = block_owners.get(&block.block_type) {
                library.diagnostics.push(library_diagnostic(
                    "duplicate-block-type",
                    "error",
                    format!(
                        "Block type '{}' is also declared by '{}'.",
                        block.block_type, owner
                    ),
                ));
            } else {
                block_owners.insert(block.block_type.clone(), library.id.clone());
            }
        }
    }

    Ok(deduped)
}

#[cfg(test)]
mod block_package_tests {
    use super::*;

    #[test]
    fn built_in_board_package_id_keeps_legacy_fqbn_library_scope() {
        assert_eq!(
            board_library_scope_id(Some("esp32:esp32:esp32c6"), Some("esp32:esp32:esp32c6"),)
                .as_deref(),
            Some("esp32_esp32_esp32c6"),
        );
        assert_eq!(
            board_library_scope_id(Some("arduino:avr:uno"), None).as_deref(),
            Some("arduino_avr_uno"),
        );
    }

    #[test]
    fn custom_board_package_id_has_an_exact_library_scope() {
        assert_eq!(
            board_library_scope_id(Some("esp32:esp32:esp32c6"), Some("acme-c6-carrier"),)
                .as_deref(),
            Some("acme-c6-carrier"),
        );
        assert_ne!(
            board_library_scope_id(Some("esp32:esp32:esp32c6"), Some("acme-c6-carrier"),),
            board_library_scope_id(Some("esp32:esp32:esp32c6"), Some("other-c6-carrier"),),
        );
    }

    #[test]
    fn package_scoped_declarative_runtime_requires_certified_quality() {
        assert!(!runtime_quality_report_is_trusted(None, "block-library"));
        let mut failed = PackageQualityReport::new("block-library");
        failed.error("fixture", "failed");
        failed.finalize();
        assert!(!runtime_quality_report_is_trusted(
            Some(&failed),
            "block-library"
        ));

        let mut passed = PackageQualityReport::new("block-library");
        passed.pass("fixture", "passed");
        passed.finalize();
        assert!(runtime_quality_report_is_trusted(
            Some(&passed),
            "block-library"
        ));
        passed.validated_consumers.clear();
        assert!(!runtime_quality_report_is_trusted(
            Some(&passed),
            "block-library"
        ));
    }

    #[test]
    fn custom_board_scope_rejects_missing_or_stale_parent_quality() {
        let root = temp_package("board_parent_quality");
        let package_id = "acme-c6-parent";
        let fqbn = "esp32:esp32:esp32c6";
        fs::write(
            root.join("board.json"),
            serde_json::json!({
                "schema_version": 1,
                "id": package_id,
                "fqbn_base": fqbn
            })
            .to_string(),
        )
        .unwrap();
        assert!(!custom_board_package_quality_is_trusted(
            &root, package_id, fqbn
        ));

        let mut report = PackageQualityReport::new("board");
        report.package_id = Some(package_id.to_string());
        report.pass("fixture", "passed");
        report.source_content_sha256 = Some(hash_package_contents(&root).unwrap());
        report.finalize();
        write_quality_report(&root, &report).unwrap();
        assert!(custom_board_package_quality_is_trusted(
            &root, package_id, fqbn
        ));

        fs::write(
            root.join("board.json"),
            serde_json::json!({
                "schema_version": 1,
                "id": package_id,
                "fqbn_base": fqbn,
                "tampered": true
            })
            .to_string(),
        )
        .unwrap();
        assert!(!custom_board_package_quality_is_trusted(
            &root, package_id, fqbn
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn structured_authors_are_quality_checked_and_visible() {
        let root = temp_package("structured_authors");
        fs::write(
            root.join("library.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "id": "structured_authors",
                "name": "Structured authors",
                "version": "1.0.0",
                "description": "Exercises Arduino and PlatformIO-style person metadata.",
                "author": {
                    "name": "Ada Lovelace",
                    "email": "ada@example.invalid"
                },
                "maintainer": [
                    { "name": "Grace Hopper" },
                    { "name": "CK Maintainers" }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        let report = inspect_library_package(&root, false);
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.code == "package-author" && check.status == "passed")
        );
        assert!(
            !report
                .checks
                .iter()
                .any(|check| check.code == "missing-author")
        );

        let manifest = read_library_manifest(&root).unwrap();
        assert_eq!(manifest.author.as_deref(), Some("Ada Lovelace"));
        assert_eq!(
            manifest.maintainer.as_deref(),
            Some("Grace Hopper, CK Maintainers")
        );
        let _ = fs::remove_dir_all(root);
    }

    fn temp_package(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "ck_block_package_test_{}_{}",
            name,
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(path.join("blocks")).unwrap();
        path
    }

    fn write_quality_fixture(
        root: &Path,
        library_id: &str,
        block_manifest_id: &str,
        toolbox_type: &str,
        generator_type: &str,
    ) {
        let library = serde_json::json!({
            "id": library_id,
            "name": "Quality fixture",
            "version": "1.2.3",
            "description": "Quality fixture description",
            "author": "CK Tests",
            "architectures": ["*"]
        });
        let blocks = serde_json::json!({
            "schema_version": 1,
            "id": block_manifest_id,
            "display_name": "Quality fixture",
            "description": "Quality fixture description",
            "compatibility": { "boards": ["*"], "architectures": ["*"] },
            "entrypoints": {
                "blocks": "blocks/blocks.json",
                "generator": "blocks/ck-generator.json",
                "toolbox": "blocks/toolbox.json"
            },
            "blocks": [{
                "type": "quality_test_block",
                "display_name": "Quality test block",
                "description": "Exercises the package quality gate",
                "kind": "statement"
            }]
        });
        fs::write(
            root.join("library.json"),
            serde_json::to_vec_pretty(&library).unwrap(),
        )
        .unwrap();
        fs::write(
            root.join(BLOCK_PACKAGE_MANIFEST_FILE),
            serde_json::to_vec_pretty(&blocks).unwrap(),
        )
        .unwrap();
        fs::write(
            root.join(STANDARD_BLOCKS_PATH),
            serde_json::to_vec_pretty(&serde_json::json!([{
                "type": "quality_test_block",
                "message0": "Quality test",
                "previousStatement": null,
                "nextStatement": null,
                "colour": 160
            }]))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join(STANDARD_GENERATOR_PATH),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema": "ck-generator",
                "version": 1,
                "rules": [{
                    "type": generator_type,
                    "kind": "statement",
                    "template": "test();\n"
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join(STANDARD_TOOLBOX_PATH),
            serde_json::to_vec_pretty(&serde_json::json!({
                "kind": "categoryToolbox",
                "contents": [{
                    "kind": "category",
                    "name": "Test",
                    "contents": [{ "kind": "block", "type": toolbox_type }]
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(root.join("LICENSE"), "test license").unwrap();
    }

    #[test]
    fn resolves_valid_standard_package_and_catalog() {
        let root = temp_package("valid");
        let folder = root.file_name().unwrap().to_string_lossy().to_string();
        let manifest = serde_json::json!({
            "schema_version": 1,
            "id": folder,
            "display_name": "Test package",
            "description": "Test package description",
            "entrypoints": {
                "blocks": "blocks/blocks.json",
                "generator": "blocks/ck-generator.json",
                "toolbox": "blocks/toolbox.json"
            },
            "blocks": [{
                "type": "test_read_value",
                "display_name": "Read value",
                "description": "Returns a test value",
                "kind": "value",
                "output": "Number"
            }]
        });
        fs::write(
            root.join(BLOCK_PACKAGE_MANIFEST_FILE),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(root.join(STANDARD_BLOCKS_PATH), "[]").unwrap();
        fs::write(
            root.join(STANDARD_GENERATOR_PATH),
            r#"{"schema":"ck-generator","version":1,"rules":[]}"#,
        )
        .unwrap();
        fs::write(
            root.join(STANDARD_TOOLBOX_PATH),
            r#"{"kind":"categoryToolbox","contents":[]}"#,
        )
        .unwrap();

        let (parsed, mut diagnostics) = read_block_package_manifest(&root, &folder);
        assert!(parsed.is_some());
        assert!(!diagnostics.iter().any(|item| item.severity == "error"));
        let resolved = resolve_block_entrypoints(&root, parsed.as_ref(), &mut diagnostics);
        assert!(resolved.blocks.is_some());
        assert!(resolved.generator.is_some());
        assert!(resolved.toolbox.is_some());
        let entries = block_search_entries(parsed.as_ref());
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].block_type, "test_read_value");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_entrypoint_that_escapes_package() {
        let root = temp_package("unsafe");
        let folder = root.file_name().unwrap().to_string_lossy().to_string();
        let manifest = serde_json::json!({
            "schema_version": 1,
            "id": folder,
            "display_name": "Unsafe package",
            "description": "Unsafe package description",
            "entrypoints": {
                "blocks": "../blocks.json",
                "generator": "blocks/ck-generator.json",
                "toolbox": "blocks/toolbox.json"
            },
            "blocks": [{
                "type": "unsafe_block",
                "display_name": "Unsafe block",
                "description": "Must not load"
            }]
        });
        fs::write(
            root.join(BLOCK_PACKAGE_MANIFEST_FILE),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let (parsed, diagnostics) = read_block_package_manifest(&root, &folder);
        assert!(parsed.is_none());
        assert!(
            diagnostics
                .iter()
                .any(|item| item.code == "unsafe-entrypoint")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_legacy_javascript_block_runtime_entrypoints() {
        let root = temp_package("legacy_javascript_disabled");
        let folder = root.file_name().unwrap().to_string_lossy().to_string();
        let manifest = serde_json::json!({
            "schema_version": 1,
            "id": folder,
            "display_name": "Legacy JavaScript",
            "description": "Must never enter the main WebView",
            "entrypoints": {
                "blocks": "blocks/blocks.js",
                "generator": "blocks/generator.js",
                "toolbox": "blocks/toolbox.xml"
            },
            "blocks": [{
                "type": "legacy_attack",
                "display_name": "Legacy attack",
                "description": "Malicious test fixture"
            }]
        });
        fs::write(
            root.join(BLOCK_PACKAGE_MANIFEST_FILE),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("blocks/blocks.js"),
            "window.__ckPolluted = true; document.body.innerHTML = ''; fetch('https://attacker.invalid');",
        )
        .unwrap();
        fs::write(
            root.join("blocks/generator.js"),
            "globalThis.__ckGeneratorPolluted = true;",
        )
        .unwrap();

        let (parsed, diagnostics) = read_block_package_manifest(&root, &folder);
        assert!(parsed.is_none());
        assert!(
            diagnostics
                .iter()
                .any(|item| item.code == "legacy-javascript-disabled")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ck_generator_parser_rejects_scripts_and_only_reads_json_templates() {
        let script = "globalThis.__ckPolluted = true; fetch('https://attacker.invalid');";
        assert!(declarative_generator_types(script).is_err());

        let document = serde_json::json!({
            "schema": "ck-generator",
            "version": 1,
            "rules": [{
                "type": "safe_statement",
                "kind": "statement",
                "template": script
            }]
        });
        let types = declarative_generator_types(&document.to_string()).unwrap();
        assert_eq!(types, BTreeSet::from(["safe_statement".to_string()]));
    }

    #[test]
    fn declarative_data_rejects_remote_and_inline_resources() {
        let remote_image_block = serde_json::json!([{
            "type": "remote_image",
            "message0": "%1",
            "args0": [{
                "type": "field_image",
                "src": "https://attacker.invalid/pixel.png",
                "width": 16,
                "height": 16
            }]
        }]);
        assert!(json_block_definition_types(&remote_image_block.to_string()).is_err());

        let data_image_toolbox = serde_json::json!({
            "kind": "categoryToolbox",
            "contents": [{ "kind": "label", "src": "data:image/svg+xml,evil" }]
        });
        assert!(validate_declarative_json_resources(&data_image_toolbox).is_err());

        let root = temp_package("remote_toolbox_xml");
        let toolbox = root.join("blocks/remote-toolbox.xml");
        fs::write(
            &toolbox,
            r#"<category name="Remote"><image src="https://attacker.invalid/pixel.png" /></category>"#,
        )
        .unwrap();
        assert!(parse_toolbox_block_types(&toolbox).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn board_compatibility_supports_prefix_wildcards() {
        assert!(board_pattern_matches("arduino:avr:*", "arduino:avr:nano"));
        assert!(!board_pattern_matches(
            "arduino:avr:*",
            "esp32:esp32:esp32c5"
        ));
    }

    #[test]
    fn quality_gate_accepts_the_distributed_block_example() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../examples/importable-packages/ck_example_serial_blocks");
        let report = inspect_library_package(&root, true);
        assert_eq!(report.status, "passed", "{:#?}", report.checks);
        assert_eq!(report.error_count, 0);
        assert!(report.source_content_sha256.is_some());
    }

    #[test]
    fn quality_gate_accepts_the_distributed_v2_block_example() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../examples/importable-packages/ck_example_i2c_sensor_v2");
        let report = inspect_library_package(&root, true);
        assert_eq!(report.status, "passed", "{:#?}", report.checks);
        assert_eq!(report.error_count, 0);

        let (manifest, diagnostics) =
            read_block_package_manifest(&root, "ck_example_i2c_sensor_v2");
        assert!(
            !diagnostics.iter().any(|item| item.severity == "error"),
            "{diagnostics:#?}"
        );
        let manifest = manifest.expect("v2 manifest should be readable");
        let entries = block_search_entries(Some(&manifest));
        assert_eq!(entries[0].metadata_schema_version, 2);
        assert_eq!(entries[0].metadata_source, "v2");
        assert_eq!(entries[0].metadata_completeness.len(), 8);
        assert!(entries[0].semantics.is_some());
        assert!(entries[0].generation.is_some());
        assert!(entries[0].package_license.is_some());
    }

    fn copied_distributed_v2_fixture(name: &str) -> PathBuf {
        let root = temp_package(name);
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../examples/importable-packages/ck_example_i2c_sensor_v2");
        copy_dir_recursive(&source, &root).expect("copy distributed v2 fixture");
        root
    }

    #[test]
    fn quality_gate_accepts_a_legacy_v1_value_block_without_optional_kind_metadata() {
        let root = temp_package("v1_value_without_kind");
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../examples/importable-packages/ck_example_serial_blocks");
        copy_dir_recursive(&source, &root).expect("copy distributed v1 fixture");

        let manifest_path = root.join(BLOCK_PACKAGE_MANIFEST_FILE);
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest["blocks"][0]
            .as_object_mut()
            .unwrap()
            .remove("kind");
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let blocks_path = root.join(STANDARD_BLOCKS_PATH);
        let mut definitions: serde_json::Value =
            serde_json::from_slice(&fs::read(&blocks_path).unwrap()).unwrap();
        let definition = definitions[0].as_object_mut().unwrap();
        definition.remove("previousStatement");
        definition.remove("nextStatement");
        definition.insert("output".to_string(), serde_json::Value::Null);
        fs::write(
            &blocks_path,
            serde_json::to_vec_pretty(&definitions).unwrap(),
        )
        .unwrap();

        let generator_path = root.join(STANDARD_GENERATOR_PATH);
        let mut generator: serde_json::Value =
            serde_json::from_slice(&fs::read(&generator_path).unwrap()).unwrap();
        generator["rules"][0]["kind"] = serde_json::Value::String("expression".to_string());
        generator["rules"][0]["template"] =
            serde_json::Value::String("String({{field_json:MESSAGE}})".to_string());
        fs::write(
            &generator_path,
            serde_json::to_vec_pretty(&generator).unwrap(),
        )
        .unwrap();

        let report = inspect_library_package(&root, true);
        assert_ne!(report.status, "failed", "{:#?}", report.checks);
        assert!(
            !report.checks.iter().any(|check| {
                ["generator-kind-mismatch", "block-shape-mismatch"].contains(&check.code.as_str())
            }),
            "{:#?}",
            report.checks
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn quality_gate_rejects_generator_placeholders_missing_from_block_definition() {
        for (suffix, placeholder) in [
            ("field", "{{field:MISSING_FIELD}}"),
            ("value", "{{value:MISSING_VALUE}}"),
            ("statement", "{{statement:MISSING_STATEMENT}}"),
        ] {
            let root = copied_distributed_v2_fixture(&format!("v2_generator_{}", suffix));
            let generator_path = root.join(STANDARD_GENERATOR_PATH);
            let mut generator: serde_json::Value =
                serde_json::from_slice(&fs::read(&generator_path).unwrap()).unwrap();
            generator["rules"][0]["template"] =
                serde_json::Value::String(format!("ckExampleReadTemperature({})", placeholder));
            fs::write(
                &generator_path,
                serde_json::to_vec_pretty(&generator).unwrap(),
            )
            .unwrap();

            let report = inspect_library_package(&root, true);
            assert_eq!(report.status, "failed", "{:#?}", report.checks);
            assert!(
                report
                    .checks
                    .iter()
                    .any(|check| check.code == "generator-placeholder-mismatch"),
                "{} placeholder was not rejected: {:#?}",
                suffix,
                report.checks
            );
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn quality_gate_rejects_v2_metadata_definition_parameter_drift() {
        let root = copied_distributed_v2_fixture("v2_definition_drift");
        let blocks_path = root.join(STANDARD_BLOCKS_PATH);
        let mut definitions: serde_json::Value =
            serde_json::from_slice(&fs::read(&blocks_path).unwrap()).unwrap();
        definitions[0]["args0"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "type": "field_checkbox",
                "name": "UNDECLARED_MODE",
                "checked": false
            }));
        fs::write(
            &blocks_path,
            serde_json::to_vec_pretty(&definitions).unwrap(),
        )
        .unwrap();

        let report = inspect_library_package(&root, true);
        assert_eq!(report.status, "failed", "{:#?}", report.checks);
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.code == "block-definition-parameter-mismatch"),
            "{:#?}",
            report.checks
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn quality_gate_rejects_v2_generator_and_block_connection_shape_drift() {
        let root = copied_distributed_v2_fixture("v2_shape_drift");
        let generator_path = root.join(STANDARD_GENERATOR_PATH);
        let mut generator: serde_json::Value =
            serde_json::from_slice(&fs::read(&generator_path).unwrap()).unwrap();
        generator["rules"][0]["kind"] = serde_json::Value::String("statement".to_string());
        fs::write(
            &generator_path,
            serde_json::to_vec_pretty(&generator).unwrap(),
        )
        .unwrap();

        let blocks_path = root.join(STANDARD_BLOCKS_PATH);
        let mut definitions: serde_json::Value =
            serde_json::from_slice(&fs::read(&blocks_path).unwrap()).unwrap();
        definitions[0].as_object_mut().unwrap().remove("output");
        definitions[0]["previousStatement"] = serde_json::Value::Null;
        definitions[0]["nextStatement"] = serde_json::Value::Null;
        fs::write(
            &blocks_path,
            serde_json::to_vec_pretty(&definitions).unwrap(),
        )
        .unwrap();

        let report = inspect_library_package(&root, true);
        assert_eq!(report.status, "failed", "{:#?}", report.checks);
        for code in ["generator-kind-mismatch", "block-shape-mismatch"] {
            assert!(
                report.checks.iter().any(|check| check.code == code),
                "missing {}: {:#?}",
                code,
                report.checks
            );
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn v2_statement_uses_explicit_none_output_contract() {
        let root = temp_package("v2_statement");
        fs::write(root.join("LICENSE"), "test license").unwrap();
        let manifest = serde_json::json!({
            "schema_version": 2,
            "id": "v2_statement",
            "display_name": "V2 statement",
            "description": "V2 statement fixture",
            "license": { "spdx_id": "MIT", "file": "LICENSE" },
            "entrypoints": {
                "blocks": "blocks/blocks.json",
                "generator": "blocks/ck-generator.json",
                "toolbox": "blocks/toolbox.json"
            },
            "blocks": [{
                "type": "v2_statement_block",
                "display_name": "V2 statement",
                "description": "Emits one deterministic statement",
                "category": "Test",
                "kind": "statement",
                "semantics": {
                    "purpose": "Test statement output",
                    "behavior": "Emits one statement",
                    "side_effects": [],
                    "concepts": ["test"]
                },
                "fields": [],
                "inputs": [],
                "output": { "connection": "none", "types": [] },
                "dependencies": [],
                "hardware": { "resources": [] },
                "generation": {
                    "language": "arduino-cpp",
                    "shape": "statement",
                    "deterministic": true,
                    "emissions": [{ "section": "statement", "description": "Emits test();" }]
                },
                "constraints": [],
                "examples": [{
                    "id": "statement-example",
                    "title": "Statement example",
                    "description": "Runs the statement",
                    "expected_behavior": "The statement runs once"
                }],
                "errors": []
            }]
        });
        fs::write(
            root.join(BLOCK_PACKAGE_MANIFEST_FILE),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let (parsed, diagnostics) = read_block_package_manifest(&root, "v2_statement");
        assert!(parsed.is_some(), "{diagnostics:#?}");
        let mut report = PackageQualityReport::new("block-library");
        inspect_block_semantics(parsed.as_ref().unwrap(), &mut report);
        assert!(
            !report.checks.iter().any(|item| item.status == "error"),
            "{:#?}",
            report.checks
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn v2_manifest_rejects_missing_machine_metadata() {
        let root = temp_package("v2_incomplete");
        fs::write(root.join("LICENSE"), "test license").unwrap();
        let manifest = serde_json::json!({
            "schema_version": 2,
            "id": "v2_incomplete",
            "display_name": "Incomplete v2",
            "description": "Must be rejected",
            "license": { "spdx_id": "MIT", "file": "LICENSE" },
            "entrypoints": {
                "blocks": "blocks/blocks.json",
                "generator": "blocks/ck-generator.json",
                "toolbox": "blocks/toolbox.json"
            },
            "blocks": [{
                "type": "incomplete_v2_block",
                "display_name": "Incomplete",
                "description": "Missing all machine contracts",
                "category": "Test",
                "kind": "statement",
                "fields": [],
                "inputs": []
            }]
        });
        fs::write(
            root.join(BLOCK_PACKAGE_MANIFEST_FILE),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let (parsed, diagnostics) = read_block_package_manifest(&root, "v2_incomplete");
        assert!(parsed.is_none());
        assert!(diagnostics.iter().any(|item| {
            item.code == "invalid-v2-metadata" && item.message.contains("missing required fields")
        }));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_library_without_properties_uses_ck_compatibility_warning() {
        let root = temp_package("missing_properties");
        fs::create_dir_all(root.join("src/driver/internal")).unwrap();
        fs::write(root.join("src/Example.h"), "#pragma once\n").unwrap();
        fs::write(
            root.join("src/driver/internal/Example.c"),
            "int ck_nested_source(void) { return 1; }\n",
        )
        .unwrap();
        fs::write(root.join("LICENSE"), "test license").unwrap();
        fs::write(
            root.join("library.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "id": "missing_properties",
                "name": "Missing properties",
                "version": "1.0.0",
                "description": "Must fail Arduino discovery",
                "author": "CK Tests"
            }))
            .unwrap(),
        )
        .unwrap();
        let report = inspect_library_package(&root, false);
        assert_eq!(
            report.status, "passed_with_warnings",
            "{:#?}",
            report.checks
        );
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.code == "missing-arduino-library-properties"
                    && check.status == "warning")
        );
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.code == "ck-arduino-compatibility-adapter"
                    && check.status == "passed")
        );
        assert!(report.enforce().is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn arduino_discovery_accepts_recursive_sources_and_nested_public_headers() {
        let root = temp_package("nested_sources");
        fs::create_dir_all(root.join("src/drivers/private")).unwrap();
        fs::write(root.join("src/drivers/Sensor.h"), "#pragma once\n").unwrap();
        fs::write(
            root.join("src/drivers/private/Sensor.c"),
            "int ck_nested_sensor(void) { return 1; }\n",
        )
        .unwrap();
        fs::write(root.join("LICENSE"), "test license").unwrap();
        fs::write(
            root.join("library.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "id": "nested_sources",
                "name": "Nested sources",
                "version": "1.0.0",
                "description": "Exercises recursive Arduino sources",
                "author": "CK Tests",
                "includes": ["drivers/Sensor.h"]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("library.properties"),
            "name=Nested sources\nversion=1.0.0\narchitectures=*\nincludes=drivers/Sensor.h\n",
        )
        .unwrap();

        let report = inspect_library_package(&root, false);
        assert_eq!(report.status, "passed", "{:#?}", report.checks);
        assert!(report.checks.iter().any(|check| {
            check.code == "arduino-library-discovery" && check.status == "passed"
        }));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn arduino_discovery_rejects_unsafe_or_non_header_includes() {
        for (suffix, include) in [
            ("parent", "../Sensor.h"),
            ("absolute", "C:/outside/Sensor.h"),
            ("source", "drivers/Sensor.c"),
        ] {
            let root = temp_package(&format!("invalid_include_{}", suffix));
            fs::create_dir_all(root.join("src/drivers")).unwrap();
            fs::write(
                root.join("src/drivers/Sensor.c"),
                "int sensor(void) { return 1; }\n",
            )
            .unwrap();
            fs::write(root.join("LICENSE"), "test license").unwrap();
            fs::write(
                root.join("library.json"),
                serde_json::to_vec_pretty(&serde_json::json!({
                    "id": format!("invalid_include_{}", suffix),
                    "name": "Invalid include",
                    "version": "1.0.0",
                    "description": "Must reject unsafe or non-header include paths",
                    "author": "CK Tests"
                }))
                .unwrap(),
            )
            .unwrap();
            fs::write(
                root.join("library.properties"),
                format!(
                    "name=Invalid include\nversion=1.0.0\narchitectures=*\nincludes={}\n",
                    include
                ),
            )
            .unwrap();

            let report = inspect_library_package(&root, false);
            assert_eq!(report.status, "failed", "{:#?}", report.checks);
            assert!(report.checks.iter().any(|check| {
                check.code == "invalid-arduino-public-header" && check.status == "error"
            }));
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn arduino_discovery_rejects_public_header_manifest_mismatch() {
        let root = temp_package("include_mismatch");
        fs::create_dir_all(root.join("src/drivers")).unwrap();
        fs::write(root.join("src/Public.h"), "#pragma once\n").unwrap();
        fs::write(root.join("src/drivers/Sensor.h"), "#pragma once\n").unwrap();
        fs::write(
            root.join("src/drivers/Sensor.c"),
            "int sensor(void) { return 1; }\n",
        )
        .unwrap();
        fs::write(root.join("LICENSE"), "test license").unwrap();
        fs::write(
            root.join("library.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "id": "include_mismatch",
                "name": "Include mismatch",
                "version": "1.0.0",
                "description": "Must reject cross-manifest include drift",
                "author": "CK Tests",
                "includes": ["Public.h"]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("library.properties"),
            "name=Include mismatch\nversion=1.0.0\narchitectures=*\nincludes=drivers/Sensor.h\n",
        )
        .unwrap();

        let report = inspect_library_package(&root, false);
        assert_eq!(report.status, "failed", "{:#?}", report.checks);
        assert!(report.checks.iter().any(|check| {
            check.code == "arduino-public-header-mismatch" && check.status == "error"
        }));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn quality_gate_rejects_cross_file_contract_mismatches() {
        let root = temp_package("contract_mismatch");
        write_quality_fixture(
            &root,
            "quality_test",
            "different_id",
            "other_toolbox_block",
            "other_generator_block",
        );

        let report = inspect_library_package(&root, true);
        assert_eq!(report.status, "failed");
        for expected in [
            "id-mismatch",
            "toolbox-missing-blocks",
            "toolbox-undeclared-blocks",
            "missing-generator-registration",
        ] {
            assert!(
                report.checks.iter().any(|check| check.code == expected),
                "missing check {expected}: {:#?}",
                report.checks
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn quality_gate_accepts_a_consistent_fixture() {
        let root = temp_package("consistent");
        write_quality_fixture(
            &root,
            "quality_test",
            "quality_test",
            "quality_test_block",
            "quality_test_block",
        );

        let report = inspect_library_package(&root, true);
        assert_eq!(report.status, "passed", "{:#?}", report.checks);
        assert!(report.enforce().is_ok());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn managed_declarative_package_bootstraps_once_and_never_hides_tampering() {
        let root = temp_package("managed_quality_bootstrap");
        write_quality_fixture(
            &root,
            "quality_test",
            "quality_test",
            "quality_test_block",
            "quality_test_block",
        );
        let mut diagnostics = Vec::new();
        let first = read_or_bootstrap_managed_declarative_quality_report(
            &root,
            "quality_test",
            true,
            false,
            &mut diagnostics,
        )
        .expect("managed package should receive a first-scan report");
        assert!(runtime_quality_report_is_trusted_for_package(
            Some(&first),
            "block-library",
            "quality_test"
        ));
        assert!(
            root.join(crate::package_quality::QUALITY_REPORT_FILE)
                .is_file()
        );
        assert!(
            diagnostics
                .iter()
                .any(|item| item.code == "managed-quality-bootstrapped")
        );

        fs::write(
            root.join(STANDARD_BLOCKS_PATH),
            "[{\"type\":\"quality_test_block\",\"message0\":\"tampered\"}]",
        )
        .unwrap();
        let mut second_diagnostics = Vec::new();
        let changed = read_or_bootstrap_managed_declarative_quality_report(
            &root,
            "quality_test",
            true,
            false,
            &mut second_diagnostics,
        )
        .expect("the stale report should remain visible");
        assert!(!runtime_quality_report_is_trusted_for_package(
            Some(&changed),
            "block-library",
            "quality_test"
        ));
        assert!(
            !second_diagnostics
                .iter()
                .any(|item| item.code == "managed-quality-bootstrapped")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn transactional_library_replace_keeps_only_the_staged_version() {
        let root =
            std::env::temp_dir().join(format!("ck_library_commit_test_{}", uuid::Uuid::new_v4()));
        let target = root.join("installed/example");
        let staged = root.join("installed/.ck-staging-example");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&staged).unwrap();
        fs::write(target.join("version.txt"), "old").unwrap();
        fs::write(staged.join("version.txt"), "new").unwrap();

        replace_directory_transactionally(&staged, &target).unwrap();
        assert_eq!(
            fs::read_to_string(target.join("version.txt")).unwrap(),
            "new"
        );
        assert!(!staged.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cloud_library_subdir_must_be_a_safe_relative_path() {
        assert_eq!(
            normalized_package_subdir("packages/sensors").unwrap(),
            "packages/sensors"
        );
        for invalid in [
            "",
            ".",
            "../outside",
            "packages/../../outside",
            "C:\\outside",
        ] {
            assert!(
                normalized_package_subdir(invalid).is_err(),
                "accepted {invalid}"
            );
        }
    }
}
