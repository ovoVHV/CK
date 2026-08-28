use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_MAP_BYTES: u64 = 64 * 1024 * 1024;
const MAX_MAP_CANDIDATES: usize = 4;
const MAX_GROUPS: usize = 512;
// Bump this ID whenever either exact whitelist in section_class changes. Old
// frontend snapshots must never be compared across classifier revisions.
const ESP32_SIZE_CLASSIFIER_ID: &str = "esp32-arduino-size-recipe-v2";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkerMapGroup {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub program_bytes: u64,
    pub ram_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkerMapSummary {
    pub schema_version: u32,
    pub fqbn: String,
    pub classifier_id: String,
    pub recorded_at: String,
    pub map_file_name: String,
    pub map_sha256: String,
    pub map_bytes: u64,
    pub program_output_bytes: u64,
    pub ram_output_bytes: u64,
    pub accounted_program_bytes: u64,
    pub accounted_ram_bytes: u64,
    pub groups: Vec<LinkerMapGroup>,
}

#[derive(Debug, Clone, Copy, Default)]
struct SectionClass {
    program: bool,
    ram: bool,
}

fn section_class(name: &str) -> SectionClass {
    let section = name.to_ascii_lowercase();
    let program = matches!(
        section.as_str(),
        ".iram0.text"
            | ".iram0.vectors"
            | ".dram0.data"
            | ".dram1.data"
            | ".flash.text"
            | ".flash.appdesc"
            | ".flash.rodata"
            | ".flash.init_array"
            | ".eh_frame"
    );
    let ram = matches!(
        section.as_str(),
        ".dram0.data" | ".dram0.bss" | ".dram1.data" | ".dram1.bss" | ".noinit"
    );
    SectionClass { program, ram }
}

fn bounded_label(value: &str) -> String {
    value.chars().take(200).collect()
}

fn content_group_id(kind: &str, value: &str) -> String {
    // Preserve case: a POSIX build can legally contain both Foo and foo. It is
    // safer to display two groups on Windows than to merge distinct inputs.
    let canonical = value.trim();
    format!("{}:{:x}", kind, Sha256::digest(canonical.as_bytes()))
}

fn source_group(source: &str) -> (String, String, String) {
    let normalized = source.replace('\\', "/");
    let lower = normalized.to_ascii_lowercase();
    if let Some(start) = lower.find("/build/libraries/") {
        let tail = &normalized[start + "/build/libraries/".len()..];
        if let Some(name) = tail.split('/').next().filter(|value| !value.is_empty()) {
            return (
                content_group_id("library", name),
                bounded_label(name),
                "library".to_string(),
            );
        }
    }
    if lower.contains("/build/sketch/") || lower.contains(".ino.cpp.o") {
        return (
            "generated-code".to_string(),
            "生成代码".to_string(),
            "generated-code".to_string(),
        );
    }
    if lower.contains("/build/core/core.a") {
        return (
            "arduino-core".to_string(),
            "Arduino Core".to_string(),
            "core".to_string(),
        );
    }

    let archive = Regex::new(r"(?i)(?:^|/)(lib[^/()]+\.a)(?:\([^)]*\))?")
        .expect("archive regex")
        .captures_iter(&normalized)
        .last()
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().to_string());
    if let Some(archive) = archive {
        let label = archive
            .trim_end_matches(".a")
            .trim_start_matches("lib")
            .to_string();
        return (
            content_group_id("platform", &label),
            bounded_label(&label),
            "platform-library".to_string(),
        );
    }

    (
        "other-linker-input".to_string(),
        "其他链接对象".to_string(),
        "other".to_string(),
    )
}

fn parse_hex(value: &str) -> Option<u64> {
    u64::from_str_radix(value.trim_start_matches("0x"), 16).ok()
}

