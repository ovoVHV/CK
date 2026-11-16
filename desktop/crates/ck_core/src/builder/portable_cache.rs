//! Portable compiler-cache helpers.
//!
//! `ccache` deliberately emits GNU Make-compatible dependency files. On
//! Windows that spelling differs from the dependency files produced by the
//! compiler directly: drive colons are escaped, path separators may be doubled
//! and cache-restored paths may have compiler-specific spelling. Arduino CLI's
//! Windows incremental builder expects the compiler's native spelling, so a
//! cache hit can otherwise be followed by a needless rebuild.
//!
//! This module only normalizes a dependency file when its target has the
//! unambiguous ccache/GNU Make Windows drive prefix (`C\:\\...`). Unknown or
//! multi-rule dependency files remain untouched. Relative dependencies must
//! resolve lexically inside the trusted sysroot.

use std::collections::BTreeMap;
use std::path::Path;

use sha2::{Digest, Sha256};
use thiserror::Error;

/// Internal cache-schema marker. It is included in CK build/Core identities so
/// artifacts authenticated before namespace isolation cannot become Exact or
/// prebuilt-cache hits after this safety change.
pub const FAST_PROFILE_CCACHE_NAMESPACE_SCHEMA: &str =
    "ck-fast-ccache-namespace-v3:no-basedir,no-system-headers,no-time-macros";

/// Host syntax used for dependency-file normalization.
///
/// The explicit value keeps the pure transformation testable on non-Windows
/// hosts without making the production entry point platform-dependent in tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DepfileHost {
    Windows,
    Other,
}

