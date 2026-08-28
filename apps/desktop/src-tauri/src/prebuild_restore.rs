use ck_core::builder::prebuild_guard::{
    PREBUILD_RESTORE_ARG, register_prebuild_restore_helper, restore_prebuild_manifest_best_effort,
};
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

/// Handle CK's prebuild response-file restore helper before Tauri/WebView
/// initialization. Every helper-mode outcome returns exit code zero: this is a
/// latency optimization and must never block a native Arduino Core build.
pub fn maybe_run_prebuild_restore_from_args<I, S>(args: I) -> Option<i32>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut args = args.into_iter().map(Into::into);
    let _program = args.next();
    let first = args.next()?;
    if first != OsStr::new(PREBUILD_RESTORE_ARG) {
        return None;
    }
    let Some(manifest) = args.next() else {
        bounded_helper_log("missing manifest argument");
        return Some(0);
    };
    if args.next().is_some() {
        bounded_helper_log("unexpected extra helper argument");
        return Some(0);
    }

    let summary = restore_prebuild_manifest_best_effort(&PathBuf::from(manifest));
    bounded_helper_log(&summary.bounded_log());
    Some(0)
}

/// Explicitly register appsdesktop as a capable helper host. ck_core never
/// guesses from `current_exe()`, so CLI/test hosts that do not implement the
/// hidden argv contract cannot accidentally inject themselves into Core hooks.
pub fn register_current_exe_as_prebuild_restore_helper() -> Result<PathBuf, String> {
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    register_prebuild_restore_helper(&current).map_err(|error| error.to_string())
}

fn bounded_helper_log(message: &str) {
    const MAX_BYTES: usize = 4096;
    let mut end = message.len().min(MAX_BYTES);
    while end > 0 && !message.is_char_boundary(end) {
        end -= 1;
    }
    eprintln!("{}", &message[..end]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_argv_is_exact_and_space_safe() {
        let manifest = std::env::temp_dir().join("CK manifest with spaces.json");
        assert_eq!(
            maybe_run_prebuild_restore_from_args([
                OsString::from("appsdesktop"),
                OsString::from(PREBUILD_RESTORE_ARG),
                manifest.into_os_string(),
            ]),
            Some(0)
        );
        assert_eq!(
            maybe_run_prebuild_restore_from_args([
                OsString::from("appsdesktop"),
                OsString::from("--ordinary-app-argument"),
            ]),
            None
        );
    }

    #[test]
    fn malformed_helper_argv_is_always_a_zero_exit_noop() {
        assert_eq!(
            maybe_run_prebuild_restore_from_args([
                OsString::from("appsdesktop"),
                OsString::from(PREBUILD_RESTORE_ARG),
            ]),
            Some(0)
        );
        assert_eq!(
            maybe_run_prebuild_restore_from_args([
                OsString::from("appsdesktop"),
                OsString::from(PREBUILD_RESTORE_ARG),
                OsString::from("manifest.json"),
                OsString::from("extra"),
            ]),
            Some(0)
        );
    }
}
