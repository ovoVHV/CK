//! Core version parsing, ordering, and selection shared by the build engine.
//!
//! Arduino package folders are not guaranteed to contain strict SemVer.  The
//! resolver therefore uses SemVer ordering when a folder name looks like a
//! SemVer value and a deterministic natural ordering for legacy/vendor values.
//! This keeps version selection useful for both official cores and third-party
//! packages without making the caller depend on a particular package manager.

use std::cmp::Ordering;

/// The policy used when selecting one installed Core version.
///
/// `ExactRequested` is intentionally strict: it never falls back to another
/// version.  `Recommended` prefers the publisher/application recommendation,
/// then falls back to the highest installed version so a recommendation is a
/// preference rather than an accidental hard lock.  `HighestInstalled` mirrors
/// Arduino CLI's default resolution behaviour.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CoreVersionSelectionStrategy<'a> {
    ExactRequested { version: &'a str },
    Recommended { version: &'a str },
    HighestInstalled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum SemverIdentifier {
    Numeric(u64),
    Text(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ParsedSemver {
    core: [u64; 3],
    prerelease: Option<Vec<SemverIdentifier>>,
}

fn parse_semver(value: &str) -> Option<ParsedSemver> {
    let value = value.trim().trim_start_matches('v');
    let without_build = value.split_once('+').map_or(value, |(head, _)| head);
    let (core, prerelease) = without_build
        .split_once('-')
        .map_or((without_build, None), |(head, tail)| (head, Some(tail)));
    let core_parts = core.split('.').collect::<Vec<_>>();
    if core_parts.len() != 3 {
        return None;
    }
    let core = [
        core_parts[0].parse().ok()?,
        core_parts[1].parse().ok()?,
        core_parts[2].parse().ok()?,
    ];
    let prerelease = match prerelease {
        None => None,
        Some(value) => {
            if value.is_empty() {
                return None;
            }
            Some(
                value
                    .split('.')
                    .map(|part| {
                        if part.is_empty() {
                            None
                        } else if part.bytes().all(|byte| byte.is_ascii_digit()) {
                            part.parse().ok().map(SemverIdentifier::Numeric)
                        } else if part
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                        {
                            Some(SemverIdentifier::Text(part.to_ascii_lowercase()))
                        } else {
                            None
                        }
                    })
                    .collect::<Option<Vec<_>>>()?,
            )
        }
    };
    Some(ParsedSemver { core, prerelease })
}

fn parsed_semver_cmp(left: &ParsedSemver, right: &ParsedSemver) -> Ordering {
    let core_ordering = left.core.cmp(&right.core);
    if core_ordering != Ordering::Equal {
        return core_ordering;
    }
    match (&left.prerelease, &right.prerelease) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(left_parts), Some(right_parts)) => {
            for (left, right) in left_parts.iter().zip(right_parts) {
                let ordering = match (left, right) {
                    (SemverIdentifier::Numeric(left), SemverIdentifier::Numeric(right)) => {
                        left.cmp(right)
                    }
                    (SemverIdentifier::Numeric(_), SemverIdentifier::Text(_)) => Ordering::Less,
                    (SemverIdentifier::Text(_), SemverIdentifier::Numeric(_)) => Ordering::Greater,
                    (SemverIdentifier::Text(left), SemverIdentifier::Text(right)) => {
                        left.cmp(right)
                    }
                };
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
            left_parts.len().cmp(&right_parts.len())
        }
    }
}

fn natural_version_cmp(left: &str, right: &str) -> Ordering {
    fn parts(value: &str) -> Vec<(bool, String)> {
        let mut out = Vec::new();
        let mut current = String::new();
        let mut numeric = None;
        for ch in value.chars() {
            let is_numeric = ch.is_ascii_digit();
            if numeric.is_some_and(|kind| kind != is_numeric) && !current.is_empty() {
                out.push((numeric.unwrap_or(false), std::mem::take(&mut current)));
            }
            numeric = Some(is_numeric);
            current.push(ch.to_ascii_lowercase());
        }
        if !current.is_empty() {
            out.push((numeric.unwrap_or(false), current));
        }
        out
    }

    let left_parts = parts(left);
    let right_parts = parts(right);
    for (left, right) in left_parts.iter().zip(&right_parts) {
        let ordering = match (left.0, right.0) {
            (true, true) => left
                .1
                .trim_start_matches('0')
                .len()
                .cmp(&right.1.trim_start_matches('0').len())
                .then_with(|| left.1.cmp(&right.1)),
            _ => left.1.cmp(&right.1),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    left_parts.len().cmp(&right_parts.len())
}

/// Compare two installed Core folder names.
///
/// Valid SemVer values sort according to SemVer precedence.  Valid SemVer is
/// preferred over a legacy/non-SemVer value, and two legacy values use natural
/// ordering (`1.10` after `1.9`, for example).
pub fn compare_core_versions(left: &str, right: &str) -> Ordering {
    match (parse_semver(left), parse_semver(right)) {
        (Some(left), Some(right)) => parsed_semver_cmp(&left, &right),
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (None, None) => natural_version_cmp(left, right),
    }
}

/// Return whether two installed version names identify the same version.
///
/// Exact trimmed names are accepted first; then a leading `v` and SemVer
/// precedence are considered.  This lets a requested `3.3.7` match a package
/// folder named `v3.3.7`, while preserving exact matching for legacy names.
pub fn core_versions_equal(left: &str, right: &str) -> bool {
    if left.trim().eq_ignore_ascii_case(right.trim()) {
        return true;
    }
    match (parse_semver(left), parse_semver(right)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

/// Sort installed Core versions from oldest to newest, deterministically.
pub fn sort_core_versions(versions: &mut [String]) {
    versions.sort_by(|left, right| compare_core_versions(left, right));
}

/// Select an installed Core version according to a policy.
pub fn select_core_version<I, S>(
    installed: I,
    strategy: CoreVersionSelectionStrategy<'_>,
) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut versions = installed
        .into_iter()
        .map(|version| version.as_ref().trim().to_string())
        .filter(|version| !version.is_empty())
        .collect::<Vec<_>>();
    if versions.is_empty() {
        return None;
    }

    match strategy {
        CoreVersionSelectionStrategy::ExactRequested { version } => versions
            .iter()
            .find(|installed| core_versions_equal(installed, version))
            .cloned(),
        CoreVersionSelectionStrategy::Recommended { version } => versions
            .iter()
            .find(|installed| core_versions_equal(installed, version))
            .cloned()
            .or_else(|| {
                versions
                    .iter()
                    .max_by(|left, right| compare_core_versions(left, right))
                    .cloned()
            }),
        CoreVersionSelectionStrategy::HighestInstalled => versions
            .drain(..)
            .max_by(|left, right| compare_core_versions(left, right)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn versions() -> Vec<String> {
        ["3.3.5", "3.3.7", "3.3.6"]
            .into_iter()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn exact_requested_does_not_fallback() {
        assert_eq!(
            select_core_version(
                versions(),
                CoreVersionSelectionStrategy::ExactRequested { version: "3.3.8" }
            ),
            None
        );
        assert_eq!(
            select_core_version(
                versions(),
                CoreVersionSelectionStrategy::ExactRequested { version: "3.3.7" }
            ),
            Some("3.3.7".to_string())
        );
    }

    #[test]
    fn recommended_prefers_recommendation_then_highest() {
        assert_eq!(
            select_core_version(
                versions(),
                CoreVersionSelectionStrategy::Recommended { version: "3.3.6" }
            ),
            Some("3.3.6".to_string())
        );
        assert_eq!(
            select_core_version(
                versions(),
                CoreVersionSelectionStrategy::Recommended { version: "3.4.0" }
            ),
            Some("3.3.7".to_string())
        );
    }

    #[test]
    fn highest_uses_semver_and_natural_fallback() {
        assert_eq!(
            select_core_version(
                ["1.9", "1.10", "1.8"],
                CoreVersionSelectionStrategy::HighestInstalled
            ),
            Some("1.10".to_string())
        );
        assert_eq!(
            select_core_version(
                ["3.3.7-beta.1", "3.3.7", "3.3.6"],
                CoreVersionSelectionStrategy::HighestInstalled
            ),
            Some("3.3.7".to_string())
        );
    }

    #[test]
    fn version_equality_accepts_leading_v_for_semver() {
        assert!(core_versions_equal("v3.3.7", "3.3.7"));
        assert!(!core_versions_equal("3.3.7-beta.1", "3.3.7"));
    }
}
