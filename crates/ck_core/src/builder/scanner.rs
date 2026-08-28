use lazy_static::lazy_static;
use regex::Regex;
use std::path::PathBuf;

lazy_static! {
    static ref INCLUDE_REGEX: Regex =
        Regex::new(r#"^\s*#\s*include\s*(["<])([^">]+)([">])"#).unwrap();
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum IncludeType {
    /// #include "file.h" - Local lookup first
    Quote,
    /// #include <file.h> - System/Library lookup
    Angle,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Include {
    pub kind: IncludeType,
    pub path: String, // The string inside the quotes/angles
}

pub fn scan_includes(content: &str) -> Vec<Include> {
    let mut includes = Vec::new();

    // Process line by line for simplicity and correctness with comments (basic)
    // Note: This regex doesn't handle block comments /* */ well if they span lines or hide #includes.
    // But for Arduino/C++ build systems, usually simple regex is 'good enough' for dependency scanning
    // significantly faster than a full C++ preprocessor.
    for line in content.lines() {
        if let Some(caps) = INCLUDE_REGEX.captures(line) {
            let limit_open = &caps[1];
            let path = &caps[2];
            // let limit_close = &caps[3]; // unused

            let kind = if limit_open == "\"" {
                IncludeType::Quote
            } else {
                IncludeType::Angle
            };

            includes.push(Include {
                kind,
                path: path.to_string(),
            });
        }
    }
    includes
}
