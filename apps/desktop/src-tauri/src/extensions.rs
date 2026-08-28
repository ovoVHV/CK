use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
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

fn read_text_lossy(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read {:?}: {}", path, e))?;
    let text = match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).to_string(),
    };
    Ok(text.trim_start_matches('\u{FEFF}').to_string())
}

fn sorted_read_dir(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = match fs::read_dir(dir) {
        Ok(entries) => entries.filter_map(Result::ok).map(|e| e.path()).collect(),
        Err(_) => Vec::new(),
    };
    out.sort_by(|a, b| {
        let a_name = a
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let b_name = b
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        a_name.cmp(&b_name)
    });
    out
}

fn find_legacy_blocks_js(root: &Path) -> Option<PathBuf> {
    let direct_candidates = [
        root.join("blocks.js"),
        root.join("block.js"),
        root.join("block").join("blocks.js"),
        root.join("block").join("block.js"),
    ];
    for candidate in direct_candidates {
        if candidate.exists() && candidate.is_file() {
            return Some(candidate);
        }
    }

    for p in sorted_read_dir(root) {
        if p.is_file()
            && p.extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("js"))
                .unwrap_or(false)
        {
            return Some(p);
        }
    }

    None
}

fn find_legacy_generator_js(root: &Path) -> Option<PathBuf> {
    let direct_candidates = [
        root.join("generator.js"),
        root.join("generator").join("generator.js"),
    ];
    for candidate in direct_candidates {
        if candidate.exists() && candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn is_xml_toolbox_like(path: &Path) -> bool {
    if !(path.exists() && path.is_file()) {
        return false;
    }
    let ext_ok = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("xml"))
        .unwrap_or(false);
    if !ext_ok {
        return false;
    }

    match read_text_lossy(path) {
        Ok(content) => {
            let lower = content.to_ascii_lowercase();
            lower.contains("<category") || lower.contains("<xml")
        }
        Err(_) => false,
    }
}

fn find_legacy_toolbox_xml(root: &Path) -> Option<PathBuf> {
    let direct_candidates = [
        root.join("toolbox.xml"),
        root.join("blocks").join("toolbox.xml"),
    ];
    for candidate in direct_candidates {
        if is_xml_toolbox_like(&candidate) {
            return Some(candidate);
        }
    }

    for p in sorted_read_dir(root) {
        if is_xml_toolbox_like(&p) {
            return Some(p);
        }
    }

    None
}

fn is_legacy_extension_layout(root: &Path) -> bool {
    let has_blocks = find_legacy_blocks_js(root).is_some();
    let has_toolbox = find_legacy_toolbox_xml(root).is_some();
    has_blocks && has_toolbox
}

fn is_extension_folder_candidate(root: &Path) -> bool {
    if !(root.exists() && root.is_dir()) {
        return false;
    }
    let modern = root.join("block.json").exists() && root.join("toolbox.json").exists();
    modern || is_legacy_extension_layout(root)
}

fn is_standard_block_package_candidate(root: &Path) -> bool {
    root.is_dir() && root.join("library.json").is_file() && root.join("ck-blocks.json").is_file()
}

fn normalize_legacy_extension_layout(root: &Path) -> Result<(), String> {
    let blocks_src = find_legacy_blocks_js(root)
        .ok_or_else(|| "Legacy extension missing blocks definition (.js) file".to_string())?;
    let toolbox_src = find_legacy_toolbox_xml(root)
        .ok_or_else(|| "Legacy extension missing toolbox XML".to_string())?;

    let blocks_text = read_text_lossy(&blocks_src)?;
    fs::write(
        root.join("blocks.js"),
        format!(
            "// Original: {:?}\n{}\n",
            blocks_src.file_name().unwrap_or_default(),
            blocks_text
        ),
    )
    .map_err(|e| format!("Failed to normalize blocks.js: {}", e))?;

    let toolbox_text = read_text_lossy(&toolbox_src)?;
    fs::write(root.join("toolbox.xml"), format!("{}\n", toolbox_text))
        .map_err(|e| format!("Failed to normalize toolbox.xml: {}", e))?;

    if let Some(generator_src) = find_legacy_generator_js(root) {
        let generator_text = read_text_lossy(&generator_src)?;
        fs::write(
            root.join("generator.js"),
            format!(
                "// Original: {:?}\n{}\n",
                generator_src.file_name().unwrap_or_default(),
                generator_text
            ),
        )
        .map_err(|e| format!("Failed to normalize generator.js: {}", e))?;
    }

    Ok(())
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ExtensionTranspileSummary {
    placeholder_replacements: usize,
    dropdown_options_normalized: usize,
    unresolved_placeholders: BTreeSet<String>,
    generator_rewrites: usize,
    generator_prelude_injected: bool,
    package_tagged: bool,
    notes: Vec<String>,
}

fn sanitize_extension_id(raw: &str) -> String {
    let sanitized = raw
        .replace('@', "")
        .replace('/', "-")
        .replace('\\', "-")
        .replace(' ', "-");
    if sanitized.trim().is_empty() {
        "UnknownExtension".to_string()
    } else {
        sanitized
    }
}

fn is_supported_extension_archive(path: &Path) -> bool {
    path.extension()
        .and_then(|v| v.to_str())
        .map(|v| v.eq_ignore_ascii_case("zip"))
        .unwrap_or(false)
}

fn write_json_file(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, format!("{}\n", serialized)).map_err(|e| e.to_string())
}

fn move_extracted_path(src: &Path, dst: &Path) -> Result<(), String> {
    if src.is_dir() {
        return crate::options::dir::move_dir(src, dst).map_err(|e| {
            format!(
                "Failed to move extracted directory from {:?} to {:?}: {}",
                src, dst, e
            )
        });
    }

    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to prepare destination folder {:?}: {}", parent, e))?;
    }

    if dst.exists() {
        if dst.is_file() {
            std::fs::remove_file(dst).map_err(|e| {
                format!(
                    "Failed to remove existing destination file {:?}: {}",
                    dst, e
                )
            })?;
        } else {
            return Err(format!(
                "Failed to move extracted file {:?}: destination {:?} is a directory",
                src, dst
            ));
        }
    }

    match std::fs::rename(src, dst) {
        Ok(_) => Ok(()),
        Err(_) => {
            std::fs::copy(src, dst).map_err(|e| {
                format!(
                    "Failed to copy extracted file from {:?} to {:?}: {}",
                    src, dst, e
                )
            })?;
            std::fs::remove_file(src).map_err(|e| {
                format!("Failed to remove temporary extracted file {:?}: {}", src, e)
            })?;
            Ok(())
        }
    }
}

