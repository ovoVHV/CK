use anyhow::Result;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

pub struct Cache {
    pub root_dir: PathBuf,
}

impl Cache {
    pub fn new(sysroot_dir: &Path) -> Self {
        // Cache layout: sysroot/cache/objects/ab/abcdef12...
        let root_dir = sysroot_dir.join("cache").join("objects");
        // Ensure dir exists (lazy or init?)
        // Let's do lazy on put, or init here if possible.
        // Init here is safer.
        let _ = fs::create_dir_all(&root_dir);
        Self { root_dir }
    }

    /// Compute input hash key for compilation
    pub fn compute_key(
        &self,
        source_content: &str,
        dependencies_content: &[String],
        command_line: &str,
    ) -> String {
        let mut hasher = Sha256::new();
        hasher.update(source_content.as_bytes());
        for dep in dependencies_content {
            hasher.update(dep.as_bytes());
        }
        hasher.update(command_line.as_bytes());
        let result = hasher.finalize();
        hex::encode(result)
    }

    /// Try to retrieve an artifact from cache.
    /// Returns path to the cached file if exists.
    pub fn get(&self, key: &str) -> Option<PathBuf> {
        if key.len() < 2 {
            return None;
        }
        let prefix = &key[0..2];
        let path = self.root_dir.join(prefix).join(key);

        if path.exists() { Some(path) } else { None }
    }

    /// Store an artifact into cache.
    pub fn put(&self, key: &str, artifact_path: &Path) -> Result<()> {
        if key.len() < 2 {
            return Ok(());
        }
        let prefix = &key[0..2];
        let dir = self.root_dir.join(prefix);

        if !dir.exists() {
            fs::create_dir_all(&dir)?;
        }

        let target_path = dir.join(key);
        fs::copy(artifact_path, target_path)?;
        Ok(())
    }
}
