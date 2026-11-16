//! Overlap Windows file-open latency without changing the identity byte stream.
//! Only handles are queued. One reader feeds all bytes, in their original order,
//! into the existing SHA-256; no per-file digest replaces the content proof.
use super::{
    WindowsProcessGuardHandleMetadata, metadata_is_link_or_reparse,
    open_windows_process_guard_read_handle, windows_final_path_from_handle,
    windows_final_path_is_within_root, windows_normalized_canonical_root,
    windows_process_guard_handle_metadata,
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs::File, io::Read, path::{Path, PathBuf}, time::{Duration, Instant}};

struct Opened {
    file: File,
    before: WindowsProcessGuardHandleMetadata,
    open_time: Duration,
}

fn open(path: &Path, boundary: &str) -> Option<Opened> {
    let start = Instant::now();
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if metadata_is_link_or_reparse(&metadata) || !metadata.is_file() {
        return None;
    }
    // OPEN_REPARSE_POINT and read-only sharing reject links and prevent writes
    // or replacement while a handle is queued or being hashed.
    let file = open_windows_process_guard_read_handle(path)?;
    let before = windows_process_guard_handle_metadata(&file)?;
    if before.kind != 1 || before.len != metadata.len()
        || !windows_final_path_is_within_root(&windows_final_path_from_handle(&file)?, boundary)
    {
        return None;
    }
    Some(Opened { file, before, open_time: start.elapsed() })
}