fn flatten_extracted_src_layout(target_lib_folder: &Path) -> Result<(), String> {
    // Some source archives use src/src/<real-libs>, and naive flattening can accidentally
    // delete extracted content. Flatten in a safe loop.
    let mut guard = 0usize;
    while guard < 6 {
        guard += 1;
        let src_dir = target_lib_folder.join("src");
        if !(src_dir.exists() && src_dir.is_dir()) {
            break;
        }

        let entries = std::fs::read_dir(&src_dir)
            .map_err(|e| format!("Failed to read nested src folder: {}", e))?;
        let mut has_entries = false;

        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            has_entries = true;
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();

            if name.eq_ignore_ascii_case("src") && path.is_dir() {
                for child in std::fs::read_dir(&path)
                    .map_err(|e| format!("Failed to read double-nested src folder: {}", e))?
                {
                    let child = child.map_err(|e| e.to_string())?;
                    let dst = target_lib_folder.join(child.file_name());
                    move_extracted_path(&child.path(), &dst)?;
                }
                let _ = std::fs::remove_dir_all(&path);
                continue;
            }

            let dst = target_lib_folder.join(&name);
            move_extracted_path(&path, &dst)?;
        }

        if !has_entries {
            let _ = std::fs::remove_dir_all(&src_dir);
            break;
        }
        let _ = std::fs::remove_dir_all(&src_dir);
    }

    Ok(())
}

fn transpile_extension_in_place(
    _target_ext_folder: &Path,
    _ext_id: &str,
) -> ExtensionTranspileSummary {
    ExtensionTranspileSummary::default()
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionHookCleanupSummary {
    pub removed_extensions: usize,
    pub removed_mutators: usize,
    pub unresolved_extensions: Vec<String>,
    pub unresolved_mutators: Vec<String>,
    pub notes: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionAiSummary {
    pub attempted: bool,
    pub applied: bool,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub diagnosis: Option<String>,
    pub error: Option<String>,
    pub generator_replacements_applied: usize,
    pub drop_extensions_applied: usize,
    pub drop_mutators_applied: usize,
    pub notes: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionRepairResult {
    pub extension_id: String,
    pub extension_dir: String,
    pub mode: String,
    pub transpile: ExtensionTranspileSummary,
    pub hook_cleanup: ExtensionHookCleanupSummary,
    pub ai: ExtensionAiSummary,
    pub notes: Vec<String>,
}

#[derive(Debug, Default)]
struct BlockHookUsage {
    extensions: BTreeSet<String>,
    mutators: BTreeSet<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AiGeneratorReplacement {
    from: String,
    to: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AiRepairPlan {
    #[serde(default)]
    diagnosis: Option<String>,
    #[serde(default, alias = "drop_block_extensions")]
    drop_block_extensions: Vec<String>,
    #[serde(default, alias = "drop_block_mutators")]
    drop_block_mutators: Vec<String>,
    #[serde(default, alias = "generator_replacements")]
    generator_replacements: Vec<AiGeneratorReplacement>,
}

fn collect_block_hook_usage(value: &serde_json::Value, usage: &mut BlockHookUsage) {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(extensions) = map.get("extensions").and_then(|v| v.as_array()) {
                for item in extensions {
                    if let Some(name) = item.as_str() {
                        let clean = name.trim();
                        if !clean.is_empty() {
                            usage.extensions.insert(clean.to_string());
                        }
                    }
                }
            }
            if let Some(name) = map.get("extension").and_then(|v| v.as_str()) {
                let clean = name.trim();
                if !clean.is_empty() {
                    usage.extensions.insert(clean.to_string());
                }
            }
            if let Some(name) = map.get("mutator").and_then(|v| v.as_str()) {
                let clean = name.trim();
                if !clean.is_empty() {
                    usage.mutators.insert(clean.to_string());
                }
            }
            for child in map.values() {
                collect_block_hook_usage(child, usage);
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                collect_block_hook_usage(item, usage);
            }
        }
        _ => {}
    }
}

fn collect_registered_hooks(js: &str) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut extensions = BTreeSet::new();
    let mut mutators = BTreeSet::new();

    let ext_patterns = [
        r#"(?i)Extensions\.register\s*\(\s*['"]([^'"]+)['"]"#,
        r#"(?i)registerExtension\s*\(\s*['"]([^'"]+)['"]"#,
    ];
    let mut_patterns = [
        r#"(?i)Extensions\.registerMutator\s*\(\s*['"]([^'"]+)['"]"#,
        r#"(?i)registerMutator\s*\(\s*['"]([^'"]+)['"]"#,
    ];

    for pat in ext_patterns {
        if let Ok(re) = Regex::new(pat) {
            for cap in re.captures_iter(js) {
                if let Some(m) = cap.get(1) {
                    let name = m.as_str().trim();
                    if !name.is_empty() {
                        extensions.insert(name.to_string());
                    }
                }
            }
        }
    }

    for pat in mut_patterns {
        if let Ok(re) = Regex::new(pat) {
            for cap in re.captures_iter(js) {
                if let Some(m) = cap.get(1) {
                    let name = m.as_str().trim();
                    if !name.is_empty() {
                        mutators.insert(name.to_string());
                    }
                }
            }
        }
    }

    (extensions, mutators)
}

fn prune_block_hook_refs(
    value: &mut serde_json::Value,
    drop_extensions: &BTreeSet<String>,
    drop_mutators: &BTreeSet<String>,
    summary: &mut ExtensionHookCleanupSummary,
) {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(extensions) = map.get_mut("extensions").and_then(|v| v.as_array_mut()) {
                let before = extensions.len();
                extensions.retain(|item| {
                    if let Some(name) = item.as_str() {
                        let clean = name.trim();
                        return !drop_extensions.contains(clean);
                    }
                    true
                });
                let removed = before.saturating_sub(extensions.len());
                if removed > 0 {
                    summary.removed_extensions += removed;
                }
                if extensions.is_empty() {
                    map.remove("extensions");
                }
            }

            let extension_drop = map
                .get("extension")
                .and_then(|v| v.as_str())
                .map(|s| drop_extensions.contains(s.trim()))
                .unwrap_or(false);
            if extension_drop {
                map.remove("extension");
                summary.removed_extensions += 1;
            }

            let mutator_drop = map
                .get("mutator")
                .and_then(|v| v.as_str())
                .map(|s| drop_mutators.contains(s.trim()))
                .unwrap_or(false);
            if mutator_drop {
                map.remove("mutator");
                summary.removed_mutators += 1;
            }

            for child in map.values_mut() {
                prune_block_hook_refs(child, drop_extensions, drop_mutators, summary);
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr.iter_mut() {
                prune_block_hook_refs(item, drop_extensions, drop_mutators, summary);
            }
        }
        _ => {}
    }
}

fn cleanup_unresolved_block_hooks(target_ext_folder: &Path) -> ExtensionHookCleanupSummary {
    let mut summary = ExtensionHookCleanupSummary::default();
    let block_path = target_ext_folder.join("block.json");
    if !block_path.exists() {
        summary
            .notes
            .push("block.json not found, skip hook cleanup".to_string());
        return summary;
    }

    let block_raw = match fs::read_to_string(&block_path) {
        Ok(v) => v,
        Err(e) => {
            summary
                .notes
                .push(format!("Failed to read block.json: {}", e));
            return summary;
        }
    };
    let mut block_json =
        match serde_json::from_str::<serde_json::Value>(block_raw.trim_start_matches('\u{FEFF}')) {
            Ok(v) => v,
            Err(e) => {
                summary.notes.push(format!(
                    "Failed to parse block.json for hook cleanup: {}",
                    e
                ));
                return summary;
            }
        };

    let mut usage = BlockHookUsage::default();
    collect_block_hook_usage(&block_json, &mut usage);
    if usage.extensions.is_empty() && usage.mutators.is_empty() {
        return summary;
    }

    let mut registered_extensions = BTreeSet::new();
    let mut registered_mutators = BTreeSet::new();
    let generator_path = target_ext_folder.join("generator.js");
    if generator_path.exists() {
        match fs::read_to_string(&generator_path) {
            Ok(js) => {
                let (exts, muts) = collect_registered_hooks(js.trim_start_matches('\u{FEFF}'));
                registered_extensions = exts;
                registered_mutators = muts;
            }
            Err(e) => summary.notes.push(format!(
                "Failed to read generator.js for hook cleanup: {}",
                e
            )),
        }
    } else {
        summary
            .notes
            .push("generator.js not found, unresolved hooks may be removed".to_string());
    }

    let unresolved_extensions: BTreeSet<String> = usage
        .extensions
        .difference(&registered_extensions)
        .cloned()
        .collect();
    let unresolved_mutators: BTreeSet<String> = usage
        .mutators
        .difference(&registered_mutators)
        .cloned()
        .collect();

    if unresolved_extensions.is_empty() && unresolved_mutators.is_empty() {
        return summary;
    }

    summary.unresolved_extensions = unresolved_extensions.iter().cloned().collect();
    summary.unresolved_mutators = unresolved_mutators.iter().cloned().collect();

    prune_block_hook_refs(
        &mut block_json,
        &unresolved_extensions,
        &unresolved_mutators,
        &mut summary,
    );

    if (summary.removed_extensions + summary.removed_mutators) > 0 {
        if let Err(e) = write_json_file(&block_path, &block_json) {
            summary.notes.push(format!(
                "Failed to write block.json after hook cleanup: {}",
                e
            ));
        }
    }

    summary
}

fn infer_ai_provider_from_base_url(base_url: &str) -> Option<String> {
    let lower = base_url.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return None;
    }
    if lower.contains("deepseek") {
        return Some("deepseek".to_string());
    }
    if lower.contains("minimax") {
        return Some("minimax".to_string());
    }
    if lower.contains("bigmodel") || lower.contains("zhipu") || lower.contains("glm") {
        return Some("glm".to_string());
    }
    None
}

