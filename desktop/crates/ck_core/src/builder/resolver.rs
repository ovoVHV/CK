use crate::registry::boards::Board;
use crate::registry::platform::Platform;
use crate::registry::properties::Properties;
use std::collections::HashMap;

pub struct Resolver {
    pub properties: Properties,
}

impl Resolver {
    pub fn new() -> Self {
        Self {
            properties: Properties::new(),
        }
    }

    pub fn load_platform(&mut self, platform: &Platform) {
        // Load platform properties
        // In reality, we might need to handle 'runtime.platform.path' etc.
        // For now, simpler merge.
        self.merge(&platform.properties);
    }

    pub fn load_board(&mut self, board: &Board) {
        self.merge(&board.properties);
    }

    fn merge(&mut self, other: &Properties) {
        for (k, v) in &other.map {
            self.properties.insert(k, v);
        }
    }

    pub fn resolve(&self, key: &str) -> String {
        self.properties.expand(key)
    }

    pub fn resolve_recipe(
        &self,
        recipe_key: &str,
    ) -> Option<crate::builder::recipe::CompileRecipe> {
        let pattern = self.properties.get(recipe_key)?;
        let expanded = self.properties.expand(pattern);

        let args = shlex::split(&expanded)
            .unwrap_or_else(|| expanded.split_whitespace().map(String::from).collect());

        // Assuming first arg is program? usually yes.
        // But patterns often are "{compiler.path}{compiler.c.cmd} ...".
        // So the first token is the binary.

        if args.is_empty() {
            return None;
        }

        Some(crate::builder::recipe::CompileRecipe {
            object_file: std::path::PathBuf::new(), // Placeholder, caller fills
            source_file: std::path::PathBuf::new(), // Placeholder
            command_line: args,
        })
    }
}

/// Helper for demo: resolve a command pattern using a properties set
pub fn resolve_command(pattern: &str, props: &Properties) -> String {
    props.expand(pattern)
}
