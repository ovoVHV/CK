use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct BuildSignatureInput<'a> {
    pub fqbn: &'a str,
    pub cli_version: &'a str,
    pub toolchain_key: &'a str,
    pub sorted_libs: &'a [String],
}

pub fn normalize_and_sort_paths(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        let canonical = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        out.push(strip_windows_verbatim_prefix(canonical));
    }
    out.sort_by(|a, b| {
        a.to_string_lossy()
            .to_lowercase()
            .cmp(&b.to_string_lossy().to_lowercase())
    });
    out.dedup_by(|a, b| same_path(a, b));
    out
}

#[cfg(target_os = "windows")]
fn strip_windows_verbatim_prefix(path: PathBuf) -> PathBuf {
    let raw = path.to_string_lossy();
    let s = raw.as_ref();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{}", rest));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

#[cfg(not(target_os = "windows"))]
fn strip_windows_verbatim_prefix(path: PathBuf) -> PathBuf {
    path
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy()
        .eq_ignore_ascii_case(&b.to_string_lossy())
}

pub fn compute_build_signature(input: &BuildSignatureInput<'_>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ck_build_signature_v1");
    hasher.update(input.fqbn.as_bytes());
    hasher.update(b"\n");
    hasher.update(input.cli_version.as_bytes());
    hasher.update(b"\n");
    hasher.update(input.toolchain_key.as_bytes());
    hasher.update(b"\n");
    for lib in input.sorted_libs {
        hasher.update(lib.as_bytes());
        hasher.update(b"\n");
    }
    hex::encode(hasher.finalize())
}