fn normalize_ai_provider(requested: Option<String>, base_url: Option<&str>) -> String {
    let provider = requested.unwrap_or_default().trim().to_ascii_lowercase();
    if provider == "deepseek" || provider == "minimax" || provider == "glm" {
        return provider;
    }
    if let Some(inferred) = base_url.and_then(infer_ai_provider_from_base_url) {
        return inferred;
    }
    "deepseek".to_string()
}

fn provider_default_base_url(provider: &str) -> &'static str {
    match provider {
        "deepseek" => "https://api.deepseek.com/v1",
        "minimax" => "https://api.minimax.chat/v1",
        _ => "https://open.bigmodel.cn/api/paas/v4",
    }
}

fn provider_default_model(provider: &str) -> &'static str {
    match provider {
        "deepseek" => "deepseek-chat",
        "minimax" => "MiniMax-Text-01",
        _ => "glm-4-flash",
    }
}

fn build_chat_completions_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return "https://api.deepseek.com/v1/chat/completions".to_string();
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("/chat/completions")
        || lower.ends_with("/completions")
        || lower.contains("chatcompletion_v2")
    {
        return trimmed.to_string();
    }
    if lower.ends_with("/v1") || lower.ends_with("/v4") {
        return format!("{}/chat/completions", trimmed);
    }
    format!("{}/chat/completions", trimmed)
}

fn resolve_ai_api_key(provider: &str, request_key: Option<String>) -> Option<String> {
    let requested = request_key.unwrap_or_default().trim().to_string();
    if !requested.is_empty() {
        return Some(requested);
    }

    let provider_envs: &[&str] = match provider {
        "deepseek" => &["DEEPSEEK_API_KEY", "CK_DEEPSEEK_API_KEY"],
        "minimax" => &["MINIMAX_API_KEY", "CK_MINIMAX_API_KEY"],
        _ => &["GLM_API_KEY", "CK_GLM_API_KEY"],
    };
    let generic_envs: &[&str] = &[
        "LLM_API_KEY",
        "CK_LLM_API_KEY",
        "OPENAI_API_KEY",
        "CK_OPENAI_API_KEY",
    ];

    for key in provider_envs.iter().chain(generic_envs.iter()) {
        if let Ok(v) = std::env::var(key) {
            let clean = v.trim().to_string();
            if !clean.is_empty() {
                return Some(clean);
            }
        }
    }
    None
}

fn trim_for_ai(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out = String::new();
    for ch in text.chars().take(max_chars) {
        out.push(ch);
    }
    out.push_str("\n...(truncated)...");
    out
}

fn ai_stream_resource_error(detail: impl std::fmt::Display) -> String {
    format!(
        "AI repair response was stopped by CK's memory safety gate: {detail}. Reduce the model max output tokens or switch to a compliant endpoint, then retry; no truncated repair plan was applied"
    )
}

fn extract_json_object_from_text(text: &str) -> Option<String> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(text[start..=end].to_string())
}

fn extract_chat_content_value(message_value: &serde_json::Value) -> String {
    if let Some(content) = message_value.get("content") {
        if let Some(s) = content.as_str() {
            return s.trim().to_string();
        }
        if let Some(arr) = content.as_array() {
            let mut out = String::new();
            for part in arr {
                if let Some(s) = part.as_str() {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(s.trim());
                    continue;
                }
                let part_type = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if part_type == "text" {
                    if let Some(s) = part.get("text").and_then(|v| v.as_str()) {
                        if !out.is_empty() {
                            out.push('\n');
                        }
                        out.push_str(s.trim());
                    }
                }
            }
            if !out.is_empty() {
                return out;
            }
        }
    }
    String::new()
}

fn collect_extension_snippets(target_ext_folder: &Path) -> (String, String, String) {
    let block = read_text_lossy(&target_ext_folder.join("block.json"))
        .map(|v| trim_for_ai(&v, 12_000))
        .unwrap_or_default();
    let toolbox = read_text_lossy(&target_ext_folder.join("toolbox.json"))
        .map(|v| trim_for_ai(&v, 8_000))
        .unwrap_or_default();
    let generator = read_text_lossy(&target_ext_folder.join("generator.js"))
        .map(|v| trim_for_ai(&v, 12_000))
        .unwrap_or_default();
    (block, toolbox, generator)
}

