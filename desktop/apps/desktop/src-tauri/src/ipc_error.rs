use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// Additive IPC error envelope for boundaries that need machine-readable
/// control flow without discarding the legacy human-readable message.
///
/// Locale is presentation: callers must branch on `code`, never `message`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDescriptor {
    pub code: String,
    pub params: BTreeMap<String, Value>,
    pub message: String,
    pub raw_cause: Option<String>,
}

impl ErrorDescriptor {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            params: BTreeMap::new(),
            message: message.into(),
            raw_cause: None,
        }
    }

    pub fn with_param(mut self, name: impl Into<String>, value: impl Into<Value>) -> Self {
        self.params.insert(name.into(), value.into());
        self
    }

    pub fn with_raw_cause(mut self, raw_cause: impl Into<String>) -> Self {
        self.raw_cause = Some(raw_cause.into());
        self
    }

    pub fn into_legacy_message(self) -> String {
        self.message
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_keeps_machine_identity_separate_from_legacy_message() {
        let error = ErrorDescriptor::new("PROJECT_NOT_FOUND", "工程路径无效")
            .with_param("path", "C:/Projects/missing.ck")
            .with_raw_cause("The system cannot find the file specified");
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(json["code"], "PROJECT_NOT_FOUND");
        assert_eq!(json["params"]["path"], "C:/Projects/missing.ck");
        assert_eq!(json["message"], "工程路径无效");
        assert_eq!(
            json["rawCause"],
            "The system cannot find the file specified"
        );
    }
}