pub(super) fn hash_files_in_order(
    hasher: &mut Sha256,
    root: &Path,
    files: &BTreeSet<PathBuf>,
    requested_workers: usize,
) -> bool {
    let Some(boundary) = windows_normalized_canonical_root(root) else {
        hasher.update(b"unsafe-content-boundary\n");
        return false;
    };
    if files.is_empty() { return true; }
    let files: Vec<_> = files.iter().collect();
    let workers = requested_workers.clamp(1, 16).min(files.len());
    let start = Instant::now();
    let mut open_time = Duration::ZERO;
    let mut read_time = Duration::ZERO;
    let mut hash_time = Duration::ZERO;
    let mut total_bytes = 0u64;
    let success = std::thread::scope(|scope| {
        let mut receivers = Vec::with_capacity(workers);
        let mut threads = Vec::with_capacity(workers);
        let mut started = true;
        for worker in 0..workers {
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            receivers.push(receiver);
            let files = &files;
            let boundary = &boundary;
            match std::thread::Builder::new().name("ck-identity-open".into()).spawn_scoped(scope, move || {
                for index in (worker..files.len()).step_by(workers) {
                    let result = open(files[index], boundary);
                    let failed = result.is_none();
                    if sender.send(result).is_err() || failed { break; }
                }
            }) {
                Ok(thread) => threads.push(thread),
                Err(_) => { started = false; break; }
            }
        }
        let complete = started && (|| -> Option<()> {
            let mut buffer = vec![0u8; 1024 * 1024];
            for (index, path) in files.iter().enumerate() {
                let relative = path.strip_prefix(root).ok()?.to_str()?.replace('\\', "/");
                let mut opened = receivers[index % workers].recv().ok()??;
                open_time += opened.open_time;
                hasher.update(b"file\0");
                hasher.update(relative.as_bytes());
                hasher.update(b"\0");
                hasher.update(opened.before.len.to_le_bytes());
                let mut bytes = 0u64;
                loop {
                    let phase = Instant::now();
                    let count = opened.file.read(&mut buffer).ok()?;
                    read_time += phase.elapsed();
                    if count == 0 { break; }
                    bytes = bytes.checked_add(count as u64)?;
                    if bytes > opened.before.len { return None; }
                    let phase = Instant::now();
                    hasher.update(&buffer[..count]);
                    hash_time += phase.elapsed();
                }
                if bytes != opened.before.len
                    || windows_process_guard_handle_metadata(&opened.file)? != opened.before
                { return None; }
                total_bytes += bytes;
                hasher.update(b"\n");
            }
            Some(())
        })().is_some();
        // On every exit, release queued handles and wake blocked senders before
        // joining. A missing file, read failure or worker failure never publishes
        // a partial proof. At most 2*workers+1 content handles are alive.
        drop(receivers);
        let mut joined = true;
        for thread in threads { joined &= thread.join().is_ok(); }
        complete && joined
    });
    log::debug!(target: "ck_identity_timing", "ordered-content files={} bytes={} workers={} wall={}ms open-sum={}ms read={}ms hash={}ms success={}", files.len(), total_bytes, workers, start.elapsed().as_millis(), open_time.as_millis(), read_time.as_millis(), hash_time.as_millis(), success);
    if !success { hasher.update(b"unreadable-or-moving-content\n"); }
    success
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordered_content_preserves_legacy_digest_for_empty_large_and_unicode_files() {
        let temp = tempfile::tempdir().unwrap();
        let mut files = BTreeSet::new();
        for (name, size) in [("空文件.h", 0), ("a.bin", 2_300_017), ("Z.h", 5), ("space 文件.h", 100)] {
            let path = temp.path().join(name);
            std::fs::write(&path, (0..size).map(|i| (i % 251) as u8).collect::<Vec<_>>()).unwrap();
            files.insert(path);
        }
        let legacy = || {
            let mut hash = Sha256::new();
            for path in &files {
                let bytes = std::fs::read(path).unwrap();
                hash.update(b"file\0");
                hash.update(path.strip_prefix(temp.path()).unwrap().to_str().unwrap().replace('\\', "/").as_bytes());
                hash.update(b"\0");
                hash.update((bytes.len() as u64).to_le_bytes());
                hash.update(bytes);
                hash.update(b"\n");
            }
            hash.finalize()
        };
        let first = legacy();
        for workers in [1, 4, 16] {
            let mut hash = Sha256::new();
            assert!(hash_files_in_order(&mut hash, temp.path(), &files, workers));
            assert_eq!(hash.finalize(), first);
        }
        std::fs::write(temp.path().join("Z.h"), b"edit!").unwrap();
        let mut changed = Sha256::new();
        assert!(hash_files_in_order(&mut changed, temp.path(), &files, 16));
        let changed = changed.finalize();
        assert_ne!(changed, first);
        assert_eq!(changed, legacy());
    }

    #[test]
    fn ordered_content_rejects_missing_directory_and_escaped_paths_without_stalling() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let mut files = BTreeSet::new();
        for i in 0..80 {
            let path = temp.path().join(format!("{i:03}.h"));
            std::fs::write(&path, b"contents").unwrap();
            files.insert(path);
        }
        let missing = temp.path().join("001.h");
        std::fs::remove_file(&missing).unwrap();
        assert!(!hash_files_in_order(&mut Sha256::new(), temp.path(), &files, 16));
        std::fs::create_dir(&missing).unwrap();
        assert!(!hash_files_in_order(&mut Sha256::new(), temp.path(), &files, 16));
        let escaped = outside.path().join("escaped.h");
        std::fs::write(&escaped, b"outside").unwrap();
        assert!(!hash_files_in_order(&mut Sha256::new(), temp.path(), &BTreeSet::from([escaped]), 16));
        let link = temp.path().join("redirect");
        junction::create(outside.path(), &link).unwrap();
        assert!(!hash_files_in_order(&mut Sha256::new(), temp.path(), &BTreeSet::from([link.join("escaped.h")]), 16));
    }

    #[test]
    fn ordered_content_queued_handle_prevents_rewrite_and_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("queued.h");
        std::fs::write(&path, b"original").unwrap();
        let opened = open(&path, &windows_normalized_canonical_root(temp.path()).unwrap()).unwrap();
        assert!(std::fs::write(&path, b"modified").is_err());
        assert!(std::fs::rename(&path, temp.path().join("moved.h")).is_err());
        drop(opened);
        std::fs::write(&path, b"modified").unwrap();
    }
}