fn apply_ai_drop_lists(
    target_ext_folder: &Path,
    drop_extensions: &BTreeSet<String>,
    drop_mutators: &BTreeSet<String>,
) -> Result<(usize, usize), String> {
    if drop_extensions.is_empty() && drop_mutators.is_empty() {
        return Ok((0, 0));
    }
    let block_path = target_ext_folder.join("block.json");
    if !block_path.exists() {
        return Ok((0, 0));
    }
    let raw =
        fs::read_to_string(&block_path).map_err(|e| format!("Failed to read block.json: {}", e))?;
    let mut value = serde_json::from_str::<serde_json::Value>(raw.trim_start_matches('\u{FEFF}'))
        .map_err(|e| format!("Failed to parse block.json: {}", e))?;

    let mut summary = ExtensionHookCleanupSummary::default();
    prune_block_hook_refs(&mut value, drop_extensions, drop_mutators, &mut summary);
    if summary.removed_extensions + summary.removed_mutators > 0 {
        write_json_file(&block_path, &value)?;
    }
    Ok((summary.removed_extensions, summary.removed_mutators))
}

fn apply_ai_generator_replacements(
    target_ext_folder: &Path,
    replacements: &[AiGeneratorReplacement],
) -> Result<usize, String> {
    if replacements.is_empty() {
        return Ok(0);
    }

    let generator_path = target_ext_folder.join("generator.js");
    if !generator_path.exists() {
        return Ok(0);
    }
    let mut content = fs::read_to_string(&generator_path)
        .map_err(|e| format!("Failed to read generator.js: {}", e))?;

    let mut changes = 0usize;
    for rep in replacements.iter().take(10) {
        let from = rep.from.trim();
        if from.len() < 2 || from.len() > 240 {
            continue;
        }
        let to = rep.to.as_str();
        if to.len() > 4_000 {
            continue;
        }
        let cnt = content.matches(from).count();
        if cnt == 0 {
            continue;
        }
        content = content.replace(from, to);
        changes += cnt;
    }

    if changes > 0 {
        fs::write(&generator_path, content)
            .map_err(|e| format!("Failed to write generator.js: {}", e))?;
    }

    Ok(changes)
}

async fn run_ai_repair(
    app: &tauri::AppHandle,
    ext_id: &str,
    target_ext_folder: &Path,
    provider: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    user_prompt_override: Option<String>,
) -> ExtensionAiSummary {
    let mut out = ExtensionAiSummary {
        attempted: true,
        ..ExtensionAiSummary::default()
    };

    let provider_id = normalize_ai_provider(provider, base_url.as_deref());
    out.provider = Some(provider_id.clone());

    let base = base_url.unwrap_or_default().trim().to_string();
    let resolved_base = if base.is_empty() {
        provider_default_base_url(&provider_id).to_string()
    } else {
        base
    };

    let model_resolved = model.unwrap_or_default().trim().to_string();
    let resolved_model = if model_resolved.is_empty() {
        provider_default_model(&provider_id).to_string()
    } else {
        model_resolved
    };
    out.model = Some(resolved_model.clone());

    let key = match resolve_ai_api_key(&provider_id, api_key) {
        Some(v) => v,
        None => {
            out.error = Some(
                "No API key configured for online repair (supports GLM/DeepSeek/MiniMax env or UI key).".to_string(),
            );
            return out;
        }
    };

    let (block_snippet, toolbox_snippet, generator_snippet) =
        collect_extension_snippets(target_ext_folder);
    let system_prompt = "You repair Blockly extension import issues. Return STRICT JSON only. \
Fields: diagnosis (string), dropBlockExtensions (string[]), dropBlockMutators (string[]), \
generatorReplacements ([{from:string,to:string}]). \
Rules: keep list small, avoid risky rewrites, only include names/patterns seen in input.";

    let base_user_prompt = if let Some(up) = user_prompt_override.filter(|s| !s.trim().is_empty()) {
        format!("User instructions: {}\n\n", up)
    } else {
        String::new()
    };

    let user_prompt = format!(
        "{}extensionId: {}\n\
Please propose minimal safe repair actions for this extension.\n\
--- block.json ---\n{}\n\
--- toolbox.json ---\n{}\n\
--- generator.js ---\n{}\n",
        base_user_prompt, ext_id, block_snippet, toolbox_snippet, generator_snippet
    );

    let completions_url = build_chat_completions_url(&resolved_base);
    let body = serde_json::json!({
        "model": resolved_model,
        "stream": true,
        "temperature": 0.1,
        "max_tokens": 1400,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": trim_for_ai(&user_prompt, 24_000) }
        ]
    });

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            out.error = Some(format!("Failed to create AI HTTP client: {}", e));
            return out;
        }
    };

    let response = match client
        .post(&completions_url)
        .header("Authorization", format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            out.error = Some(format!("AI request failed: {}", e));
            return out;
        }
    };

    let status = response.status();
    if !status.is_success() {
        let raw = match crate::bounded_sse::read_response_text_bounded(
            response,
            crate::bounded_sse::ERROR_RESPONSE_MAX_BYTES,
            "AI repair error response",
        )
        .await
        {
            Ok(raw) => raw,
            Err(error) => {
                out.error = Some(ai_stream_resource_error(error));
                return out;
            }
        };
        out.error = Some(format!(
            "AI endpoint HTTP {}: {}",
            status.as_u16(),
            trim_for_ai(&raw, 400)
        ));
        return out;
    }

    use futures_util::StreamExt;
    use tauri::Emitter;

    let mut stream = response.bytes_stream();
    let mut full_content = String::new();
    let mut chunk_buffer = String::new();
    let mut stream_budget =
        crate::bounded_sse::SseBudget::new(crate::bounded_sse::EXTENSION_REPAIR_SSE_LIMITS);

    #[derive(Serialize, Clone)]
    struct AiChunkPayload {
        ext_id: String,
        chunk: String,
    }

    while let Some(item) = stream.next().await {
        let bytes = match item {
            Ok(bytes) => bytes,
            Err(error) => {
                out.error = Some(format!("AI repair stream read failed: {error}"));
                return out;
            }
        };
        if let Err(error) = stream_budget.observe_chunk(bytes.len()) {
            out.error = Some(ai_stream_resource_error(error));
            return out;
        }
        if let Err(error) =
            stream_budget.append_pending_text(&mut chunk_buffer, &String::from_utf8_lossy(&bytes))
        {
            out.error = Some(ai_stream_resource_error(error));
            return out;
        }

        while let Some(idx) = chunk_buffer.find('\n') {
            let line = chunk_buffer[..idx].to_string();
            chunk_buffer = chunk_buffer[idx + 1..].to_string();
            let line_trim = line.trim();

            if line_trim.starts_with("data:") {
                let data = line_trim["data:".len()..].trim();
                if data == "[DONE]" {
                    continue;
                }
                if let Err(error) = stream_budget.record_event() {
                    out.error = Some(ai_stream_resource_error(error));
                    return out;
                }
                if let Ok(parsed_chunk) = serde_json::from_str::<serde_json::Value>(data) {
                    let content_part = parsed_chunk
                        .get("choices")
                        .and_then(|v| v.as_array())
                        .and_then(|arr| arr.first())
                        .and_then(|c| c.get("delta"))
                        .and_then(|d| d.get("content"))
                        .and_then(|c| c.as_str())
                        .unwrap_or("");

                    if !content_part.is_empty() {
                        if let Err(error) = stream_budget.append_generated(
                            &mut full_content,
                            content_part,
                            "AI repair content",
                        ) {
                            out.error = Some(ai_stream_resource_error(error));
                            return out;
                        }
                        let _ = app.emit(
                            "ai-repair-chunk",
                            AiChunkPayload {
                                ext_id: ext_id.to_string(),
                                chunk: content_part.to_string(),
                            },
                        );
                    }
                }
            }
        }
    }

    let content = full_content.trim().to_string();
    if content.is_empty() {
        out.error = Some("AI returned empty content".to_string());
        return out;
    }

    let plan_text = match extract_json_object_from_text(&content) {
        Some(v) => v,
        None => {
            out.diagnosis = Some(trim_for_ai(&content, 600));
            out.error = Some("AI output is not JSON; skipped AI apply".to_string());
            return out;
        }
    };

    let plan: AiRepairPlan = match serde_json::from_str(&plan_text) {
        Ok(v) => v,
        Err(e) => {
            out.diagnosis = Some(trim_for_ai(&content, 600));
            out.error = Some(format!("AI plan JSON parse failed: {}", e));
            return out;
        }
    };

    out.diagnosis = plan
        .diagnosis
        .map(|v| trim_for_ai(v.trim(), 1_200))
        .filter(|v| !v.is_empty());

    match apply_ai_generator_replacements(target_ext_folder, &plan.generator_replacements) {
        Ok(changes) => out.generator_replacements_applied = changes,
        Err(e) => out.notes.push(e),
    }

    let drop_extensions: BTreeSet<String> = plan
        .drop_block_extensions
        .into_iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect();
    let drop_mutators: BTreeSet<String> = plan
        .drop_block_mutators
        .into_iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect();

    match apply_ai_drop_lists(target_ext_folder, &drop_extensions, &drop_mutators) {
        Ok((dropped_ext, dropped_mut)) => {
            out.drop_extensions_applied = dropped_ext;
            out.drop_mutators_applied = dropped_mut;
        }
        Err(e) => out.notes.push(e),
    }

    out.applied = out.generator_replacements_applied
        + out.drop_extensions_applied
        + out.drop_mutators_applied
        > 0;
    out
}

