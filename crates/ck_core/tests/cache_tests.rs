use anyhow::Result;
use ck_core::builder::cache::Cache;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_cache_mechanism() -> Result<()> {
    let temp = tempdir()?;
    let sysroot = temp.path();
    let cache = Cache::new(sysroot);

    // 1. Compute Key
    let key1 = cache.compute_key("void main() {}", &[], "gcc -c main.c");
    let key2 = cache.compute_key("void main() {}", &[], "gcc -c main.c");
    assert_eq!(key1, key2);

    let key3 = cache.compute_key("void main() { changed; }", &[], "gcc -c main.c");
    assert_ne!(key1, key3);

    // 2. Put Artifact
    let artifact_source = sysroot.join("test.o");
    fs::write(&artifact_source, "binary data")?;

    cache.put(&key1, &artifact_source)?;

    // 3. Get Artifact
    let cached = cache.get(&key1);
    assert!(cached.is_some());
    let cached_path = cached.unwrap();
    assert!(cached_path.exists());

    // Verify content
    let content = fs::read_to_string(cached_path)?;
    assert_eq!(content, "binary data");

    // 4. Miss
    assert!(cache.get(&key3).is_none());

    Ok(())
}
