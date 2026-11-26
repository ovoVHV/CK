use std::path::{Path, PathBuf};

/// Only expose regular image files belonging to this package, including when
/// its block assets are inherited from a different directory via `extends`.
pub(super) fn resolve(root: &Path, declared: &str) -> Option<PathBuf> {
    let name = declared.trim();
    if name.contains([':', '\\', '%', '?', '#'])
        || name.chars().any(char::is_control)
        || name.split('/').any(|part| matches!(part, "" | "." | ".."))
    {
        return None;
    }
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    if !matches!(ext.as_str(), "png" | "svg" | "webp" | "jpg" | "jpeg") {
        return None;
    }
    let file = root.join(name);
    let image = file.canonicalize().ok()?;
    if !image.starts_with(root.canonicalize().ok()?) {
        return None;
    }
    let meta = image.metadata().ok()?;
    if !meta.is_file() || !(1..=256 * 1024).contains(&meta.len()) {
        return None;
    }
    // Return the normal display path, not Windows' canonical \\?\ prefix.
    Some(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packaged_logo_resolves_only_inside_its_board() {
        let root = std::env::temp_dir().join(format!("ck-logo-test-{}", std::process::id()));
        let assets = root.join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        let image = assets.join("标志.svg");
        std::fs::write(&image, "<svg/>").unwrap();
        assert_eq!(resolve(&root, "assets/标志.svg"), Some(image.clone()));
        for bad in ["../标志.svg", "https://test/icon.svg", "assets/a.svg:meta", "missing.png", "board.json"] {
            assert_eq!(resolve(&root, bad), None);
        }
        std::fs::write(&image, vec![0; 256 * 1024 + 1]).unwrap();
        assert_eq!(resolve(&root, "assets/标志.svg"), None);
        std::fs::remove_file(image).unwrap();
        std::fs::remove_dir(assets).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