#[tauri::command]
pub async fn repair_extension_import(
    app: tauri::AppHandle,
    ext_id: String,
    mode: Option<String>,
    provider: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    user_prompt: Option<String>,
) -> Result<ExtensionRepairResult, String> {
    let mode = mode
        .unwrap_or_else(|| "hybrid".to_string())
        .trim()
        .to_ascii_lowercase();
    if mode != "offline" && mode != "online" && mode != "hybrid" {
        return Err("Invalid mode. Use offline / online / hybrid.".to_string());
    }

    let ext_root = super::ck_root_dir().join("extensions");
    let normalized_ext_id = sanitize_extension_id(&ext_id);

    let mut target_ext_folder = ext_root.join(&normalized_ext_id);
    if !target_ext_folder.exists() {
        let raw_candidate = ext_root.join(ext_id.trim());
        if raw_candidate.exists() {
            target_ext_folder = raw_candidate;
        }
    }
    if !(target_ext_folder.exists() && target_ext_folder.is_dir()) {
        return Err(format!(
            "Extension folder not found for {} (normalized: {})",
            ext_id, normalized_ext_id
        ));
    }

    let resolved_id = target_ext_folder
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&normalized_ext_id)
        .to_string();

    let transpile = transpile_extension_in_place(&target_ext_folder, &resolved_id);
    let mut result = ExtensionRepairResult {
        extension_id: resolved_id.clone(),
        extension_dir: target_ext_folder.to_string_lossy().to_string(),
        mode: mode.clone(),
        transpile,
        hook_cleanup: ExtensionHookCleanupSummary::default(),
        ai: ExtensionAiSummary::default(),
        notes: Vec::new(),
    };

    if mode == "online" || mode == "hybrid" {
        result.hook_cleanup = cleanup_unresolved_block_hooks(&target_ext_folder);
        result.ai = run_ai_repair(
            &app,
            &resolved_id,
            &target_ext_folder,
            provider,
            api_key,
            base_url,
            model,
            user_prompt,
        )
        .await;
    }

    if result.transpile.placeholder_replacements > 0
        || result.transpile.dropdown_options_normalized > 0
        || result.transpile.generator_rewrites > 0
        || result.transpile.generator_prelude_injected
        || result.transpile.package_tagged
    {
        result.notes.push(format!(
            "Transpile applied: placeholders={}, dropdowns={}, generator_rewrites={}, prelude_injected={}, package_tagged={}",
            result.transpile.placeholder_replacements,
            result.transpile.dropdown_options_normalized,
            result.transpile.generator_rewrites,
            result.transpile.generator_prelude_injected,
            result.transpile.package_tagged
        ));
    }
    if !result.transpile.unresolved_placeholders.is_empty() {
        result.notes.push(format!(
            "Unresolved placeholders: {}",
            result
                .transpile
                .unresolved_placeholders
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if result.hook_cleanup.removed_extensions + result.hook_cleanup.removed_mutators > 0 {
        result.notes.push(format!(
            "Hook cleanup removed {} extensions and {} mutators",
            result.hook_cleanup.removed_extensions, result.hook_cleanup.removed_mutators
        ));
    }
    if result.ai.attempted {
        if result.ai.applied {
            result.notes.push(format!(
                "AI applied generator replacements={}, dropped extensions={}, dropped mutators={}",
                result.ai.generator_replacements_applied,
                result.ai.drop_extensions_applied,
                result.ai.drop_mutators_applied
            ));
        } else if let Some(err) = &result.ai.error {
            result.notes.push(format!("AI skipped: {}", err));
        }
    }

    Ok(result)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ExtensionInfo {
    pub id: String,
    pub name: String,
    pub dir_path: String,
    pub has_generator: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BatchImportItem {
    pub source_path: String,
    pub status: String,
    pub extension_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct BatchImportSummary {
    pub requested_path: String,
    pub total: usize,
    pub success: usize,
    pub failed: usize,
    pub items: Vec<BatchImportItem>,
}

#[tauri::command]
pub fn get_available_extensions(
    _app: tauri::AppHandle,
    fqbn: Option<String>,
) -> Result<Vec<ExtensionInfo>, String> {
    let ext_dir = super::ck_root_dir().join("extensions");

    if !ext_dir.exists() {
        if let Err(e) = fs::create_dir_all(&ext_dir) {
            log::warn!("Failed to create extensions directory: {}", e);
            return Ok(vec![]);
        }
    }

    let exts: Vec<ExtensionInfo> = Vec::new();

    if let Ok(entries) = fs::read_dir(&ext_dir) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                if is_extension_folder_candidate(&path) {
                    // `CK/extensions` is an import/migration source for legacy
                    // JavaScript only. A quality report or exact-hash approval
                    // cannot turn it into a sandbox, so it is never exposed to
                    // the main WebView runtime. Declarative packages are loaded
                    // through the library registry and its JSON entrypoints.
                    log::warn!(
                        "Skipped legacy extension runtime (no isolated JavaScript worker): {}",
                        path.display()
                    );
                    debug_assert!(!legacy_extension_runtime_can_execute(&path));
                    continue;
                }
            }
        }
    }

    // Filter by board if fqbn is specified
    if let Some(ref board) = fqbn {
        let filtered: Vec<ExtensionInfo> = exts
            .into_iter()
            .filter(|ext| {
                let meta_path = std::path::Path::new(&ext.dir_path).join("ck_meta.json");
                if meta_path.exists() {
                    if let Ok(meta_str) = fs::read_to_string(&meta_path) {
                        if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&meta_str) {
                            if let Some(boards) = meta["bound_boards"].as_array() {
                                return boards.iter().any(|b| {
                                    if let Some(meta_rule) = b.as_str() {
                                        // Make sure `arduino:avr:nano` matches `arduino:avr` rule or exactly
                                        board.starts_with(meta_rule)
                                    } else {
                                        false
                                    }
                                });
                            }
                        }
                    }
                }
                true // If no ck_meta.json exists, show it by default
            })
            .collect();
        return Ok(filtered);
    }

    Ok(exts)
}

fn legacy_extension_runtime_can_execute(_path: &Path) -> bool {
    // A quality report or exact-hash record proves identity/integrity only. CK
    // 1.0 has no isolated legacy-JavaScript host, so this policy has no bypass.
    false
}

#[tauri::command]
pub async fn import_extension(
    app: tauri::AppHandle,
    path: String,
    fqbn: Option<String>,
    board_package_id: Option<String>,
) -> Result<String, String> {
    let board = fqbn.ok_or_else(|| {
        "Standard extension import requires a selected package:architecture:board FQBN scope."
            .to_string()
    })?;
    let source = PathBuf::from(&path);
    let import_path = if source.is_dir() {
        let library_manifest = source.join("library.json");
        if !is_standard_block_package_candidate(&source) {
            return Err(
                "Legacy extension layouts are no longer imported directly. Provide a standard package containing library.json and ck-blocks.json."
                    .to_string(),
            );
        }
        library_manifest
    } else if source
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "library.json")
    {
        let parent = source
            .parent()
            .ok_or_else(|| "Invalid library.json path".to_string())?;
        if !parent.join("ck-blocks.json").is_file() {
            return Err(
                "Standard extension import requires ck-blocks.json next to library.json."
                    .to_string(),
            );
        }
        source
    } else if source
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        source
    } else {
        return Err(
            "Extension import accepts only a standard library.json + ck-blocks.json directory or a ZIP package."
                .to_string(),
        );
    };

    crate::lib_custom_registry::import_library(
        app,
        import_path.to_string_lossy().to_string(),
        board,
        board_package_id,
    )
    .await
}

