use lazy_static::lazy_static;
use regex::Regex;
use std::collections::HashMap;

lazy_static! {
    // Matches {variable}
    static ref VAR_REGEX: Regex = Regex::new(r"\{([\w\-\.]+)\}").unwrap();
}

#[derive(Debug, Clone, Default)]
pub struct Properties {
    pub map: HashMap<String, String>,
}

impl Properties {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, key: &str, value: &str) {
        self.map.insert(key.to_string(), value.to_string());
    }

    pub fn get(&self, key: &str) -> Option<&String> {
        self.map.get(key)
    }

    /// Expand a string by recursively resolving variables e.g. "{build.path}/fw.bin"
    pub fn expand(&self, input: &str) -> String {
        let mut result = input.to_string();

        // Simple recursion protection could be added, here we rely on regex replacement limits or iteration
        // Iteratively resolve until no changes or limit reached
        for _ in 0..20 {
            let original = result.clone();
            result = VAR_REGEX
                .replace_all(&original, |caps: &regex::Captures| {
                    let key = &caps[1];
                    match self.map.get(key) {
                        Some(v) => v.to_string(),    // Return owned String
                        None => caps[0].to_string(), // Return owned String
                    }
                })
                .to_string();

            if result == original {
                break;
            }
        }

        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_expansion() {
        let mut props = Properties::new();
        props.insert("build.mcu", "esp32");
        props.insert("compiler.path", "/usr/bin/");
        props.insert("compiler.c.cmd", "gcc");
        props.insert(
            "full_cmd",
            "{compiler.path}{compiler.c.cmd} -mmcu={build.mcu}",
        );

        assert_eq!(props.expand("{build.mcu}"), "esp32");
        assert_eq!(props.expand("{full_cmd}"), "/usr/bin/gcc -mmcu=esp32");
    }
}
