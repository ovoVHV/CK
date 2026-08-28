use crate::builder::scanner::{Include, IncludeType};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct BuildContext {
    pub include_paths: Vec<PathBuf>,
}

impl BuildContext {
    pub fn new() -> Self {
        Self {
            include_paths: Vec::new(),
        }
    }

    pub fn add_include_path<P: AsRef<Path>>(&mut self, path: P) {
        self.include_paths.push(path.as_ref().to_path_buf());
    }

    /// Resolve an include directive to an actual file on disk.
    /// Returns absolute path if found.
    pub fn resolve(&self, include: &Include, current_file_dir: Option<&Path>) -> Option<PathBuf> {
        // Strategy:
        // 1. If Quote and current_file_dir is provided, check there first.
        // 2. Check all include_paths.

        if include.kind == IncludeType::Quote {
            if let Some(dir) = current_file_dir {
                let p = dir.join(&include.path);
                if p.exists() {
                    return Some(p);
                }
            }
        }

        for base in &self.include_paths {
            let p = base.join(&include.path);
            if p.exists() {
                return Some(p);
            }
        }

        None
    }
}
