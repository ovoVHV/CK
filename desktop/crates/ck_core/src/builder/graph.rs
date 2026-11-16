use crate::builder::context::BuildContext;
use crate::builder::scanner::scan_includes;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Clone)]
pub struct Node {
    pub path: PathBuf,
    pub mtime: SystemTime,
    pub imports: Vec<PathBuf>,
}

pub struct DependencyGraph {
    pub nodes: HashMap<PathBuf, Node>,
}

impl DependencyGraph {
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
        }
    }

    /// Recursively scan dependencies for a source file and add to graph.
    pub fn scan(&mut self, source_file: &Path, context: &BuildContext) -> anyhow::Result<()> {
        if self.nodes.contains_key(source_file) {
            return Ok(());
        }

        let content = fs::read_to_string(source_file)?;
        let metadata = fs::metadata(source_file)?;
        let mtime = metadata.modified()?;

        let mut imports = Vec::new();
        let includes = scan_includes(&content);

        for inc in includes {
            if let Some(resolved_path) = context.resolve(&inc, source_file.parent()) {
                imports.push(resolved_path.clone());
                // Recursive scan
                // Ignore circular deps recursively to avoid stack overflow?
                // We handle it by checking contains_key at start.
                // But what if self ref?
                if resolved_path != source_file {
                    self.scan(&resolved_path, context).unwrap_or_else(|e| {
                        log::warn!("Failed to scan dependency {:?}: {}", resolved_path, e);
                    });
                }
            }
        }

        self.nodes.insert(
            source_file.to_path_buf(),
            Node {
                path: source_file.to_path_buf(),
                mtime,
                imports,
            },
        );

        Ok(())
    }

    /// Check if target (e.g. .o file) is outdated relative to source and its dependencies.
    pub fn is_dirty(&self, source_file: &Path, target_file: &Path) -> bool {
        // 1. Target doesn't exist? -> Dirty
        if !target_file.exists() {
            return true;
        }

        let target_mtime = match fs::metadata(target_file).and_then(|m| m.modified()) {
            Ok(t) => t,
            Err(_) => return true, // Error reading target -> assume dirty
        };

        // 2. Check source and all transitive deps
        let mut visited = HashSet::new();
        self.check_recursive(source_file, target_mtime, &mut visited)
    }

    fn check_recursive(
        &self,
        current: &Path,
        target_mtime: SystemTime,
        visited: &mut HashSet<PathBuf>,
    ) -> bool {
        if visited.contains(current) {
            return false;
        }
        visited.insert(current.to_path_buf());

        if let Some(node) = self.nodes.get(current) {
            if node.mtime > target_mtime {
                log::debug!("{:?} is newer than target", current);
                return true;
            }

            for import in &node.imports {
                if self.check_recursive(import, target_mtime, visited) {
                    return true;
                }
            }
        }
        false
    }
}