async fn import_extension_legacy_disabled(
    _app: tauri::AppHandle,
    path: String,
    fqbn: Option<String>,
) -> Result<String, String> {
    log::info!("Recieved extension import request for: {}", path);
    let src_path = std::path::Path::new(&path);
    if !src_path.exists() {
        return Err(format!("Provided file does not exist: {}", path));
    }

    let is_dir = src_path.is_dir();
    let is_zip = !is_dir
        && src_path
            .extension()
            .map(|e| e == "zip" || e == "7z")
            .unwrap_or(false);
    if !is_dir && !is_zip {
        return Err(
            "Format not supported. Supports .zip, .7z, or a folder containing block.json (or Mixly layout)."
                .into(),
        );
    }

    if is_dir && !is_extension_folder_candidate(src_path) {
        let mut child_candidate_count = 0usize;
        if let Ok(entries) = fs::read_dir(src_path) {
            for entry in entries.filter_map(Result::ok) {
                let p = entry.path();
                if p.is_dir() && is_extension_folder_candidate(&p) {
                    child_candidate_count += 1;
                    if child_candidate_count > 1 {
                        break;
                    }
                }
            }
        }
        if child_candidate_count > 1 {
            return Err("Selected folder contains multiple extension packages. Please use batch import for this directory.".to_string());
        }
    }

    let ck_dir = super::ck_root_dir();
    let ext_dir = ck_dir.join("extensions");
    let mut lib_dir = ck_dir.join("libraries");

    // Board isolation: Sub-folder the C++ library
    if let Some(ref board) = fqbn {
        let parsed: Vec<&str> = board.split(':').collect();
        let safe_board = if parsed.len() >= 3 {
            parsed[0..3].join("_")
        } else {
            board.replace(":", "_")
        };
        lib_dir = lib_dir.join(safe_board);
    }

    std::fs::create_dir_all(&ext_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&lib_dir).map_err(|e| e.to_string())?;

    // Create a temporary staging directory
    let temp_staging = std::env::temp_dir().join(format!("ck_ext_stage_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_staging).map_err(|e| e.to_string())?;

    if is_dir {
        // ---- Direct folder import: copy folder contents to staging ----
        log::info!("Importing extension from folder: {}", path);
        let folder_name = src_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let staging_target = temp_staging.join(&folder_name);
        copy_dir_recursive(src_path, &staging_target)
            .map_err(|e| format!("Failed to copy extension folder: {}", e))?;
    } else {
        // ---- Decompress zip ----
        let file =
            std::fs::File::open(&src_path).map_err(|e| format!("Failed to open zip: {}", e))?;
        let mut archive =
            zip::ZipArchive::new(file).map_err(|e| format!("Failed to parse zip: {}", e))?;

        // We'll extract everything to temp_staging
        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|e| format!("Failed reading zip contents: {}", e))?;
            let outpath = match file.enclosed_name() {
                Some(path) => temp_staging.join(path),
                None => continue,
            };

            if file.name().ends_with('/') {
                std::fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
            } else {
                if let Some(p) = outpath.parent() {
                    if !p.exists() {
                        std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
                    }
                }
                let mut outfile = std::fs::File::create(&outpath).map_err(|e| e.to_string())?;
                std::io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
            }
        }
    }

    // Locate the root of the extension.
    // Priority:
    // 1) Modern layout (contains block.json)
    // 2) Legacy/Mixly layout (block/*.js + *.xml category)
    let mut ext_root = None;
    let mut detected_legacy = false;
    for entry in walkdir::WalkDir::new(&temp_staging)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() && entry.file_name() == "block.json" {
            ext_root = Some(entry.path().parent().unwrap().to_path_buf());
            detected_legacy = false;
            break;
        }
    }

    if ext_root.is_none() {
        for entry in walkdir::WalkDir::new(&temp_staging)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if entry.file_type().is_dir() && is_legacy_extension_layout(entry.path()) {
                ext_root = Some(entry.path().to_path_buf());
                detected_legacy = true;
                break;
            }
        }
    }

    let ext_root = ext_root.ok_or(
        "Invalid extension format: missing block.json or unsupported legacy (Mixly) layout",
    )?;

    if detected_legacy {
        normalize_legacy_extension_layout(&ext_root)?;
    }

    // Retrieve name/ID
    let mut ext_id = src_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let pkg_json = ext_root.join("package.json");
    if pkg_json.exists() {
        if let Ok(content) = std::fs::read_to_string(&pkg_json) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(n) = json["name"].as_str() {
                    ext_id = n.to_string();
                }
            }
        }
    }

    if ext_id.is_empty() {
        ext_id = "UnknownExtension".to_string();
    }

    // Sanitize ext_id to ensure legal directory names
    ext_id = sanitize_extension_id(&ext_id);

    log::info!("Installing extension ID: {}", ext_id);

    // 1. Move frontend components to extensions config dir
    let target_ext_folder = ext_dir.join(&ext_id);
    if target_ext_folder.exists() {
        std::fs::remove_dir_all(&target_ext_folder).map_err(|e| e.to_string())?;
    }
    crate::options::dir::move_dir(&ext_root, &target_ext_folder)
        .map_err(|e| format!("Failed to move extension files: {}", e))?;

    // 1.5 Auto-transpile imported extension for CK runtime compatibility.
    let transpile = transpile_extension_in_place(&target_ext_folder, &ext_id);
    if transpile.placeholder_replacements > 0
        || transpile.dropdown_options_normalized > 0
        || transpile.generator_rewrites > 0
        || transpile.generator_prelude_injected
        || transpile.package_tagged
    {
        log::info!(
            "Transpiled extension {}: placeholders={}, dropdowns={}, generator_rewrites={}, prelude_injected={}, package_tagged={}",
            ext_id,
            transpile.placeholder_replacements,
            transpile.dropdown_options_normalized,
            transpile.generator_rewrites,
            transpile.generator_prelude_injected,
            transpile.package_tagged
        );
    }
    if !transpile.unresolved_placeholders.is_empty() {
        log::warn!(
            "Transpile unresolved board placeholders in {}: {:?}",
            ext_id,
            transpile.unresolved_placeholders
        );
    }
    if !transpile.notes.is_empty() {
        for note in transpile.notes {
            log::warn!("Transpile note for {}: {}", ext_id, note);
        }
    }

    // 2. Check for C++ Backend resources:
    // - src.7z
    // - src/
    // - libraries/ (legacy Mixly layout)
    let mut c_source_origins: Vec<PathBuf> = Vec::new();
    let possible_src_7z = target_ext_folder.join("src.7z");
    let possible_src_dir = target_ext_folder.join("src");
    let possible_libraries_dir = target_ext_folder.join("libraries");

    if possible_src_7z.exists() {
        c_source_origins.push(possible_src_7z);
    }
    if possible_src_dir.exists() {
        c_source_origins.push(possible_src_dir);
    }
    if possible_libraries_dir.exists() {
        c_source_origins.push(possible_libraries_dir);
    }

    if !c_source_origins.is_empty() {
        let target_lib_folder = lib_dir.join(&ext_id);
        if target_lib_folder.exists() {
            std::fs::remove_dir_all(&target_lib_folder).map_err(|e| e.to_string())?;
        }
        std::fs::create_dir_all(&target_lib_folder).map_err(|e| e.to_string())?;

        for src_path in c_source_origins {
            let is_7z = src_path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("7z"))
                .unwrap_or(false);
            if is_7z {
                // Deep Extract 7z with an external terminal invocation
                log::info!("Found src.7z, invoking shell 7z to extract...");

                let seven_zip_cmd = "C:\\Program Files\\7-Zip\\7z.exe";
                let has_7z = std::path::Path::new(seven_zip_cmd).exists();

                if !has_7z {
                    log::warn!(
                        "7-Zip is not installed in Program Files, attempting to use built-in Windows tar decoder if compatible, or fallback path"
                    );
                }

                // Run extraction
                let output = std::process::Command::new(if has_7z { seven_zip_cmd } else { "tar" })
                    .arg(if has_7z { "x" } else { "-xf" })
                    .arg(src_path.to_string_lossy().to_string())
                    .arg(if has_7z {
                        format!("-o{}", target_lib_folder.to_string_lossy())
                    } else {
                        "-C".to_string()
                    })
                    .arg(if has_7z {
                        "-y".to_string()
                    } else {
                        target_lib_folder.to_string_lossy().to_string()
                    })
                    .output();

                match output {
                    Ok(res) => {
                        if !res.status.success() {
                            log::error!(
                                "Failed to extract 7z: {}",
                                String::from_utf8_lossy(&res.stderr)
                            );
                            return Err(
                                "7z extraction failed. 7-Zip might not be installed correctly."
                                    .to_string(),
                            );
                        }
                        log::info!("Successfully extracted 7z to libraries dir.");
                    }
                    Err(e) => {
                        log::error!("Command execution failed: {}", e);
                        return Err(format!("Failed to execute 7z decompression: {}", e));
                    }
                }

                // Flatten folder if it just extracted a single `src` root.
                flatten_extracted_src_layout(&target_lib_folder)?;

                // Remove the processed 7z file to save space only after successful normalization.
                let _ = std::fs::remove_file(src_path);
                continue;
            }

            let is_libraries_dir = src_path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.eq_ignore_ascii_case("libraries"))
                .unwrap_or(false);

            if is_libraries_dir {
                // Legacy Mixly packages usually keep Arduino C++ libraries under `libraries/`.
                for entry in std::fs::read_dir(&src_path).map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    let dst = target_lib_folder.join(entry.file_name());
                    move_extracted_path(&entry.path(), &dst)?;
                }
                let _ = std::fs::remove_dir_all(src_path);
                continue;
            }

            // Standard directory `src/`: move its children into target lib folder.
            for entry in std::fs::read_dir(&src_path).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let dst = target_lib_folder.join(entry.file_name());
                move_extracted_path(&entry.path(), &dst)?;
            }
            let _ = std::fs::remove_dir_all(src_path);
        }
    }

    // Write board binding metadata (ck_meta.json)
    // As per user request: strictly isolate to the currently active board when installed.
    let mut bound_boards: Vec<String> = Vec::new();
    if let Some(ref board) = fqbn {
        let base_board = board.splitn(4, ':').take(3).collect::<Vec<_>>().join(":");
        bound_boards.push(base_board);
    }

    let meta_path = target_ext_folder.join("ck_meta.json");
    let meta_json = serde_json::json!({ "bound_boards": bound_boards });
    let _ = fs::write(
        &meta_path,
        serde_json::to_string_pretty(&meta_json).unwrap_or_default(),
    );
    log::info!("Bound extension {} to board(s): {:?}", ext_id, bound_boards);

    // Cleanup temp zone
    let _ = std::fs::remove_dir_all(&temp_staging);
    Ok(ext_id)
}