fn parse_linker_map_text(
    text: &str,
    fqbn: &str,
    file_name: &str,
    map_sha256: &str,
    map_bytes: u64,
    recorded_at: &str,
) -> Result<LinkerMapSummary, String> {
    let output = Regex::new(r"^(\.[A-Za-z0-9_.-]+)\s+0x[0-9A-Fa-f]+\s+0x([0-9A-Fa-f]+)(?:\s|$)")
        .map_err(|error| error.to_string())?;
    let input_inline = Regex::new(r"^\s+(\.[^\s]+)\s+0x[0-9A-Fa-f]+\s+0x([0-9A-Fa-f]+)\s+(.+)$")
        .map_err(|error| error.to_string())?;
    let input_name = Regex::new(r"^\s+(\.[^\s]+)\s*$").map_err(|error| error.to_string())?;
    let output_name = Regex::new(r"^(\.[^\s]+)\s*$").map_err(|error| error.to_string())?;
    let output_continuation = Regex::new(r"^\s+0x[0-9A-Fa-f]+\s+0x([0-9A-Fa-f]+)\s*$")
        .map_err(|error| error.to_string())?;
    let input_continuation = Regex::new(r"^\s+0x[0-9A-Fa-f]+\s+0x([0-9A-Fa-f]+)\s+(.+)$")
        .map_err(|error| error.to_string())?;
    let mut in_memory_map = false;
    let mut current = SectionClass::default();
    let mut pending_input = false;
    let mut pending_output: Option<String> = None;
    let mut program_output_bytes = 0u64;
    let mut ram_output_bytes = 0u64;
    let mut groups = BTreeMap::<String, LinkerMapGroup>::new();

    let mut add_input = |size: u64, source: &str, class: SectionClass| {
        if size == 0 || (!class.program && !class.ram) {
            return;
        }
        let source = source.trim();
        if source.starts_with('*') || !(source.contains(".o") || source.contains(".a")) {
            return;
        }
        let (id, label, kind) = source_group(source);
        let entry = groups.entry(id.clone()).or_insert(LinkerMapGroup {
            id,
            label,
            kind,
            program_bytes: 0,
            ram_bytes: 0,
        });
        if class.program {
            entry.program_bytes = entry.program_bytes.saturating_add(size);
        }
        if class.ram {
            entry.ram_bytes = entry.ram_bytes.saturating_add(size);
        }
    };

    for line in text.lines() {
        if !in_memory_map {
            if line.trim() == "Linker script and memory map" {
                in_memory_map = true;
            }
            continue;
        }

        if let Some(captures) = output.captures(line) {
            let name = captures
                .get(1)
                .map(|value| value.as_str())
                .unwrap_or_default();
            let size = captures
                .get(2)
                .and_then(|value| parse_hex(value.as_str()))
                .unwrap_or_default();
            current = section_class(name);
            pending_input = false;
            if current.program {
                program_output_bytes = program_output_bytes.saturating_add(size);
            }
            if current.ram {
                ram_output_bytes = ram_output_bytes.saturating_add(size);
            }
            continue;
        }
        if let Some(name) = pending_output.take() {
            if let Some(captures) = output_continuation.captures(line) {
                let size = captures
                    .get(1)
                    .and_then(|value| parse_hex(value.as_str()))
                    .unwrap_or_default();
                current = section_class(&name);
                pending_input = false;
                if current.program {
                    program_output_bytes = program_output_bytes.saturating_add(size);
                }
                if current.ram {
                    ram_output_bytes = ram_output_bytes.saturating_add(size);
                }
                continue;
            }
        }
        if let Some(captures) = output_name.captures(line) {
            pending_output = captures.get(1).map(|value| value.as_str().to_string());
            pending_input = false;
            continue;
        }

        if let Some(captures) = input_inline.captures(line) {
            let size = captures
                .get(2)
                .and_then(|value| parse_hex(value.as_str()))
                .unwrap_or_default();
            let source = captures
                .get(3)
                .map(|value| value.as_str())
                .unwrap_or_default();
            add_input(size, source, current);
            pending_input = false;
            continue;
        }
        if input_name.is_match(line) {
            pending_input = true;
            continue;
        }
        if pending_input {
            if let Some(captures) = input_continuation.captures(line) {
                let size = captures
                    .get(1)
                    .and_then(|value| parse_hex(value.as_str()))
                    .unwrap_or_default();
                let source = captures
                    .get(2)
                    .map(|value| value.as_str())
                    .unwrap_or_default();
                add_input(size, source, current);
            }
            pending_input = false;
        }
    }

    if !in_memory_map {
        return Err("GNU map does not contain a linker memory-map section".to_string());
    }
    if program_output_bytes == 0 && ram_output_bytes == 0 {
        return Err("GNU map did not expose supported ESP32 output sections".to_string());
    }

    let mut groups = groups.into_values().collect::<Vec<_>>();
    groups.sort_by(|left, right| {
        (right.program_bytes + right.ram_bytes)
            .cmp(&(left.program_bytes + left.ram_bytes))
            .then_with(|| left.id.cmp(&right.id))
    });
    if groups.len() > MAX_GROUPS {
        let overflow = groups.split_off(MAX_GROUPS - 1);
        groups.push(LinkerMapGroup {
            id: "other-linker-input-overflow".to_string(),
            label: format!("其他链接对象（{} 组）", overflow.len()),
            kind: "other".to_string(),
            program_bytes: overflow.iter().map(|item| item.program_bytes).sum(),
            ram_bytes: overflow.iter().map(|item| item.ram_bytes).sum(),
        });
    }
    let accounted_program_bytes = groups.iter().map(|item| item.program_bytes).sum();
    let accounted_ram_bytes = groups.iter().map(|item| item.ram_bytes).sum();

    Ok(LinkerMapSummary {
        schema_version: 1,
        fqbn: fqbn.to_string(),
        classifier_id: ESP32_SIZE_CLASSIFIER_ID.to_string(),
        recorded_at: recorded_at.to_string(),
        map_file_name: file_name.to_string(),
        map_sha256: map_sha256.to_string(),
        map_bytes,
        program_output_bytes,
        ram_output_bytes,
        accounted_program_bytes,
        accounted_ram_bytes,
        groups,
    })
}

