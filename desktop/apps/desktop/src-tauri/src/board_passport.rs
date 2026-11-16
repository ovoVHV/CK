use crate::package_quality;
use chrono::Utc;
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const BOARD_LOCK_FILE: &str = "ck.lock";
pub const BOARD_LOCK_SCHEMA_VERSION: u32 = 1;

fn local_provenance() -> String {
    "local".to_string()
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArduinoCoreRequirement {
    pub package: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_range: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum_exclusive: Option<String>,
    #[serde(default)]
    pub tested_versions: Vec<String>,
    #[serde(default)]
    pub known_incompatible: Vec<CoreIncompatibleSelector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index_url: Option<String>,
}

impl ArduinoCoreRequirement {
    pub fn from_manifest_value(value: &Value) -> Result<Self, String> {
        let object = value
            .as_object()
            .ok_or("arduino_core must be a JSON object")?;
        let string = |key: &str| {
            object
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        let strings = |key: &str| {
            object
                .get(key)
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };

        let package = string("package").ok_or("arduino_core.package is required")?;
        let explicit_recommended = string("recommended_version");
        let legacy_recommended = string("version");
        if explicit_recommended.is_some()
            && legacy_recommended.is_some()
            && explicit_recommended != legacy_recommended
        {
            return Err(
                "arduino_core.version and recommended_version must match when both are present"
                    .to_string(),
            );
        }
        let recommended_version = explicit_recommended.or(legacy_recommended);
        let range_object = object.get("version_range").and_then(Value::as_object);
        let min_version = string("min_version").or_else(|| {
            range_object
                .and_then(|range| range.get("minimum"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        });
        let maximum_exclusive = string("maximum_exclusive").or_else(|| {
            range_object
                .and_then(|range| range.get("maximum_exclusive"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        });
        let known_incompatible = object
            .get("known_incompatible")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .map(CoreIncompatibleSelector::from_manifest_value)
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            package,
            recommended_version,
            version_range: object
                .get("version_range")
                .and_then(Value::as_str)
                .map(str::to_string),
            min_version,
            max_version: string("max_version"),
            maximum_exclusive,
            tested_versions: strings("tested_versions"),
            known_incompatible,
            index_url: string("index_url").or_else(|| string("platform_index_url")),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoreIncompatibleSelector {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_range: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum_exclusive: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl CoreIncompatibleSelector {
    fn from_manifest_value(value: &Value) -> Result<Self, String> {
        if let Some(version) = value.as_str() {
            let version = version.trim();
            if version.is_empty() {
                return Err("known_incompatible contains an empty selector".to_string());
            }
            return Ok(Self {
                version: Some(version.to_string()),
                version_range: None,
                minimum: None,
                maximum_exclusive: None,
                reason: Some("Legacy board package incompatibility declaration.".to_string()),
            });
        }
        let object = value
            .as_object()
            .ok_or("known_incompatible entries must be strings or objects")?;
        let text = |key: &str| {
            object
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        let reason =
            text("reason").ok_or("known_incompatible object entries require a concrete reason")?;
        let range = object.get("version_range");
        let version_range = range.and_then(Value::as_str).map(str::to_string);
        let range_object = range.and_then(Value::as_object);
        if let Some(range) = range_object {
            if range.is_empty()
                || !range
                    .keys()
                    .all(|key| matches!(key.as_str(), "minimum" | "maximum_exclusive"))
            {
                return Err(
                    "known_incompatible.version_range only supports minimum/maximum_exclusive"
                        .to_string(),
                );
            }
        }
        let minimum = range_object
            .and_then(|range| range.get("minimum"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let maximum_exclusive = range_object
            .and_then(|range| range.get("maximum_exclusive"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let selector = Self {
            version: text("version"),
            version_range,
            minimum,
            maximum_exclusive,
            reason: Some(reason),
        };
        if selector.version.is_none()
            && selector.version_range.is_none()
            && selector.minimum.is_none()
            && selector.maximum_exclusive.is_none()
        {
            return Err("known_incompatible object has no version selector".to_string());
        }
        if selector
            .version
            .as_ref()
            .is_some_and(|version| parse_version(version).is_none())
            || selector
                .version_range
                .as_ref()
                .is_some_and(|range| VersionReq::parse(range).is_err())
            || selector
                .minimum
                .as_ref()
                .is_some_and(|version| parse_version(version).is_none())
            || selector
                .maximum_exclusive
                .as_ref()
                .is_some_and(|version| parse_version(version).is_none())
        {
            return Err("known_incompatible contains an invalid SemVer selector".to_string());
        }
        Ok(selector)
    }

    fn matches(&self, actual_raw: &str, actual: &Version) -> bool {
        if self
            .version
            .as_ref()
            .is_some_and(|version| matches_version_selector(version, actual_raw, actual))
        {
            return true;
        }
        if self
            .version_range
            .as_ref()
            .and_then(|range| VersionReq::parse(range).ok())
            .is_some_and(|range| range.matches(actual))
        {
            return true;
        }
        let lower_matches = self
            .minimum
            .as_ref()
            .and_then(|minimum| parse_version(minimum))
            .is_none_or(|minimum| actual >= &minimum);
        let upper_matches = self
            .maximum_exclusive
            .as_ref()
            .and_then(|maximum| parse_version(maximum))
            .is_none_or(|maximum| actual < &maximum);
        (self.minimum.is_some() || self.maximum_exclusive.is_some())
            && lower_matches
            && upper_matches
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoreCompatibilityWarning {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoreCompatibilityReport {
    pub package: String,
    pub status: String,
    pub usable: bool,
    pub requires_revalidation: bool,
    pub installed_version: Option<String>,
    pub installed_versions: Vec<String>,
    pub recommended_version: Option<String>,
    pub recommended_version_installed: bool,
    #[serde(default)]
    pub warnings: Vec<CoreCompatibilityWarning>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BoardPassportProfile {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hardware_variant: Option<String>,
    #[serde(default)]
    pub options: BTreeMap<String, String>,
    #[serde(default)]
    pub smoke_tests: Vec<String>,
    pub fqbn: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub core_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toolchain_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_content_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BoardPassportIdentity {
    pub id: String,
    pub name: String,
    pub version: String,
    pub vendor: String,
    pub fqbn_base: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BoardPassport {
    pub schema_version: u32,
    pub generated_by: String,
    pub generated_at: String,
    #[serde(default)]
    pub certification_engine_contract: String,
    #[serde(default = "local_provenance")]
    pub evidence_provenance: String,
    pub board: BoardPassportIdentity,
    pub source_package_sha256: String,
    pub source_content_sha256: String,
    pub installed_content_sha256: String,
    pub menu_schema_sha256: String,
    pub core_requirement: ArduinoCoreRequirement,
    pub core: CoreCompatibilityReport,
    pub certification_status: String,
    #[serde(default)]
    pub invalidated_reasons: Vec<String>,
    pub profiles: Vec<BoardPassportProfile>,
}

pub fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Failed to open {} for hashing: {error}", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to hash {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

fn hash_parts(parts: &[(&str, &str)]) -> String {
    let mut digest = Sha256::new();
    for (name, value) in parts {
        digest.update(name.as_bytes());
        digest.update([0]);
        digest.update(value.as_bytes());
        digest.update([0xff]);
    }
    hex::encode(digest.finalize())
}

pub fn hash_installed_contents(
    board_root: &Path,
    board_library_root: Option<&Path>,
) -> Result<String, String> {
    let board_hash = package_quality::hash_package_contents(board_root)?;
    let library_hash = match board_library_root.filter(|path| path.is_dir()) {
        Some(path) => package_quality::hash_package_contents(path)?,
        None => "none".to_string(),
    };
    Ok(hash_parts(&[
        ("board", &board_hash),
        ("board-package-libraries", &library_hash),
    ]))
}

pub fn menu_schema_sha256(manifest: &Value) -> Result<String, String> {
    let schema = serde_json::json!({
        "custom_menus": manifest.get("custom_menus").cloned().unwrap_or(Value::Null),
        "profiles": manifest.get("profiles").cloned().unwrap_or(Value::Null),
        "validation_profiles": manifest.get("validation_profiles").cloned().unwrap_or(Value::Null),
        "validation_matrix": manifest.get("validation_matrix").cloned().unwrap_or(Value::Null),
    });
    let encoded = serde_json::to_vec(&schema)
        .map_err(|error| format!("Failed to encode board menu schema: {error}"))?;
    let mut digest = Sha256::new();
    digest.update(encoded);
    Ok(hex::encode(digest.finalize()))
}

fn parse_version(value: &str) -> Option<Version> {
    Version::parse(value.trim().trim_start_matches('v')).ok()
}

fn package_parts(package: &str) -> Option<(&str, &str)> {
    let mut parts = package.split(':');
    let vendor = parts.next()?.trim();
    let architecture = parts.next()?.trim();
    if vendor.is_empty() || architecture.is_empty() || parts.next().is_some() {
        return None;
    }
    Some((vendor, architecture))
}

pub fn installed_core_versions(sysroot: &Path, package: &str) -> Vec<String> {
    let Some((vendor, architecture)) = package_parts(package) else {
        return Vec::new();
    };
    let root = sysroot
        .join("packages")
        .join(vendor)
        .join("hardware")
        .join(architecture);
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut versions = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    // Keep Core ordering identical to the build engine.  Package folders can
    // contain strict SemVer as well as legacy/vendor version names, so use the
    // shared resolver rather than a second local comparator.
    ck_core::builder::core_version::sort_core_versions(&mut versions);
    versions.dedup();
    versions
}

fn matches_version_selector(selector: &str, actual_raw: &str, actual: &Version) -> bool {
    if selector.trim().eq_ignore_ascii_case(actual_raw.trim()) {
        return true;
    }
    if let Some(expected) = parse_version(selector) {
        return expected == *actual;
    }
    VersionReq::parse(selector.trim())
        .map(|requirement| requirement.matches(actual))
        .unwrap_or(false)
}

pub fn declared_version_block_reason(
    requirement: &ArduinoCoreRequirement,
    version_raw: &str,
) -> Option<String> {
    let actual = parse_version(version_raw)?;
    if requirement
        .min_version
        .as_ref()
        .and_then(|minimum| parse_version(minimum))
        .is_some_and(|minimum| actual < minimum)
    {
        return Some(format!(
            "version {} is below minimum {}",
            version_raw,
            requirement.min_version.as_deref().unwrap_or_default()
        ));
    }
    requirement
        .known_incompatible
        .iter()
        .find(|selector| selector.matches(version_raw, &actual))
        .map(|selector| {
            selector
                .reason
                .clone()
                .unwrap_or_else(|| "known incompatible".to_string())
        })
}

pub fn evaluate_core_compatibility(
    sysroot: &Path,
    requirement: &ArduinoCoreRequirement,
) -> CoreCompatibilityReport {
    let installed_versions = installed_core_versions(sysroot, &requirement.package);
    let recommended_version_installed =
        requirement
            .recommended_version
            .as_ref()
            .is_some_and(|recommended| {
                installed_versions.iter().any(|installed| {
                    match (parse_version(recommended), parse_version(installed)) {
                        (Some(recommended), Some(installed)) => recommended == installed,
                        _ => recommended == installed,
                    }
                })
            });
    let Some(installed_version) = installed_versions.last().cloned() else {
        return CoreCompatibilityReport {
            package: requirement.package.clone(),
            status: "missing".to_string(),
            usable: false,
            requires_revalidation: false,
            installed_version: None,
            installed_versions,
            recommended_version: requirement.recommended_version.clone(),
            recommended_version_installed,
            warnings: Vec::new(),
            message: format!("Arduino core '{}' is not installed.", requirement.package),
        };
    };
    let Some(actual) = parse_version(&installed_version) else {
        return CoreCompatibilityReport {
            package: requirement.package.clone(),
            status: "unparseable_installed_version".to_string(),
            usable: true,
            requires_revalidation: true,
            installed_version: Some(installed_version.clone()),
            installed_versions,
            recommended_version: requirement.recommended_version.clone(),
            recommended_version_installed,
            warnings: vec![CoreCompatibilityWarning {
                code: "unparseable_installed_version".to_string(),
                message: format!(
                    "Installed version '{}' cannot be compared as SemVer; automatic revalidation is required.",
                    installed_version
                ),
            }],
            message: format!(
                "Installed core version '{}' is not valid SemVer and cannot be certified.",
                installed_version
            ),
        };
    };

    let base = |status: &str, usable: bool, requires_revalidation: bool, message: String| {
        let warnings = if usable && requires_revalidation {
            vec![CoreCompatibilityWarning {
                code: status.to_string(),
                message: message.clone(),
            }]
        } else {
            Vec::new()
        };
        CoreCompatibilityReport {
            package: requirement.package.clone(),
            status: status.to_string(),
            usable,
            requires_revalidation,
            installed_version: Some(installed_version.clone()),
            installed_versions: installed_versions.clone(),
            recommended_version: requirement.recommended_version.clone(),
            recommended_version_installed,
            warnings,
            message,
        }
    };

    if let Some(incompatible) = requirement
        .known_incompatible
        .iter()
        .find(|selector| selector.matches(&installed_version, &actual))
    {
        return base(
            "known_incompatible",
            false,
            false,
            format!(
                "Installed core {}@{} is explicitly marked incompatible: {}",
                requirement.package,
                installed_version,
                incompatible
                    .reason
                    .as_deref()
                    .unwrap_or("no reason supplied")
            ),
        );
    }

    if let Some(minimum_raw) = &requirement.min_version {
        let Some(minimum) = parse_version(minimum_raw) else {
            return base(
                "invalid_requirement",
                true,
                true,
                format!("Invalid min_version '{}'.", minimum_raw),
            );
        };
        if actual < minimum {
            return base(
                "below_minimum",
                false,
                false,
                format!(
                    "Installed core {}@{} is below the supported minimum {}.",
                    requirement.package, installed_version, minimum_raw
                ),
            );
        }
    }
    if let Some(maximum_raw) = &requirement.max_version {
        let Some(maximum) = parse_version(maximum_raw) else {
            return base(
                "invalid_requirement",
                true,
                true,
                format!("Invalid max_version '{}'.", maximum_raw),
            );
        };
        if actual > maximum {
            return base(
                "above_maximum",
                true,
                true,
                format!(
                    "Installed core {}@{} is above the package's tested maximum {}; automatic revalidation is required.",
                    requirement.package, installed_version, maximum_raw
                ),
            );
        }
    }
    if let Some(maximum_raw) = &requirement.maximum_exclusive {
        let Some(maximum) = parse_version(maximum_raw) else {
            return base(
                "invalid_requirement",
                true,
                true,
                format!("Invalid maximum_exclusive '{}'.", maximum_raw),
            );
        };
        if actual >= maximum {
            return base(
                "above_tested_range",
                true,
                true,
                format!(
                    "Installed core {}@{} is outside the package's tested upper range (< {}); automatic revalidation is required.",
                    requirement.package, installed_version, maximum_raw
                ),
            );
        }
    }
    if let Some(range_raw) = &requirement.version_range {
        let Ok(range) = VersionReq::parse(range_raw) else {
            return base(
                "invalid_requirement",
                true,
                true,
                format!("Invalid version_range '{}'.", range_raw),
            );
        };
        if !range.matches(&actual) {
            return base(
                "outside_compatible_range",
                true,
                true,
                format!(
                    "Installed core {}@{} is outside declared tested range {}; automatic revalidation is required.",
                    requirement.package, installed_version, range_raw
                ),
            );
        }
    }

    let tested = requirement
        .tested_versions
        .iter()
        .any(|version| matches_version_selector(version, &installed_version, &actual));
    let recommended = requirement
        .recommended_version
        .as_ref()
        .is_some_and(|version| matches_version_selector(version, &installed_version, &actual));
    if tested {
        if recommended {
            return base(
                "recommended",
                true,
                false,
                format!(
                    "Installed core {}@{} is the recommended version.",
                    requirement.package, installed_version
                ),
            );
        }
        if requirement.recommended_version.is_some() {
            return base(
                "tested_non_recommended",
                true,
                true,
                format!(
                    "Installed core {}@{} is publisher-tested but differs from recommended {}; automatic local revalidation is required.",
                    requirement.package,
                    installed_version,
                    requirement
                        .recommended_version
                        .as_deref()
                        .unwrap_or_default()
                ),
            );
        }
        return base(
            "tested_compatible",
            true,
            false,
            format!(
                "Installed core {}@{} is in the board package tested set.",
                requirement.package, installed_version
            ),
        );
    }
    if recommended {
        return base(
            "recommended",
            true,
            false,
            format!(
                "Installed core {}@{} is the recommended version.",
                requirement.package, installed_version
            ),
        );
    }

    let has_version_policy = requirement.recommended_version.is_some()
        || requirement.version_range.is_some()
        || requirement.min_version.is_some()
        || requirement.max_version.is_some()
        || requirement.maximum_exclusive.is_some()
        || !requirement.tested_versions.is_empty();
    if !has_version_policy {
        return base(
            "unverified_compatibility",
            true,
            true,
            format!(
                "Arduino core {}@{} is installed, but the board package declares no compatibility policy; automatic revalidation is required.",
                requirement.package, installed_version
            ),
        );
    }

    let newer_than_known = requirement
        .recommended_version
        .iter()
        .chain(requirement.tested_versions.iter())
        .filter_map(|value| parse_version(value))
        .max()
        .is_some_and(|known| actual > known);
    let inside_declared_range = requirement.version_range.is_some()
        || requirement.maximum_exclusive.is_some()
        || requirement.max_version.is_some();
    base(
        if newer_than_known && !inside_declared_range {
            "newer_untested"
        } else {
            "compatible_untested"
        },
        true,
        true,
        format!(
            "Installed core {}@{} is allowed, but this exact version needs automatic revalidation.",
            requirement.package, installed_version
        ),
    )
}

fn selected_menu_options(manifest: &Value) -> Vec<(String, String)> {
    let mut selected = Vec::new();
    let Some(menus) = manifest.get("custom_menus").and_then(Value::as_object) else {
        return selected;
    };
    for (key, menu) in menus {
        let value = menu
            .get("selected")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                menu.get("options")
                    .and_then(Value::as_array)
                    .and_then(|options| options.first())
                    .and_then(|option| option.get("value"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
        if let Some(value) = value {
            selected.push((key.clone(), value));
        }
    }
    selected
}

fn fqbn_with_options(base: &str, options: &[(String, String)]) -> String {
    if options.is_empty() {
        base.to_string()
    } else {
        format!(
            "{}:{}",
            base,
            options
                .iter()
                .map(|(key, value)| format!("{}={}", key, value))
                .collect::<Vec<_>>()
                .join(",")
        )
    }
}

pub fn profiles_from_manifest(
    manifest: &Value,
    initial_status: &str,
) -> Result<Vec<BoardPassportProfile>, String> {
    let base = manifest
        .get("fqbn_base")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("board.json requires fqbn_base")?;
    let declared = manifest
        .get("validation_profiles")
        .or_else(|| manifest.get("profiles"))
        .and_then(Value::as_array);
    let mut profiles = Vec::new();
    if let Some(declared) = declared {
        for (index, profile) in declared.iter().enumerate() {
            let id = profile
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("profile-{}", index + 1));
            let name = profile
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(&id)
                .to_string();
            let hardware_variant = profile
                .get("hardware_variant")
                .and_then(Value::as_str)
                .map(str::to_string);
            let options = profile
                .get("options")
                .and_then(Value::as_object)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(|(key, value)| {
                            value.as_str().map(|value| (key.clone(), value.to_string()))
                        })
                        .collect::<BTreeMap<_, _>>()
                })
                .unwrap_or_else(|| selected_menu_options(manifest).into_iter().collect());
            let smoke_tests = profile
                .get("smoke_tests")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            let canonical_from_options = fqbn_with_options(
                base,
                &options
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect::<Vec<_>>(),
            );
            let fqbn = if let Some(fqbn) = profile.get("fqbn").and_then(Value::as_str) {
                let fqbn = fqbn.trim().to_string();
                if fqbn != canonical_from_options {
                    return Err(format!(
                        "Board profile '{}' explicit FQBN is not canonical or does not match its options (expected '{}').",
                        id, canonical_from_options
                    ));
                }
                fqbn
            } else {
                canonical_from_options
            };
            if fqbn != base && !fqbn.starts_with(&format!("{}:", base)) {
                return Err(format!(
                    "Board profile '{}' FQBN '{}' does not belong to base '{}'.",
                    id, fqbn, base
                ));
            }
            profiles.push(BoardPassportProfile {
                id,
                name,
                hardware_variant,
                options,
                smoke_tests,
                fqbn,
                status: initial_status.to_string(),
                checked_at: None,
                core_version: None,
                toolchain_key: None,
                installed_content_sha256: None,
                evidence: None,
            });
        }
    }
    if profiles.is_empty() {
        profiles.push(BoardPassportProfile {
            id: "default".to_string(),
            name: "Default".to_string(),
            hardware_variant: None,
            options: selected_menu_options(manifest).into_iter().collect(),
            smoke_tests: Vec::new(),
            fqbn: fqbn_with_options(base, &selected_menu_options(manifest)),
            status: initial_status.to_string(),
            checked_at: None,
            core_version: None,
            toolchain_key: None,
            installed_content_sha256: None,
            evidence: None,
        });
    }
    Ok(profiles)
}

pub fn create_passport(
    manifest: &Value,
    source_package_sha256: String,
    source_content_sha256: String,
    installed_content_sha256: String,
    core: CoreCompatibilityReport,
) -> Result<BoardPassport, String> {
    if !is_sha256(&source_package_sha256)
        || !is_sha256(&source_content_sha256)
        || !is_sha256(&installed_content_sha256)
    {
        return Err("Board passport content identities must be SHA-256 values".to_string());
    }
    let value = |key: &str| {
        manifest
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("board.json requires '{}'", key))
    };
    let requirement = ArduinoCoreRequirement::from_manifest_value(
        manifest
            .get("arduino_core")
            .ok_or("board.json requires arduino_core")?,
    )?;
    let initial_profile_status = if !core.usable {
        "blocked_core"
    } else if core.requires_revalidation {
        "pending_core_revalidation"
    } else {
        "pending_compile"
    };
    let certification_status = if !core.usable {
        "blocked_core"
    } else if core.requires_revalidation {
        "revalidation_required"
    } else {
        "structure_checked"
    };
    Ok(BoardPassport {
        schema_version: BOARD_LOCK_SCHEMA_VERSION,
        generated_by: "CK".to_string(),
        generated_at: Utc::now().to_rfc3339(),
        certification_engine_contract: ck_core::builder::demo::FAST_BUILD_CONTRACT_SIGNATURE_MARKER
            .to_string(),
        evidence_provenance: "local".to_string(),
        board: BoardPassportIdentity {
            id: value("id")?,
            name: value("name")?,
            version: value("version")?,
            vendor: manifest
                .get("vendor")
                .or_else(|| manifest.get("author"))
                .and_then(Value::as_str)
                .unwrap_or("Unknown vendor")
                .trim()
                .to_string(),
            fqbn_base: value("fqbn_base")?,
        },
        source_package_sha256,
        source_content_sha256,
        installed_content_sha256,
        menu_schema_sha256: menu_schema_sha256(manifest)?,
        core_requirement: requirement,
        core,
        certification_status: certification_status.to_string(),
        invalidated_reasons: Vec::new(),
        profiles: profiles_from_manifest(manifest, initial_profile_status)?,
    })
}

pub fn read_passport(board_root: &Path) -> Result<BoardPassport, String> {
    let path = board_root.join(BOARD_LOCK_FILE);
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Cannot read board passport {}: {error}", path.display()))?;
    let passport: BoardPassport = serde_json::from_str(&raw)
        .map_err(|error| format!("Invalid board passport {}: {error}", path.display()))?;
    if passport.schema_version != BOARD_LOCK_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported board passport schema {} (expected {}).",
            passport.schema_version, BOARD_LOCK_SCHEMA_VERSION
        ));
    }
    if !is_sha256(&passport.source_package_sha256)
        || !is_sha256(&passport.source_content_sha256)
        || !is_sha256(&passport.installed_content_sha256)
        || !is_sha256(&passport.menu_schema_sha256)
    {
        return Err("Board passport contains an invalid SHA-256 identity".to_string());
    }
    Ok(passport)
}

pub fn write_passport(board_root: &Path, passport: &BoardPassport) -> Result<(), String> {
    let payload = serde_json::to_vec_pretty(passport)
        .map_err(|error| format!("Cannot encode board passport: {error}"))?;
    let destination = board_root.join(BOARD_LOCK_FILE);
    let temporary = board_root.join(format!(".ck-lock-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, payload).map_err(|error| {
        format!(
            "Cannot write temporary board passport {}: {error}",
            temporary.display()
        )
    })?;
    if destination.exists() {
        fs::remove_file(&destination).map_err(|error| {
            format!(
                "Cannot replace board passport {}: {error}",
                destination.display()
            )
        })?;
    }
    fs::rename(&temporary, &destination).map_err(|error| {
        format!(
            "Cannot install board passport {}: {error}",
            destination.display()
        )
    })
}

fn invalidate_profiles(passport: &mut BoardPassport, status: &str) {
    for profile in &mut passport.profiles {
        if matches!(
            profile.status.as_str(),
            "compile_passed" | "device_verified" | "failed"
        ) {
            profile.status = status.to_string();
        } else if status == "blocked_core" {
            profile.status = status.to_string();
        }
    }
}

fn profile_evidence_is_well_formed(profile: &BoardPassportProfile) -> bool {
    let Some(evidence) = profile.evidence.as_ref().and_then(Value::as_object) else {
        return false;
    };
    if evidence.get("provenance").and_then(Value::as_str) != Some("local")
        || evidence
            .get("duration_ms")
            .and_then(Value::as_u64)
            .is_none()
    {
        return false;
    }
    match profile.status.as_str() {
        "compile_passed" => {
            let engine_contract_matches = evidence
                .get("certification_engine_contract")
                .and_then(Value::as_str)
                == Some(ck_core::builder::demo::FAST_BUILD_CONTRACT_SIGNATURE_MARKER);
            let toolchain_matches = evidence
                .get("toolchain_keys")
                .and_then(Value::as_array)
                .is_some_and(|keys| {
                    keys.len() == 1 && keys[0].as_str() == profile.toolchain_key.as_deref()
                });
            engine_contract_matches
                && evidence.get("kind").and_then(Value::as_str) == Some("compile-result")
                && evidence.get("stage").and_then(Value::as_str) == Some("compile")
                && evidence.get("canonical_fqbn").and_then(Value::as_str)
                    == Some(profile.fqbn.as_str())
                && toolchain_matches
                && evidence
                    .get("smoke_results")
                    .and_then(Value::as_array)
                    .is_some_and(|results| {
                        results.iter().any(|result| {
                            result["mode"].as_str() == Some("compile-only")
                                && result["status"].as_str() == Some("passed")
                        }) && results.iter().all(|result| {
                            if result["mode"].as_str() != Some("compile-only") {
                                return true;
                            }
                            let passed = result["status"].as_str() == Some("passed")
                                && result["toolchain_key"].as_str()
                                    == profile.toolchain_key.as_deref();
                            let requires_partition = profile.fqbn.split(':').nth(1)
                                == Some("esp32")
                                || profile.options.contains_key("PartitionScheme");
                            let partition_valid = !requires_partition
                                || result["partition_sha256"].as_str().is_some_and(|hash| {
                                    hash.len() == 64
                                        && hash.chars().all(|ch| ch.is_ascii_hexdigit())
                                });
                            passed && partition_valid
                        })
                    })
        }
        "device_verified" => {
            evidence.get("kind").and_then(Value::as_str) == Some("device-result")
                && matches!(
                    evidence.get("stage").and_then(Value::as_str),
                    Some("device" | "runtime")
                )
                && evidence.get("canonical_fqbn").and_then(Value::as_str)
                    == Some(profile.fqbn.as_str())
        }
        "failed" => matches!(
            evidence.get("kind").and_then(Value::as_str),
            Some("compile-result" | "device-result" | "environment-result")
        ),
        _ => true,
    }
}

pub fn evaluate_passport(
    mut passport: BoardPassport,
    manifest: &Value,
    board_root: &Path,
    board_library_root: Option<&Path>,
    sysroot: &Path,
) -> Result<BoardPassport, String> {
    passport.invalidated_reasons.clear();
    let current_engine_contract = ck_core::builder::demo::FAST_BUILD_CONTRACT_SIGNATURE_MARKER;
    if passport.certification_engine_contract != current_engine_contract {
        passport
            .invalidated_reasons
            .push("certification_engine_changed".to_string());
        passport.certification_engine_contract = current_engine_contract.to_string();
    }
    let manifest_text = |key: &str| {
        manifest
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
    };
    let manifest_vendor = manifest
        .get("vendor")
        .or_else(|| manifest.get("author"))
        .and_then(Value::as_str)
        .unwrap_or("Unknown vendor")
        .trim();
    if passport.board.id != manifest_text("id")
        || passport.board.name != manifest_text("name")
        || passport.board.version != manifest_text("version")
        || passport.board.vendor != manifest_vendor
        || passport.board.fqbn_base != manifest_text("fqbn_base")
    {
        return Err("Board passport identity does not match the installed board.json".to_string());
    }
    let manifest_requirement = ArduinoCoreRequirement::from_manifest_value(
        manifest
            .get("arduino_core")
            .ok_or("Installed board.json has no arduino_core contract")?,
    )?;
    if passport.core_requirement != manifest_requirement {
        passport
            .invalidated_reasons
            .push("core_requirement_changed".to_string());
        passport.core_requirement = manifest_requirement;
    }
    let expected_profiles = profiles_from_manifest(manifest, "pending_compile")?;
    let profile_contract_matches = passport.profiles.len() == expected_profiles.len()
        && passport
            .profiles
            .iter()
            .zip(expected_profiles.iter())
            .all(|(stored, expected)| {
                stored.id == expected.id
                    && stored.name == expected.name
                    && stored.hardware_variant == expected.hardware_variant
                    && stored.options == expected.options
                    && stored.smoke_tests == expected.smoke_tests
                    && stored.fqbn == expected.fqbn
            });
    if !profile_contract_matches || passport.profiles.is_empty() {
        return Err(
            "Board passport profiles do not match the installed validation_profiles contract"
                .to_string(),
        );
    }
    let installed_hash = hash_installed_contents(board_root, board_library_root)?;
    if installed_hash != passport.installed_content_sha256 {
        passport
            .invalidated_reasons
            .push("installed_content_changed".to_string());
    }
    let menu_hash = menu_schema_sha256(manifest)?;
    if menu_hash != passport.menu_schema_sha256 {
        passport
            .invalidated_reasons
            .push("menu_schema_changed".to_string());
    }
    if manifest.get("version").and_then(Value::as_str) != Some(passport.board.version.as_str()) {
        passport
            .invalidated_reasons
            .push("manifest_version_changed".to_string());
    }

    let current_core = evaluate_core_compatibility(sysroot, &passport.core_requirement);
    let core_version_changed = current_core.installed_version != passport.core.installed_version;
    passport.core = current_core;
    if !passport.core.usable {
        passport.certification_status = "blocked_core".to_string();
        passport
            .invalidated_reasons
            .push(format!("core_{}", passport.core.status));
        invalidate_profiles(&mut passport, "blocked_core");
    } else if !passport.invalidated_reasons.is_empty() {
        passport.certification_status = "expired".to_string();
        invalidate_profiles(&mut passport, "expired");
    } else {
        if core_version_changed {
            passport
                .invalidated_reasons
                .push("core_version_changed".to_string());
        }
        let expected_core = passport.core.installed_version.as_deref();
        let expected_content = passport.installed_content_sha256.as_str();
        let mut toolchain_changed = false;
        for profile in &mut passport.profiles {
            if profile.status == "blocked_core" {
                profile.status = "revalidation_required".to_string();
                continue;
            }
            let current_toolchain =
                ck_core::builder::demo::toolchain_cache_key_from_root(sysroot, &profile.fqbn);
            let recorded_result = matches!(
                profile.status.as_str(),
                "compile_passed" | "device_verified" | "failed"
            );
            if recorded_result
                && profile.toolchain_key.as_deref() != Some(current_toolchain.as_str())
            {
                toolchain_changed = true;
            }
            if recorded_result
                && (profile.core_version.as_deref() != expected_core
                    || profile.installed_content_sha256.as_deref() != Some(expected_content)
                    || profile.toolchain_key.as_deref() != Some(current_toolchain.as_str())
                    || !profile_evidence_is_well_formed(profile))
            {
                profile.status = "revalidation_required".to_string();
            }
        }
        if toolchain_changed {
            passport
                .invalidated_reasons
                .push("toolchain_changed".to_string());
        }
        let all_current = !passport.profiles.is_empty()
            && passport.profiles.iter().all(|profile| {
                let current_toolchain =
                    ck_core::builder::demo::toolchain_cache_key_from_root(sysroot, &profile.fqbn);
                matches!(
                    profile.status.as_str(),
                    "compile_passed" | "device_verified"
                ) && profile.core_version.as_deref() == expected_core
                    && profile.installed_content_sha256.as_deref() == Some(expected_content)
                    && profile.toolchain_key.as_deref() == Some(current_toolchain.as_str())
                    && profile_evidence_is_well_formed(profile)
            });
        passport.certification_status = if all_current {
            if passport
                .profiles
                .iter()
                .all(|profile| profile.status == "device_verified")
            {
                "device_verified"
            } else {
                "compile_certified"
            }
        } else if passport
            .profiles
            .iter()
            .any(|profile| profile.status == "failed")
        {
            "failed"
        } else if passport.profiles.iter().any(|profile| {
            matches!(
                profile.status.as_str(),
                "compile_passed" | "device_verified"
            )
        }) {
            "partially_certified"
        } else if core_version_changed
            || passport.core.requires_revalidation
            || passport
                .profiles
                .iter()
                .any(|profile| profile.status == "revalidation_required")
        {
            "revalidation_required"
        } else {
            passport.certification_status.as_str()
        }
        .to_string();
    }
    Ok(passport)
}

pub fn record_profile_result(
    board_root: &Path,
    board_library_root: Option<&Path>,
    sysroot: &Path,
    manifest: &Value,
    fqbn: &str,
    status: &str,
    evidence: Option<Value>,
) -> Result<BoardPassport, String> {
    if !matches!(status, "compile_passed" | "device_verified" | "failed") {
        return Err(format!(
            "Unsupported board profile result status '{}'.",
            status
        ));
    }
    let mut evidence = evidence.ok_or("Board profile results require local evidence metadata")?;
    let evidence_object = evidence
        .as_object_mut()
        .ok_or("Board profile evidence must be a JSON object")?;
    let kind = evidence_object
        .get("kind")
        .and_then(Value::as_str)
        .ok_or("Board profile evidence requires kind")?;
    if !matches!(
        kind,
        "compile-result" | "device-result" | "environment-result"
    ) {
        return Err(format!(
            "Unsupported board profile evidence kind '{}'.",
            kind
        ));
    }
    if !evidence_object
        .get("stage")
        .and_then(Value::as_str)
        .is_some_and(|stage| matches!(stage, "environment" | "compile" | "device" | "runtime"))
    {
        return Err("Board profile evidence requires a supported stage".to_string());
    }
    let stage = evidence_object
        .get("stage")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match status {
        "compile_passed" if kind != "compile-result" || stage != "compile" => {
            return Err("compile_passed requires compile-result evidence at compile stage".to_string())
        }
        "device_verified"
            if kind != "device-result" || !matches!(stage, "device" | "runtime") =>
        {
            return Err(
                "device_verified requires dedicated device-result evidence from a device/runtime stage"
                    .to_string(),
            )
        }
        _ => {}
    }
    if matches!(status, "compile_passed" | "device_verified")
        && evidence_object
            .get("canonical_fqbn")
            .and_then(Value::as_str)
            != Some(fqbn)
    {
        return Err("Board profile evidence canonical_fqbn does not match the profile".to_string());
    }
    let recorded_toolchain_key = evidence_object
        .get("toolchain_keys")
        .and_then(Value::as_array)
        .and_then(|keys| {
            (keys.len() == 1)
                .then(|| keys[0].as_str().map(str::to_string))
                .flatten()
        });
    if status == "compile_passed" {
        if evidence_object
            .get("certification_engine_contract")
            .and_then(Value::as_str)
            != Some(ck_core::builder::demo::FAST_BUILD_CONTRACT_SIGNATURE_MARKER)
        {
            return Err(
                "compile_passed evidence does not match the current certification engine contract"
                    .to_string(),
            );
        }
        let compile_smokes_valid = evidence_object
            .get("smoke_results")
            .and_then(Value::as_array)
            .is_some_and(|results| {
                results.iter().any(|result| {
                    result["mode"].as_str() == Some("compile-only")
                        && result["status"].as_str() == Some("passed")
                }) && results.iter().all(|result| {
                    result["mode"].as_str() != Some("compile-only")
                        || result["status"].as_str() == Some("passed")
                })
            });
        if recorded_toolchain_key.is_none() || !compile_smokes_valid {
            return Err(
                "compile_passed requires one toolchain key and successful compile-only smoke evidence"
                    .to_string(),
            );
        }
    }
    if evidence_object
        .get("duration_ms")
        .and_then(Value::as_u64)
        .is_none()
    {
        return Err("Board profile evidence requires duration_ms".to_string());
    }
    if evidence_object
        .get("provenance")
        .and_then(Value::as_str)
        .is_some_and(|provenance| provenance != "local")
    {
        return Err(
            "Local profile recording cannot issue publisher or CK certification evidence."
                .to_string(),
        );
    }
    evidence_object.insert("provenance".to_string(), Value::String("local".to_string()));
    let stored = read_passport(board_root)?;
    let evaluated = evaluate_passport(
        stored.clone(),
        manifest,
        board_root,
        board_library_root,
        sysroot,
    )?;
    if evaluated.invalidated_reasons.iter().any(|reason| {
        matches!(
            reason.as_str(),
            "installed_content_changed" | "menu_schema_changed" | "manifest_version_changed"
        )
    }) {
        return Err(format!(
            "Board passport content changed; re-import or regenerate it before recording certification: {}",
            evaluated.invalidated_reasons.join(", ")
        ));
    }
    if !evaluated.core.usable {
        return Err(format!(
            "Board profile cannot be certified with core status '{}': {}",
            evaluated.core.status, evaluated.core.message
        ));
    }

    let mut updated = evaluated;
    let profile = updated
        .profiles
        .iter_mut()
        .find(|profile| profile.fqbn == fqbn)
        .ok_or_else(|| format!("FQBN '{}' is not declared in this board passport.", fqbn))?;
    profile.status = status.to_string();
    profile.checked_at = Some(Utc::now().to_rfc3339());
    profile.core_version = updated.core.installed_version.clone();
    profile.toolchain_key =
        Some(recorded_toolchain_key.unwrap_or_else(|| {
            ck_core::builder::demo::toolchain_cache_key_from_root(sysroot, fqbn)
        }));
    profile.installed_content_sha256 = Some(updated.installed_content_sha256.clone());
    profile.evidence = Some(evidence);
    updated.invalidated_reasons.clear();
    updated.certification_status = if updated
        .profiles
        .iter()
        .any(|profile| profile.status == "failed")
    {
        "failed"
    } else if updated
        .profiles
        .iter()
        .all(|profile| profile.status == "device_verified")
    {
        "device_verified"
    } else if updated.profiles.iter().all(|profile| {
        matches!(
            profile.status.as_str(),
            "compile_passed" | "device_verified"
        )
    }) {
        "compile_certified"
    } else {
        "partially_certified"
    }
    .to_string();
    write_passport(board_root, &updated)?;
    Ok(updated)
}

pub fn board_manifest(board_root: &Path) -> Result<Value, String> {
    let path = board_root.join("board.json");
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    serde_json::from_str(raw.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("Invalid board.json at {}: {error}", path.display()))
}

pub fn board_root(boards_root: &Path, board_id: &str) -> Result<PathBuf, String> {
    if !package_quality::valid_package_id(board_id, false) {
        return Err("Invalid board id.".to_string());
    }
    Ok(boards_root.join(board_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ck_passport_{}_{}", name, uuid::Uuid::new_v4()))
    }

    fn requirement() -> ArduinoCoreRequirement {
        ArduinoCoreRequirement {
            package: "vendor:arch".to_string(),
            recommended_version: Some("2.0.0".to_string()),
            version_range: None,
            min_version: Some("1.5.0".to_string()),
            max_version: None,
            maximum_exclusive: None,
            tested_versions: vec!["2.0.0".to_string()],
            known_incompatible: vec![CoreIncompatibleSelector {
                version: Some("2.1.1".to_string()),
                version_range: None,
                minimum: None,
                maximum_exclusive: None,
                reason: Some("Known regression".to_string()),
            }],
            index_url: None,
        }
    }

    fn install_core(root: &Path, version: &str) {
        fs::create_dir_all(root.join("packages/vendor/hardware/arch").join(version)).unwrap();
    }

    fn manifest() -> Value {
        serde_json::json!({
            "schema_version": 1,
            "id": "vendor_board",
            "name": "Vendor board",
            "version": "1.0.0",
            "vendor": "Vendor",
            "fqbn_base": "vendor:arch:board",
            "arduino_core": {
                "package": "vendor:arch",
                "version": "2.0.0",
                "min_version": "1.5.0",
                "tested_versions": ["2.0.0"]
            },
            "custom_menus": {
                "FlashSize": {
                    "selected": "16M",
                    "options": [{"value": "8M"}, {"value": "16M"}]
                }
            }
        })
    }

    #[test]
    fn legacy_version_is_recommended_not_a_hard_lock() {
        let parsed = ArduinoCoreRequirement::from_manifest_value(&serde_json::json!({
            "package": "vendor:arch",
            "version": "2.0.0"
        }))
        .unwrap();
        assert_eq!(parsed.recommended_version.as_deref(), Some("2.0.0"));
        assert!(parsed.max_version.is_none());
    }

    #[test]
    fn newer_untested_core_is_allowed_but_requires_revalidation() {
        let root = temp_root("newer_core");
        install_core(&root, "2.2.0");
        let report = evaluate_core_compatibility(&root, &requirement());
        assert_eq!(report.status, "newer_untested");
        assert!(report.usable);
        assert!(report.requires_revalidation);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn object_range_maps_minimum_and_non_blocking_tested_ceiling() {
        let parsed = ArduinoCoreRequirement::from_manifest_value(&serde_json::json!({
            "package": "vendor:arch",
            "recommended_version": "2.0.0",
            "version_range": {
                "minimum": "1.5.0",
                "maximum_exclusive": "2.1.0"
            }
        }))
        .unwrap();
        assert_eq!(parsed.min_version.as_deref(), Some("1.5.0"));
        assert_eq!(parsed.maximum_exclusive.as_deref(), Some("2.1.0"));

        let root = temp_root("tested_ceiling");
        install_core(&root, "2.2.0");
        let report = evaluate_core_compatibility(&root, &parsed);
        assert_eq!(report.status, "above_tested_range");
        assert!(report.usable);
        assert!(report.requires_revalidation);
        assert_eq!(report.warnings[0].code, "above_tested_range");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unlisted_version_inside_declared_range_is_usable_and_revalidated() {
        let parsed = ArduinoCoreRequirement::from_manifest_value(&serde_json::json!({
            "package": "vendor:arch",
            "recommended_version": "2.0.0",
            "version_range": {
                "minimum": "1.5.0",
                "maximum_exclusive": "3.0.0"
            },
            "tested_versions": ["2.0.0"]
        }))
        .unwrap();
        let root = temp_root("inside_range");
        install_core(&root, "2.5.0");
        let report = evaluate_core_compatibility(&root, &parsed);
        assert_eq!(report.status, "compatible_untested");
        assert!(report.usable);
        assert!(report.requires_revalidation);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tested_but_non_recommended_and_policy_free_versions_need_revalidation() {
        let root = temp_root("non_recommended");
        install_core(&root, "1.9.0");
        let mut policy = requirement();
        policy.tested_versions = vec!["1.9.0".to_string(), "2.0.0".to_string()];
        let report = evaluate_core_compatibility(&root, &policy);
        assert_eq!(report.status, "tested_non_recommended");
        assert!(report.usable);
        assert!(report.requires_revalidation);
        assert!(!report.warnings.is_empty());

        let no_policy = ArduinoCoreRequirement {
            package: "vendor:arch".to_string(),
            recommended_version: None,
            version_range: None,
            min_version: None,
            max_version: None,
            maximum_exclusive: None,
            tested_versions: Vec::new(),
            known_incompatible: Vec::new(),
            index_url: None,
        };
        let report = evaluate_core_compatibility(&root, &no_policy);
        assert_eq!(report.status, "unverified_compatibility");
        assert!(report.usable && report.requires_revalidation);
        assert!(!report.warnings.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn object_incompatibility_range_blocks_and_preserves_reason() {
        let parsed = ArduinoCoreRequirement::from_manifest_value(&serde_json::json!({
            "package": "vendor:arch",
            "recommended_version": "2.0.0",
            "known_incompatible": [{
                "version_range": {
                    "minimum": "2.1.0",
                    "maximum_exclusive": "2.2.0"
                },
                "reason": "Partition generator regression"
            }]
        }))
        .unwrap();
        let root = temp_root("incompatible_range");
        install_core(&root, "2.1.5");
        let report = evaluate_core_compatibility(&root, &parsed);
        assert_eq!(report.status, "known_incompatible");
        assert!(!report.usable);
        assert!(report.message.contains("Partition generator regression"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn explicit_incompatibility_and_minimum_are_blocking() {
        let incompatible = temp_root("incompatible");
        install_core(&incompatible, "2.1.1");
        let report = evaluate_core_compatibility(&incompatible, &requirement());
        assert_eq!(report.status, "known_incompatible");
        assert!(!report.usable);

        let old = temp_root("old");
        install_core(&old, "1.4.9");
        let report = evaluate_core_compatibility(&old, &requirement());
        assert_eq!(report.status, "below_minimum");
        assert!(!report.usable);
        let _ = fs::remove_dir_all(incompatible);
        let _ = fs::remove_dir_all(old);
    }

    #[test]
    fn installed_core_version_hard_blocks_are_limited_to_minimum_and_known_incompatible() {
        let cases = [
            ("1.4.9", "below_minimum", false, false),
            ("1.5.0", "compatible_untested", true, true),
            ("2.0.0", "recommended", true, false),
            ("2.0.1", "newer_untested", true, true),
            ("2.1.1", "known_incompatible", false, false),
            ("3.0.0", "newer_untested", true, true),
        ];

        for (version, expected_status, expected_usable, expected_revalidation) in cases {
            let root = temp_root(&format!("core_gate_{}", version.replace('.', "_")));
            install_core(&root, version);
            let report = evaluate_core_compatibility(&root, &requirement());
            assert_eq!(report.status, expected_status, "version {version}");
            assert_eq!(report.usable, expected_usable, "version {version}");
            assert_eq!(
                report.requires_revalidation, expected_revalidation,
                "version {version}"
            );
            assert_eq!(
                report.warnings.is_empty(),
                !expected_revalidation,
                "version {version}"
            );
            let _ = fs::remove_dir_all(root);
        }

        let missing = temp_root("core_gate_missing");
        let report = evaluate_core_compatibility(&missing, &requirement());
        assert_eq!(report.status, "missing");
        assert!(
            !report.usable,
            "a missing core is an unavailable environment"
        );
        let _ = fs::remove_dir_all(missing);
    }

    #[test]
    fn tested_ceiling_range_misses_and_invalid_policy_are_warnings_not_blocks() {
        let cases = [
            (
                ArduinoCoreRequirement {
                    max_version: Some("2.0.0".to_string()),
                    ..requirement()
                },
                "2.0.1",
                "above_maximum",
            ),
            (
                ArduinoCoreRequirement {
                    maximum_exclusive: Some("2.1.0".to_string()),
                    ..requirement()
                },
                "2.1.0",
                "above_tested_range",
            ),
            (
                ArduinoCoreRequirement {
                    version_range: Some(">=1.5.0, <2.1.0".to_string()),
                    ..requirement()
                },
                "2.2.0",
                "outside_compatible_range",
            ),
            (
                ArduinoCoreRequirement {
                    min_version: Some("not-semver".to_string()),
                    ..requirement()
                },
                "2.0.0",
                "invalid_requirement",
            ),
        ];

        for (policy, version, expected_status) in cases {
            let root = temp_root(&format!("core_warning_{}", expected_status));
            install_core(&root, version);
            let report = evaluate_core_compatibility(&root, &policy);
            assert_eq!(report.status, expected_status);
            assert!(report.usable, "{expected_status} must not block");
            assert!(report.requires_revalidation, "{expected_status}");
            assert_eq!(report.warnings.len(), 1, "{expected_status}");
            let _ = fs::remove_dir_all(root);
        }

        let root = temp_root("core_warning_unparseable");
        install_core(&root, "nightly-build");
        let report = evaluate_core_compatibility(&root, &requirement());
        assert_eq!(report.status, "unparseable_installed_version");
        assert!(report.usable);
        assert!(report.requires_revalidation);
        assert_eq!(report.warnings.len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn default_profile_contains_selected_menu_values() {
        let profiles = profiles_from_manifest(&manifest(), "pending_compile").unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].fqbn, "vendor:arch:board:FlashSize=16M");
    }

    #[test]
    fn serialized_passport_uses_the_documented_single_field_set() {
        let root = temp_root("serialized_shape");
        install_core(&root, "2.0.0");
        let passport = create_passport(
            &manifest(),
            "a".repeat(64),
            "b".repeat(64),
            "c".repeat(64),
            evaluate_core_compatibility(&root, &requirement()),
        )
        .unwrap();
        let value = serde_json::to_value(passport).unwrap();
        for key in [
            "schema_version",
            "generated_by",
            "generated_at",
            "certification_engine_contract",
            "evidence_provenance",
            "board",
            "source_package_sha256",
            "source_content_sha256",
            "installed_content_sha256",
            "menu_schema_sha256",
            "core_requirement",
            "core",
            "certification_status",
            "invalidated_reasons",
            "profiles",
        ] {
            assert!(value.get(key).is_some(), "missing serialized key {key}");
        }
        assert_eq!(value["evidence_provenance"], "local");
        assert_eq!(value["core"]["installed_version"], "2.0.0");
        assert!(value.get("validation_records").is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn installed_content_change_expires_a_passport() {
        let root = temp_root("content_expiry");
        let board = root.join("board");
        fs::create_dir_all(&board).unwrap();
        fs::write(
            board.join("board.json"),
            serde_json::to_vec_pretty(&manifest()).unwrap(),
        )
        .unwrap();
        fs::write(board.join("asset.txt"), "original").unwrap();
        install_core(&root, "2.0.0");
        let installed_hash = hash_installed_contents(&board, None).unwrap();
        let core = evaluate_core_compatibility(&root, &requirement());
        let passport = create_passport(
            &manifest(),
            "a".repeat(64),
            "b".repeat(64),
            installed_hash,
            core,
        )
        .unwrap();
        write_passport(&board, &passport).unwrap();

        fs::write(board.join("asset.txt"), "modified").unwrap();
        let evaluated = evaluate_passport(
            read_passport(&board).unwrap(),
            &manifest(),
            &board,
            None,
            &root,
        )
        .unwrap();
        assert_eq!(evaluated.certification_status, "expired");
        assert!(
            evaluated
                .invalidated_reasons
                .contains(&"installed_content_changed".to_string())
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn current_compile_evidence_survives_a_core_warning() {
        let root = temp_root("warning_evidence");
        let board = root.join("board");
        fs::create_dir_all(&board).unwrap();
        fs::write(
            board.join("board.json"),
            serde_json::to_vec_pretty(&manifest()).unwrap(),
        )
        .unwrap();
        install_core(&root, "2.2.0");
        let installed_hash = hash_installed_contents(&board, None).unwrap();
        let core = evaluate_core_compatibility(&root, &requirement());
        assert!(core.requires_revalidation);
        let mut passport = create_passport(
            &manifest(),
            "a".repeat(64),
            "b".repeat(64),
            installed_hash.clone(),
            core,
        )
        .unwrap();
        passport.profiles[0].status = "compile_passed".to_string();
        passport.profiles[0].core_version = Some("2.2.0".to_string());
        passport.profiles[0].installed_content_sha256 = Some(installed_hash);
        let toolchain_key = ck_core::builder::demo::toolchain_cache_key_from_root(
            &root,
            &passport.profiles[0].fqbn,
        );
        passport.profiles[0].toolchain_key = Some(toolchain_key.clone());
        passport.profiles[0].evidence = Some(serde_json::json!({
            "kind": "compile-result",
            "provenance": "local",
            "stage": "compile",
            "certification_engine_contract":
                ck_core::builder::demo::FAST_BUILD_CONTRACT_SIGNATURE_MARKER,
            "duration_ms": 1,
            "canonical_fqbn": passport.profiles[0].fqbn,
            "toolchain_keys": [toolchain_key],
            "smoke_results": [{
                "mode": "compile-only",
                "status": "passed",
                "toolchain_key": passport.profiles[0].toolchain_key
            }]
        }));
        passport.certification_status = "compile_certified".to_string();

        let mut legacy_engine_passport = passport.clone();
        legacy_engine_passport.certification_engine_contract.clear();
        let evaluated = evaluate_passport(passport, &manifest(), &board, None, &root).unwrap();
        assert_eq!(evaluated.certification_status, "compile_certified");
        assert_eq!(evaluated.profiles[0].status, "compile_passed");
        assert!(evaluated.core.requires_revalidation);
        assert!(evaluated.invalidated_reasons.is_empty());

        let mut changed_toolchain = evaluated.clone();
        changed_toolchain.profiles[0].toolchain_key = Some("previous-toolchain".to_string());
        let changed_toolchain =
            evaluate_passport(changed_toolchain, &manifest(), &board, None, &root).unwrap();
        assert_eq!(
            changed_toolchain.certification_status,
            "revalidation_required"
        );
        assert!(
            changed_toolchain
                .invalidated_reasons
                .contains(&"toolchain_changed".to_string())
        );

        let expired =
            evaluate_passport(legacy_engine_passport, &manifest(), &board, None, &root).unwrap();
        assert_eq!(expired.certification_status, "expired");
        assert_eq!(expired.profiles[0].status, "expired");
        assert!(
            expired
                .invalidated_reasons
                .contains(&"certification_engine_changed".to_string())
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn repaired_or_changed_core_turns_blocked_and_failed_profiles_into_revalidation() {
        let root = temp_root("repaired_core");
        let board = root.join("board");
        fs::create_dir_all(&board).unwrap();
        fs::write(
            board.join("board.json"),
            serde_json::to_vec_pretty(&manifest()).unwrap(),
        )
        .unwrap();
        let installed_hash = hash_installed_contents(&board, None).unwrap();
        let missing_core = evaluate_core_compatibility(&root, &requirement());
        let blocked = create_passport(
            &manifest(),
            "a".repeat(64),
            "b".repeat(64),
            installed_hash.clone(),
            missing_core,
        )
        .unwrap();
        assert_eq!(blocked.profiles[0].status, "blocked_core");
        install_core(&root, "2.0.0");
        let repaired = evaluate_passport(blocked, &manifest(), &board, None, &root).unwrap();
        assert_eq!(repaired.certification_status, "revalidation_required");
        assert_eq!(repaired.profiles[0].status, "revalidation_required");

        let mut failed = repaired;
        failed.profiles[0].status = "failed".to_string();
        failed.profiles[0].checked_at = Some(Utc::now().to_rfc3339());
        failed.profiles[0].core_version = Some("2.0.0".to_string());
        failed.profiles[0].installed_content_sha256 = Some(installed_hash);
        failed.profiles[0].toolchain_key = Some(
            ck_core::builder::demo::toolchain_cache_key_from_root(&root, &failed.profiles[0].fqbn),
        );
        failed.profiles[0].evidence = Some(serde_json::json!({
            "kind": "environment-result",
            "provenance": "local",
            "stage": "environment",
            "duration_ms": 1
        }));
        install_core(&root, "2.2.0");
        let changed = evaluate_passport(failed, &manifest(), &board, None, &root).unwrap();
        assert_eq!(changed.profiles[0].status, "revalidation_required");
        assert_ne!(changed.certification_status, "failed");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn board_json_remains_authoritative_over_edited_lock_policy_and_identity() {
        let root = temp_root("manifest_authority");
        let board = root.join("board");
        fs::create_dir_all(&board).unwrap();
        fs::write(
            board.join("board.json"),
            serde_json::to_vec_pretty(&manifest()).unwrap(),
        )
        .unwrap();
        install_core(&root, "2.0.0");
        let mut passport = create_passport(
            &manifest(),
            "a".repeat(64),
            "b".repeat(64),
            hash_installed_contents(&board, None).unwrap(),
            evaluate_core_compatibility(&root, &requirement()),
        )
        .unwrap();
        passport.core_requirement.min_version = None;
        let evaluated =
            evaluate_passport(passport.clone(), &manifest(), &board, None, &root).unwrap();
        assert!(
            evaluated
                .invalidated_reasons
                .contains(&"core_requirement_changed".to_string())
        );
        assert_eq!(
            evaluated.core_requirement.min_version.as_deref(),
            Some("1.5.0")
        );

        passport.board.id = "forged".to_string();
        assert!(evaluate_passport(passport, &manifest(), &board, None, &root).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
