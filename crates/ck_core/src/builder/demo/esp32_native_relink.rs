//! ESP32 NativeRelink phase 1: contract identity and target gating.
//!
//! Phase 1 deliberately ships no dedicated transaction engine. The replay
//! logic lives in `demo.rs` and reuses the shipped ESP32 fast-relink recipe
//! machinery with pure Release properties; this module only pins the engine
//! contract string that authorization bindings and Forge certificates hash,
//! plus the exact board coverage the phase-1 evidence was gathered for.

/// Engine contract for the phase-1 ESP32 compile-only replay. Certificates,
/// access-key bindings and the Forge adapter registry all hash this exact
/// string; changing it revokes every previously issued ESP32 certificate.
pub(crate) const ESP32_NATIVE_RELINK_ENGINE_CONTRACT: &str =
    "ck-native-relink-esp32-release-compile-only-phase1-v1";

/// Coverage grows by adding exact bases here together with per-board A/B
/// evidence, never by loosening the match. Every base below has the complete
/// chip SDK installed locally and shares the identical ESP image layout the
/// application payload witness validates (esp_image header, app descriptor
/// ELF SHA-256 window at 0xb0, trailing checksum/SHA footer).
const ESP32_NATIVE_RELINK_SUPPORTED_FQBN_BASES: [&str; 8] = [
    "esp32:esp32:esp32c6",
    "esp32:esp32:esp32",
    "esp32:esp32:esp32s2",
    "esp32:esp32:esp32s3",
    "esp32:esp32:esp32c3",
    "esp32:esp32:esp32c5",
    "esp32:esp32:esp32h2",
    "esp32:esp32:esp32p4",
];

/// True only for a listed exact base, optionally followed by a menu-option
/// section after one more colon. This mirrors the Forge registry's
/// `ExactBase` matcher so ck_core and the desktop adapter can never disagree
/// about which complete FQBNs the phase-1 contract covers.
pub(crate) fn esp32_native_relink_supported_fqbn(fqbn: &str) -> bool {
    ESP32_NATIVE_RELINK_SUPPORTED_FQBN_BASES.iter().any(|base| {
        fqbn == *base
            || fqbn
                .strip_prefix(base)
                .is_some_and(|suffix| suffix.starts_with(':'))
    })
}

#[cfg(test)]
mod tests {
    use super::{ESP32_NATIVE_RELINK_ENGINE_CONTRACT, esp32_native_relink_supported_fqbn};

    #[test]
    fn supported_fqbn_covers_exact_generic_bases_with_optional_menu_options() {
        for base in [
            "esp32:esp32:esp32c6",
            "esp32:esp32:esp32",
            "esp32:esp32:esp32s2",
            "esp32:esp32:esp32s3",
            "esp32:esp32:esp32c3",
            "esp32:esp32:esp32c5",
            "esp32:esp32:esp32h2",
            "esp32:esp32:esp32p4",
        ] {
            assert!(esp32_native_relink_supported_fqbn(base), "{base}");
            assert!(
                esp32_native_relink_supported_fqbn(&format!("{base}:FlashSize=16M")),
                "{base} with menu options"
            );
        }
        assert!(esp32_native_relink_supported_fqbn(
            "esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB"
        ));

        assert!(!esp32_native_relink_supported_fqbn("esp32:esp32:esp32c61"));
        assert!(!esp32_native_relink_supported_fqbn("esp32:esp32:esp32c6x"));
        assert!(!esp32_native_relink_supported_fqbn(
            "esp32:esp32:esp32wrover"
        ));
        assert!(!esp32_native_relink_supported_fqbn("esp32:esp32:esp32da"));
        assert!(!esp32_native_relink_supported_fqbn("arduino:avr:uno"));
        assert!(!esp32_native_relink_supported_fqbn("arduino:samd:mkrzero"));
        assert!(!esp32_native_relink_supported_fqbn("ESP32:esp32:esp32c6"));
        assert!(!esp32_native_relink_supported_fqbn(""));
    }

    #[test]
    fn engine_contract_is_the_phase1_esp32_string() {
        // Certificates and access keys bind this exact value; a silent rename
        // must fail a test instead of invalidating deployed qualifications.
        assert_eq!(
            ESP32_NATIVE_RELINK_ENGINE_CONTRACT,
            "ck-native-relink-esp32-release-compile-only-phase1-v1"
        );
    }
}