fn trusted_map_file(build_directory: &Path) -> Result<PathBuf, String> {
    let canonical_build = fs::canonicalize(build_directory)
        .map_err(|error| format!("cannot resolve trusted build directory: {error}"))?;
    if !canonical_build.is_dir() {
        return Err("trusted build directory is not a directory".to_string());
    }
    let mut maps = Vec::new();
    for entry in walkdir::WalkDir::new(&canonical_build)
        .max_depth(3)
        .follow_links(false)
        .into_iter()
    {
        let entry = entry.map_err(|error| format!("cannot inspect build directory: {error}"))?;
        if !entry.file_type().is_file()
            || !entry
                .path()
                .extension()
                .is_some_and(|value| value.eq_ignore_ascii_case("map"))
        {
            continue;
        }
        let canonical = fs::canonicalize(entry.path())
            .map_err(|error| format!("cannot resolve map evidence: {error}"))?;
        if !canonical.starts_with(&canonical_build) {
            return Err("linker map escaped the trusted build directory".to_string());
        }
        maps.push(canonical);
        if maps.len() > MAX_MAP_CANDIDATES {
            return Err("build directory contains too many linker-map candidates".to_string());
        }
    }
    if maps.len() != 1 {
        return Err(format!(
            "expected exactly one linker map in the trusted build directory, found {}",
            maps.len()
        ));
    }
    Ok(maps.remove(0))
}