impl DepfileHost {
    pub const fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Other
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DepfileNormalization {
    /// The input was not an unambiguous Windows ccache dependency file, or the
    /// current host is not Windows.
    Unchanged,
    /// The complete replacement payload. Callers can commit this atomically
    /// after applying their own build-root and regular-file checks.
    Rewritten {
        contents: String,
        rewritten_paths: usize,
    },
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PortableCacheError {
    #[error("Windows ccache depfile has more than one Make rule")]
    MultipleRules,
    #[error("Windows ccache depfile target is malformed")]
    InvalidTarget,
    #[error("trusted Windows path is not absolute: {0}")]
    TrustedPathNotAbsolute(String),
    #[error("Windows path escapes its drive root: {0}")]
    PathEscapesDrive(String),
    #[error("relative ccache dependency escapes the trusted sysroot: {0}")]
    DependencyEscapesSysroot(String),
    #[error("unsupported character in dependency path")]
    UnsupportedPathCharacter,
}

/// Normalize one dependency-file payload for the current host.
pub fn normalize_ccache_depfile_text(
    contents: &str,
    sysroot: &Path,
    command_directory: &Path,
) -> Result<DepfileNormalization, PortableCacheError> {
    normalize_ccache_depfile_text_for_host(
        contents,
        sysroot,
        command_directory,
        DepfileHost::current(),
    )
}

/// Pure, host-selectable form of [`normalize_ccache_depfile_text`].
///
/// `command_directory` must be the directory in which the compiler command
/// ran. Relative dependency paths are resolved from that directory, not from
/// the directory containing the `.d` file.
pub fn normalize_ccache_depfile_text_for_host(
    contents: &str,
    sysroot: &Path,
    command_directory: &Path,
    host: DepfileHost,
) -> Result<DepfileNormalization, PortableCacheError> {
    if host != DepfileHost::Windows {
        return Ok(DepfileNormalization::Unchanged);
    }

    let logical = contents.replace("\\\r\n", " ").replace("\\\n", " ");
    if logical
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count()
        != 1
    {
        // A ccache marker plus additional phony rules cannot be rewritten by a
        // one-rule renderer without changing Make semantics.
        if first_rule_has_ccache_target(&logical) {
            return Err(PortableCacheError::MultipleRules);
        }
        return Ok(DepfileNormalization::Unchanged);
    }

    let Some(delimiter) = make_rule_delimiter(&logical) else {
        return Ok(DepfileNormalization::Unchanged);
    };
    let raw_target = logical[..delimiter].trim();
    if !is_ccache_escaped_windows_drive(raw_target) {
        return Ok(DepfileNormalization::Unchanged);
    }

    let target = unescape_make_path(raw_target)?;
    let target = normalize_absolute_windows_path(&target)?;
    let dependencies = parse_make_paths(&logical[delimiter + 1..])?;
    if dependencies.is_empty() {
        return Err(PortableCacheError::InvalidTarget);
    }

    let sysroot = normalize_absolute_windows_path(&path_text(sysroot))?;
    let command_directory = normalize_absolute_windows_path(&path_text(command_directory))?;
    let mut normalized_dependencies = Vec::with_capacity(dependencies.len());
    for dependency in dependencies {
        let dependency = if is_absolute_windows_path(&dependency) {
            normalize_absolute_windows_path(&dependency)?
        } else {
            let resolved = normalize_absolute_windows_path(&format!(
                "{}\\{}",
                command_directory.trim_end_matches('\\'),
                dependency
            ))?;
            if !windows_path_is_within(&resolved, &sysroot) {
                return Err(PortableCacheError::DependencyEscapesSysroot(dependency));
            }
            resolved
        };
        normalized_dependencies.push(dependency);
    }

    let mut rewritten = String::new();
    rewritten.push_str(&escape_native_make_path(&target)?);
    rewritten.push(':');
    for dependency in &normalized_dependencies {
        rewritten.push_str(" \\\n ");
        rewritten.push_str(&escape_native_make_path(dependency)?);
    }
    rewritten.push('\n');

    Ok(DepfileNormalization::Rewritten {
        contents: rewritten,
        rewritten_paths: normalized_dependencies.len().saturating_add(1),
    })
}

/// Derive a bounded, stable ccache namespace for one exact fast-build lane.
///
/// ccache's own command hash does not know about CK's strong Core/toolchain
/// identity or fast-build contract. Keeping those values in the namespace
/// prevents a newly qualified Core from consuming objects created by an older
/// in-place Core/toolchain or by a different CK compiler contract. The complete
/// canonical FQBN keeps board menu selections (Flash size, partition scheme,
/// CPU, etc.) isolated even when their compiler command happens to look alike.
pub fn fast_profile_ccache_namespace(
    toolchain_key: &str,
    canonical_fqbn: &str,
    profile_id: &str,
    contract_id: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(FAST_PROFILE_CCACHE_NAMESPACE_SCHEMA.as_bytes());
    hasher.update(b"\0");
    for value in [toolchain_key, canonical_fqbn, profile_id, contract_id] {
        hasher.update((value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }
    format!("ck-fast-v1-{}", hex::encode(hasher.finalize()))
}

/// Recommended command-scoped environment for CK fast profiles.
///
/// PortableFast disables hard links because an older cache-entry mtime can
/// defeat Arduino's incremental check. Qualified direct-link profiles may opt
/// into hard links because they validate and consume objects directly.
pub fn fast_profile_ccache_env(
    sysroot: &Path,
    namespace: &str,
    allow_hardlinks: bool,
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    env.insert(
        "CCACHE_DIR".into(),
        sysroot
            .join("cache")
            .join("ccache")
            .to_string_lossy()
            .into(),
    );
    // Do not set CCACHE_BASEDIR. It rewrites compiler input paths and therefore
    // changes `__FILE__` bytes in Core/library objects for toolchains that use
    // that macro. Exact artifacts must remain byte-for-byte CLI compatible.
    env.insert("CCACHE_NAMESPACE".into(), namespace.to_string());
    env.insert("CCACHE_MAXSIZE".into(), "5G".into());
    env.insert("CCACHE_DEPEND".into(), "true".into());
    env.insert("CCACHE_NOHASHDIR".into(), "true".into());
    env.insert("CCACHE_COMPILERCHECK".into(), "mtime".into());
    // ccache treats CCACHE_HARDLINK as a presence-style boolean and rejects
    // the string "false". Use the documented negative variable instead.
    if allow_hardlinks {
        env.insert("CCACHE_HARDLINK".into(), "true".into());
    } else {
        env.insert("CCACHE_NOHARDLINK".into(), "true".into());
    }
    env.insert("CCACHE_INODECACHE".into(), "true".into());
    env.insert(
        "CCACHE_SLOPPINESS".into(),
        // `system_headers` is intentionally absent. Core/toolchain headers are
        // compile inputs: if one changes, ccache must not return an object made
        // from its previous bytes. `time_macros` is intentionally absent too:
        // `__DATE__` and `__TIME__` must participate in the cache key.
        "pch_defines,include_file_mtime,include_file_ctime,locale".into(),
    );
    env
}

/// PortableFast uses copy-mode cache hits so restored objects receive a fresh
/// mtime compatible with Arduino CLI's timestamp-based incremental builder.
pub fn portable_fast_ccache_env(sysroot: &Path, namespace: &str) -> BTreeMap<String, String> {
    fast_profile_ccache_env(sysroot, namespace, false)
}

fn first_rule_has_ccache_target(contents: &str) -> bool {
    let first = contents.lines().find(|line| !line.trim().is_empty());
    let Some(line) = first else {
        return false;
    };
    make_rule_delimiter(line)
        .map(|delimiter| is_ccache_escaped_windows_drive(line[..delimiter].trim()))
        .unwrap_or(false)
}

fn make_rule_delimiter(contents: &str) -> Option<usize> {
    contents.char_indices().find_map(|(index, character)| {
        if character != ':' {
            return None;
        }
        contents[index + character.len_utf8()..]
            .chars()
            .next()
            .is_some_and(char::is_whitespace)
            .then_some(index)
    })
}

fn is_ccache_escaped_windows_drive(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 4
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b'\\'
        && bytes[2] == b':'
        && matches!(bytes[3], b'\\' | b'/')
}

fn parse_make_paths(contents: &str) -> Result<Vec<String>, PortableCacheError> {
    let mut paths = Vec::new();
    let mut token = String::new();
    let mut chars = contents.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\\'
            && chars
                .peek()
                .is_some_and(|next| next.is_whitespace() || matches!(next, '\\' | ':' | '#'))
        {
            if let Some(escaped) = chars.next() {
                token.push(escaped);
            }
        } else if character.is_whitespace() {
            if !token.is_empty() {
                paths.push(std::mem::take(&mut token));
            }
        } else {
            token.push(character);
        }
    }
    if !token.is_empty() {
        paths.push(token);
    }
    if paths.iter().any(|path| path.contains(['\0', '\r', '\n'])) {
        return Err(PortableCacheError::UnsupportedPathCharacter);
    }
    Ok(paths)
}

fn unescape_make_path(value: &str) -> Result<String, PortableCacheError> {
    let mut parsed = parse_make_paths(value)?;
    if parsed.len() != 1 {
        return Err(PortableCacheError::InvalidTarget);
    }
    Ok(parsed.remove(0))
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\")
}

fn is_absolute_windows_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

fn normalize_absolute_windows_path(value: &str) -> Result<String, PortableCacheError> {
    if !is_absolute_windows_path(value) {
        return Err(PortableCacheError::TrustedPathNotAbsolute(
            value.to_string(),
        ));
    }
    if value.contains(['\0', '\r', '\n', '$']) {
        return Err(PortableCacheError::UnsupportedPathCharacter);
    }

    let normalized = value.replace('/', "\\");
    let drive = normalized[..2].to_string();
    let mut components = Vec::new();
    for component in normalized[2..].split('\\') {
        match component {
            "" | "." => {}
            ".." => {
                if components.pop().is_none() {
                    return Err(PortableCacheError::PathEscapesDrive(value.to_string()));
                }
            }
            other => components.push(other),
        }
    }

    if components.is_empty() {
        Ok(format!("{drive}\\"))
    } else {
        Ok(format!("{drive}\\{}", components.join("\\")))
    }
}

fn windows_path_is_within(path: &str, root: &str) -> bool {
    let path = path.to_ascii_lowercase();
    let root = root.trim_end_matches('\\').to_ascii_lowercase();
    path == root
        || path
            .strip_prefix(&root)
            .is_some_and(|remaining| remaining.starts_with('\\'))
}

fn escape_native_make_path(path: &str) -> Result<String, PortableCacheError> {
    if path.contains(['\0', '\r', '\n', '$']) {
        return Err(PortableCacheError::UnsupportedPathCharacter);
    }
    let mut escaped = String::with_capacity(path.len());
    for character in path.chars() {
        match character {
            ' ' | '\t' | '#' => {
                escaped.push('\\');
                escaped.push(character);
            }
            other => escaped.push(other),
        }
    }
    Ok(escaped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rewritten(result: DepfileNormalization) -> String {
        match result {
            DepfileNormalization::Rewritten { contents, .. } => contents,
            DepfileNormalization::Unchanged => panic!("expected rewritten depfile"),
        }
    }

    #[test]
    fn normalizes_stm32_ccache_drive_and_basedir_paths() {
        let raw = concat!(
            "C\\:\\\\Users\\\\AI\\\\AppData\\\\Local\\\\Temp\\\\build\\\\core\\\\board.c.o: \\\n",
            " packages\\\\STMicroelectronics\\\\hardware\\\\stm32\\\\2.12.0\\\\cores\\\\arduino\\\\board.c \\\n",
            " packages\\STMicroelectronics\\hardware\\stm32\\2.12.0\\cores\\arduino\\board.h\n",
        );
        let result = normalize_ccache_depfile_text_for_host(
            raw,
            Path::new(r"C:\Users\AI\Documents\CK"),
            Path::new(r"C:\Users\AI\Documents\CK"),
            DepfileHost::Windows,
        )
        .unwrap();
        assert_eq!(
            rewritten(result),
            concat!(
                "C:\\Users\\AI\\AppData\\Local\\Temp\\build\\core\\board.c.o: \\\n",
                " C:\\Users\\AI\\Documents\\CK\\packages\\STMicroelectronics\\hardware\\stm32\\2.12.0\\cores\\arduino\\board.c \\\n",
                " C:\\Users\\AI\\Documents\\CK\\packages\\STMicroelectronics\\hardware\\stm32\\2.12.0\\cores\\arduino\\board.h\n",
            )
        );
    }

    #[test]
    fn resolves_esp32_basedir_paths_against_command_directory() {
        let raw = concat!(
            "C\\:\\\\Temp\\\\build\\\\core\\\\base64.cpp.o: \\\n",
            " ..\\\\..\\\\packages\\\\esp32\\\\hardware\\\\esp32\\\\3.3.6\\\\cores\\\\esp32\\\\base64.cpp\n",
        );
        let result = normalize_ccache_depfile_text_for_host(
            raw,
            Path::new(r"C:\Users\AI\Documents\CK"),
            Path::new(r"C:\Users\AI\Documents\CK\target\release"),
            DepfileHost::Windows,
        )
        .unwrap();
        assert!(rewritten(result).contains(
            r"C:\Users\AI\Documents\CK\packages\esp32\hardware\esp32\3.3.6\cores\esp32\base64.cpp"
        ));
    }

    #[test]
    fn normalized_native_depfile_is_idempotent() {
        let raw = concat!(
            "C:\\Temp\\build\\core\\board.c.o: \\\n",
            " C:\\Users\\AI\\Documents\\CK\\packages\\vendor\\board.c\n",
        );
        assert_eq!(
            normalize_ccache_depfile_text_for_host(
                raw,
                Path::new(r"C:\Users\AI\Documents\CK"),
                Path::new(r"C:\Users\AI\Documents\CK"),
                DepfileHost::Windows,
            )
            .unwrap(),
            DepfileNormalization::Unchanged
        );
    }

    #[test]
    fn non_windows_host_is_a_strict_noop() {
        let raw = "C\\:\\\\Temp\\\\build\\\\x.o: packages\\\\vendor\\\\x.c\n";
        assert_eq!(
            normalize_ccache_depfile_text_for_host(
                raw,
                Path::new(r"C:\CK"),
                Path::new(r"C:\CK"),
                DepfileHost::Other,
            )
            .unwrap(),
            DepfileNormalization::Unchanged
        );
    }

    #[test]
    fn relative_dependency_cannot_escape_the_sysroot() {
        let raw = "C\\:\\\\Temp\\\\build\\\\x.o: ..\\\\..\\\\..\\\\secret.h\n";
        let error = normalize_ccache_depfile_text_for_host(
            raw,
            Path::new(r"C:\CK"),
            Path::new(r"C:\CK\target\release"),
            DepfileHost::Windows,
        )
        .unwrap_err();
        assert!(matches!(
            error,
            PortableCacheError::DependencyEscapesSysroot(_)
        ));
    }

    #[test]
    fn multi_rule_ccache_depfile_is_rejected_without_lossy_rewrite() {
        let raw = concat!(
            "C\\:\\\\Temp\\\\build\\\\x.o: packages\\\\vendor\\\\x.c\n",
            "packages\\\\vendor\\\\x.h:\n",
        );
        assert_eq!(
            normalize_ccache_depfile_text_for_host(
                raw,
                Path::new(r"C:\CK"),
                Path::new(r"C:\CK"),
                DepfileHost::Windows,
            )
            .unwrap_err(),
            PortableCacheError::MultipleRules
        );
    }

    #[test]
    fn portable_environment_explicitly_disables_hardlinks() {
        let env = portable_fast_ccache_env(Path::new(r"C:\CK"), "ck-fast-v1-test");
        assert!(!env.contains_key("CCACHE_HARDLINK"));
        assert_eq!(
            env.get("CCACHE_NOHARDLINK").map(String::as_str),
            Some("true")
        );
        assert_eq!(env.get("CCACHE_DEPEND").map(String::as_str), Some("true"));
        assert!(
            !env.contains_key("CCACHE_BASEDIR"),
            "ccache must preserve native source paths used by __FILE__"
        );
        assert_eq!(
            env.get("CCACHE_NAMESPACE").map(String::as_str),
            Some("ck-fast-v1-test")
        );
        assert!(
            !env.get("CCACHE_SLOPPINESS")
                .expect("sloppiness")
                .split(',')
                .any(|value| value == "system_headers")
        );
        assert!(
            !env.get("CCACHE_SLOPPINESS")
                .expect("sloppiness")
                .split(',')
                .any(|value| value == "time_macros"),
            "time macros must remain part of ccache identity"
        );
    }

    #[test]
    fn namespace_binds_toolchain_target_profile_and_contract() {
        let base = fast_profile_ccache_namespace(
            "esp32|esp32|3.3.6|strong-content",
            "esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=default",
            "quick-fast",
            "contract-v1",
        );
        assert_eq!(
            base,
            fast_profile_ccache_namespace(
                "esp32|esp32|3.3.6|strong-content",
                "esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=default",
                "quick-fast",
                "contract-v1",
            )
        );
        assert_eq!(base.len(), "ck-fast-v1-".len() + 64);
        assert_ne!(
            base,
            fast_profile_ccache_namespace(
                "esp32|esp32|3.3.7|different-content",
                "esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=default",
                "quick-fast",
                "contract-v1",
            )
        );
        assert_ne!(
            base,
            fast_profile_ccache_namespace(
                "esp32|esp32|3.3.6|strong-content",
                "esp32:esp32:esp32c6:FlashSize=8M,PartitionScheme=default",
                "quick-fast",
                "contract-v1",
            )
        );
        assert_ne!(
            base,
            fast_profile_ccache_namespace(
                "esp32|esp32|3.3.6|strong-content",
                "esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=default",
                "shared-fast",
                "contract-v1",
            )
        );
        assert_ne!(
            base,
            fast_profile_ccache_namespace(
                "esp32|esp32|3.3.6|strong-content",
                "esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=default",
                "quick-fast",
                "contract-v2",
            )
        );
    }

    #[test]
    fn qualified_fast_environment_can_use_hardlinks_without_system_header_sloppiness() {
        let env = fast_profile_ccache_env(Path::new(r"C:\CK"), "qualified", true);
        assert_eq!(env.get("CCACHE_HARDLINK").map(String::as_str), Some("true"));
        assert!(!env.contains_key("CCACHE_NOHARDLINK"));
        assert!(
            !env.get("CCACHE_SLOPPINESS")
                .expect("sloppiness")
                .contains("system_headers")
        );
        assert!(
            !env.get("CCACHE_SLOPPINESS")
                .expect("sloppiness")
                .split(',')
                .any(|value| value == "time_macros"),
            "qualified fast builds must not reuse __DATE__/__TIME__ objects"
        );
    }
}