#[tauri::command]
pub async fn import_extensions_batch(
    app: tauri::AppHandle,
    path: String,
    fqbn: Option<String>,
    board_package_id: Option<String>,
) -> Result<BatchImportSummary, String> {
    let root = Path::new(&path);
    if !root.exists() {
        return Err(format!("Provided folder does not exist: {}", path));
    }
    if !root.is_dir() {
        return Err(format!("Path is not a folder: {}", path));
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if is_standard_block_package_candidate(root) {
        candidates.push(root.to_path_buf());
    }

    let entries =
        fs::read_dir(root).map_err(|e| format!("Failed to read folder {}: {}", path, e))?;
    for entry in entries.filter_map(Result::ok) {
        let p = entry.path();
        if p.is_dir() {
            if is_standard_block_package_candidate(&p) {
                candidates.push(p);
            }
        } else if p.is_file() && is_supported_extension_archive(&p) {
            candidates.push(p);
        }
    }

    candidates.sort_by(|a, b| {
        let a_name = a.file_name().unwrap_or_default();
        let b_name = b.file_name().unwrap_or_default();
        a_name.cmp(b_name)
    });
    candidates.dedup();

    if candidates.is_empty() {
        return Err(format!(
            "No standard block packages found under {}. Expected subfolders with library.json + ck-blocks.json, or .zip files.",
            path
        ));
    }

    let mut summary = BatchImportSummary {
        requested_path: path.clone(),
        total: candidates.len(),
        success: 0,
        failed: 0,
        items: Vec::new(),
    };

    for candidate in candidates {
        let source_path = candidate.to_string_lossy().to_string();
        match import_extension(
            app.clone(),
            source_path.clone(),
            fqbn.clone(),
            board_package_id.clone(),
        )
        .await
        {
            Ok(ext_id) => {
                summary.success += 1;
                summary.items.push(BatchImportItem {
                    source_path,
                    status: "ok".to_string(),
                    extension_id: Some(ext_id),
                    error: None,
                });
            }
            Err(err) => {
                summary.failed += 1;
                summary.items.push(BatchImportItem {
                    source_path,
                    status: "failed".to_string(),
                    extension_id: None,
                    error: Some(err),
                });
            }
        }
    }

    Ok(summary)
}

#[tauri::command]
pub fn uninstall_extension(ext_id: String) -> Result<(), String> {
    let normalized_ext_id = sanitize_extension_id(&ext_id);
    let ck_dir = super::ck_root_dir();
    let extensions_root = ck_dir.join("extensions");
    let libraries_root = ck_dir.join("libraries");

    let mut candidates = vec![normalized_ext_id.clone()];
    if ext_id != normalized_ext_id {
        candidates.push(ext_id.clone());
    }

    let remove_dir_if_exists = |path: &std::path::Path| -> Result<bool, String> {
        if !path.exists() {
            return Ok(false);
        }
        std::fs::remove_dir_all(path).map_err(|e| format!("Failed to remove {:?}: {}", path, e))?;
        Ok(true)
    };

    for candidate in &candidates {
        let ext_path = extensions_root.join(candidate);
        if remove_dir_if_exists(&ext_path)? {
            log::info!("Removed extension directory: {:?}", ext_path);
        }
    }

    // Legacy global path: CK/libraries/<ext_id>
    for candidate in &candidates {
        let legacy_lib_path = libraries_root.join(candidate);
        if remove_dir_if_exists(&legacy_lib_path)? {
            log::info!("Removed legacy library directory: {:?}", legacy_lib_path);
        }
    }

    // Board-specific path: CK/libraries/<board>/<ext_id>
    if libraries_root.exists() {
        let entries = std::fs::read_dir(&libraries_root)
            .map_err(|e| format!("Failed to read libraries root {:?}: {}", libraries_root, e))?;
        for entry in entries.filter_map(Result::ok) {
            let board_path = entry.path();
            if !board_path.is_dir() {
                continue;
            }
            for candidate in &candidates {
                let board_lib_path = board_path.join(candidate);
                if remove_dir_if_exists(&board_lib_path)? {
                    log::info!("Removed board library directory: {:?}", board_lib_path);
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod extension_runtime_quality_tests {
    use super::legacy_extension_runtime_can_execute;
    use std::fs;

    #[test]
    fn executable_legacy_extensions_stay_disabled_regardless_of_quality_report() {
        let root = std::env::temp_dir().join(format!(
            "ck-extension-runtime-quality-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("fixture directory");
        fs::write(root.join("library.json"), r#"{"id":"certified-extension"}"#)
            .expect("fixture manifest");
        fs::write(root.join("generator.js"), "// certified fixture").expect("fixture runtime");
        assert!(!legacy_extension_runtime_can_execute(&root));

        let mut report = crate::package_quality::PackageQualityReport::new("block-library");
        report.package_id = Some("certified-extension".to_string());
        report.source_content_sha256 =
            Some(crate::package_quality::hash_package_contents(&root).expect("content hash"));
        report.pass("fixture", "fixture passed");
        report.finalize();
        crate::package_quality::write_quality_report(&root, &report).expect("quality report");
        assert!(!legacy_extension_runtime_can_execute(&root));

        report.validated_consumers.clear();
        report.source_content_sha256 =
            Some(crate::package_quality::hash_package_contents(&root).expect("content hash"));
        crate::package_quality::write_quality_report(&root, &report).expect("quality report");
        assert!(!legacy_extension_runtime_can_execute(&root));

        report
            .validated_consumers
            .push("runtime-loader".to_string());
        report.package_kind = "board".to_string();
        report.source_content_sha256 =
            Some(crate::package_quality::hash_package_contents(&root).expect("content hash"));
        crate::package_quality::write_quality_report(&root, &report).expect("quality report");
        assert!(!legacy_extension_runtime_can_execute(&root));

        report.package_kind = "block-library".to_string();
        report.package_id = Some("other-extension".to_string());
        report.source_content_sha256 =
            Some(crate::package_quality::hash_package_contents(&root).expect("content hash"));
        crate::package_quality::write_quality_report(&root, &report).expect("quality report");
        assert!(!legacy_extension_runtime_can_execute(&root));

        report.package_id = Some("certified-extension".to_string());
        report.source_content_sha256 =
            Some(crate::package_quality::hash_package_contents(&root).expect("content hash"));
        crate::package_quality::write_quality_report(&root, &report).expect("quality report");
        assert!(!legacy_extension_runtime_can_execute(&root));

        fs::write(root.join("generator.js"), "// changed after certification")
            .expect("tampered runtime");
        assert!(!legacy_extension_runtime_can_execute(&root));
        let _ = fs::remove_dir_all(root);
    }
}