pub fn summarize_build_linker_map(
    build_directory: &Path,
    fqbn: &str,
    recorded_at: &str,
) -> Result<LinkerMapSummary, String> {
    let map_path = trusted_map_file(build_directory)?;
    let metadata = fs::metadata(&map_path)
        .map_err(|error| format!("cannot inspect linker map metadata: {error}"))?;
    if metadata.len() == 0 || metadata.len() > MAX_MAP_BYTES {
        return Err(format!(
            "linker map size {} is outside the accepted range",
            metadata.len()
        ));
    }
    let bytes = fs::read(&map_path).map_err(|error| format!("cannot read linker map: {error}"))?;
    if bytes.len() as u64 != metadata.len() {
        return Err("linker map changed while it was being read".to_string());
    }
    let map_sha256 = format!("{:x}", Sha256::digest(&bytes));
    let text = String::from_utf8(bytes).map_err(|_| "linker map is not UTF-8".to_string())?;
    let file_name = map_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "linker map file name is not valid UTF-8".to_string())?;
    parse_linker_map_text(
        &text,
        fqbn,
        file_name,
        &map_sha256,
        metadata.len(),
        recorded_at,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"
Discarded input sections
 .text.bad
                0x00000000       0xff C:\outside\bad.a(bad.o)
Linker script and memory map
.iram0.text     0x40800000       0x20
 .text.core     0x40800000       0x10 C:\tmp\build\core\core.a(main.cpp.o)
 .text.wifi
                0x40800010       0x10 C:\tmp\build\libraries\WiFi\WiFi.cpp.o
.dram0.data     0x40810000        0x8
 .data.sketch   0x40810000        0x8 C:\tmp\build\sketch\demo.ino.cpp.o
.dram0.bss      0x40810008        0xc
 .bss.wifi      0x40810008        0xc C:\tmp\build\libraries\WiFi\WiFi.cpp.o
.flash.text     0x42000020       0x30
 .text.wifi     0x42000020       0x20 C:\tmp\build\libraries\WiFi\WiFi.cpp.o
 *fill*         0x42000040       0x10
.flash.rodata   0x42000100       0x10
 .rodata.lib    0x42000100       0x10 C:\packages\lib\libnet.a(net.c.obj)
.debug_info     0x00000000      0x999
 .debug_info    0x00000000      0x999 C:\tmp\build\libraries\WiFi\WiFi.cpp.o
"#;

    #[test]
    fn parses_only_allocated_memory_map_sections_and_groups_sources() {
        let summary = parse_linker_map_text(
            FIXTURE,
            "esp32:esp32:esp32c6",
            "firmware.map",
            &"a".repeat(64),
            FIXTURE.len() as u64,
            "2026-07-16T00:00:00Z",
        )
        .unwrap();
        assert_eq!(summary.program_output_bytes, 0x68);
        assert_eq!(summary.ram_output_bytes, 0x14);
        let wifi = summary
            .groups
            .iter()
            .find(|item| item.label == "WiFi")
            .unwrap();
        assert_eq!(wifi.program_bytes, 0x30);
        assert_eq!(wifi.ram_bytes, 0xc);
        let generated = summary
            .groups
            .iter()
            .find(|item| item.id == "generated-code")
            .unwrap();
        assert_eq!(generated.program_bytes, 0x8);
        assert_eq!(generated.ram_bytes, 0x8);
        assert!(!summary.groups.iter().any(|item| item.program_bytes == 0xff));
        assert!(
            !summary
                .groups
                .iter()
                .any(|item| item.program_bytes == 0x999)
        );
    }

    #[test]
    fn reads_exactly_one_map_below_the_trusted_build_directory() {
        let root = std::env::temp_dir().join(format!("ck-resource-map-{}", uuid::Uuid::new_v4()));
        let build = root.join("build");
        fs::create_dir_all(&build).unwrap();
        fs::write(build.join("firmware.map"), FIXTURE).unwrap();
        let summary =
            summarize_build_linker_map(&root, "esp32:esp32:esp32c6", "2026-07-16T00:00:00Z")
                .unwrap();
        assert_eq!(summary.map_file_name, "firmware.map");
        assert_eq!(summary.map_sha256.len(), 64);
        let root_text = root.to_string_lossy().to_string();
        assert!(
            !serde_json::to_string(&summary)
                .unwrap()
                .contains(root_text.as_str())
        );

        fs::write(build.join("ambiguous.map"), FIXTURE).unwrap();
        assert!(
            summarize_build_linker_map(&root, "esp32:esp32:esp32c6", "2026-07-16T00:00:00Z",)
                .unwrap_err()
                .contains("exactly one")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn follows_the_esp32_core_3_3_6_size_recipe_exactly() {
        let fixture = r#"
Linker script and memory map
.iram0.text     0x40800000    0x13246
.iram0.vectors  0x40813246        0x0
.dram0.data     0x40813250     0x381c
.dram1.data     0x40816a6c        0x0
.noinit         0x40816a6c        0x0
.dram0.bss      0x40816a70     0x6400
.dram1.bss      0x4081ce70        0x0
.flash.text     0x42000020    0xabeb8
.flash.appdesc  0x420b0020      0x100
.flash.rodata   0x420b0120    0x1c3d0
.flash.init_array 0x420cc4f0       0x0
.eh_frame       0x420cc4f0     0x452c
.flash.rodata_noload
                0x3c000000     0x8597
"#;
        let summary = parse_linker_map_text(
            fixture,
            "esp32:esp32:esp32c6:FlashSize=16M",
            "real-c6.map",
            &"c".repeat(64),
            fixture.len() as u64,
            "2026-07-16T00:00:00Z",
        )
        .unwrap();
        assert_eq!(summary.program_output_bytes, 930_582);
        assert_eq!(summary.ram_output_bytes, 39_964);
    }

    #[test]
    fn collision_prone_library_labels_never_merge_into_one_group() {
        let (space_id, _, _) = source_group("C:/tmp/build/libraries/Foo Bar/a.cpp.o");
        let (dash_id, _, _) = source_group("C:/tmp/build/libraries/foo-bar/a.cpp.o");
        let (unicode_id, _, _) = source_group("C:/tmp/build/libraries/传感器/a.cpp.o");
        let (upper_id, _, _) = source_group("/tmp/build/libraries/Foo/a.cpp.o");
        let (lower_id, _, _) = source_group("/tmp/build/libraries/foo/a.cpp.o");
        assert_ne!(space_id, dash_id);
        assert_ne!(space_id, unicode_id);
        assert_ne!(dash_id, unicode_id);
        assert_ne!(upper_id, lower_id);
        assert!(space_id.starts_with("library:"));
        assert_eq!(space_id.len(), "library:".len() + 64);
    }
}
