use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{HashSet, VecDeque};
use std::fs::OpenOptions;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CompileAccelSettings {
    pub max_jobs: u32,
    pub cache_limit_mb: u64,
    pub prewarm_boards: Vec<String>,
    pub prewarm_on_startup: bool,
    pub prewarm_debounce_ms: u64,
    pub prewarm_concurrency: u32,
}

impl Default for CompileAccelSettings {
    fn default() -> Self {
        Self {
            max_jobs: 0,
            cache_limit_mb: 2048,
            // A fresh installation has no evidence that one built-in board is
            // more useful than another. The desktop records the user's exact
            // full FQBN after selection/foreground work; until then, remain
            // idle instead of spending CPU on an arbitrary ESP32 target.
            prewarm_boards: Vec::new(),
            prewarm_on_startup: true,
            prewarm_debounce_ms: 800,
            prewarm_concurrency: 1,
        }
    }
}

impl CompileAccelSettings {
    pub fn default_jobs() -> u32 {
        // Use all CPU cores — compilation is I/O bound (ccache, disk, preprocessing)
        // so saturating the CPU is beneficial.  Cap at 16 to avoid fd exhaustion.
        let cpu = num_cpus::get().max(1);
        cpu.min(16) as u32
    }

    pub fn effective_jobs(&self) -> u32 {
        let host_default = Self::default_jobs();
        if self.max_jobs == 0 {
            return host_default;
        }

        // Backward-compat: older builds often persisted 8 as the default cap.
        // On high-core hosts this is unnecessarily conservative; treat it as legacy-default
        // unless explicitly disabled.
        let respect_pinned_jobs = std::env::var("CK_RESPECT_MAX_JOBS")
            .map(|v| {
                matches!(
                    v.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
            .unwrap_or(false);
        if self.max_jobs == 8 && host_default > 8 && !respect_pinned_jobs {
            host_default
        } else {
            self.max_jobs
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompileMetricRecord {
    pub timestamp_ms: u128,
    pub fqbn: String,
    pub library_resolution_ms: u128,
    pub cli_compile_ms: u128,
    pub total_ms: u128,
    pub cache_hit: bool,
    pub build_signature: String,
}

pub const COMPILE_METRICS_MAX_RECORDS: usize = 4096;
pub const COMPILE_METRICS_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const COMPILE_METRIC_MAX_LINE_BYTES: usize = 16 * 1024;
const COMPILE_METRIC_MAX_FQBN_BYTES: usize = 4096;
const COMPILE_METRIC_MAX_SIGNATURE_BYTES: usize = 8192;
const COMPILE_METRICS_TEMP_PREFIX: &str = ".compile_metrics.jsonl.ck-tmp-";
const COMPILE_METRICS_LOCK_FILE: &str = ".compile_metrics.jsonl.lock";
const COMPILE_METRICS_LOCK_TIMEOUT: Duration = Duration::from_secs(3);
const COMPILE_METRICS_LOCK_RETRY: Duration = Duration::from_millis(10);

fn compile_metrics_io_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn compile_accel_settings_io_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn state_dir(root: &Path) -> PathBuf {
    root.join("state")
}

pub fn compile_accel_path(root: &Path) -> PathBuf {
    state_dir(root).join("compile_accel.json")
}

pub fn compile_metrics_path(root: &Path) -> PathBuf {
    state_dir(root).join("compile_metrics.jsonl")
}

pub fn header_index_path(root: &Path) -> PathBuf {
    state_dir(root).join("header_index_v1.json")
}

pub fn load_compile_accel_settings(root: &Path) -> CompileAccelSettings {
    let _guard = compile_accel_settings_io_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    load_compile_accel_settings_unlocked(root).unwrap_or_default()
}

fn load_compile_accel_settings_unlocked(root: &Path) -> Result<CompileAccelSettings> {
    let path = compile_accel_path(root);
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str::<CompileAccelSettings>(&content)
            .context("parse compile acceleration settings"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(CompileAccelSettings::default())
        }
        Err(error) => Err(error).context("read compile acceleration settings"),
    }
}

pub fn save_compile_accel_settings(root: &Path, settings: &CompileAccelSettings) -> Result<()> {
    let _guard = compile_accel_settings_io_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = state_dir(root);
    fs::create_dir_all(&dir).with_context(|| format!("create state dir {}", dir.display()))?;
    let _file_guard = CompileMetricsFileLock::acquire(&dir)?;
    save_compile_accel_settings_unlocked(root, settings)
}

pub fn update_compile_accel_settings<T, F>(root: &Path, update: F) -> Result<T>
where
    F: FnOnce(&mut CompileAccelSettings) -> T,
{
    let _guard = compile_accel_settings_io_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = state_dir(root);
    fs::create_dir_all(&dir).with_context(|| format!("create state dir {}", dir.display()))?;
    let _file_guard = CompileMetricsFileLock::acquire(&dir)?;
    let mut settings = load_compile_accel_settings_unlocked(root)?;
    let output = update(&mut settings);
    save_compile_accel_settings_unlocked(root, &settings)?;
    Ok(output)
}

fn save_compile_accel_settings_unlocked(
    root: &Path,
    settings: &CompileAccelSettings,
) -> Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    const MAX_SETTINGS_BYTES: usize = 128 * 1024;
    let dir = state_dir(root);
    let path = compile_accel_path(root);
    let data = serde_json::to_string_pretty(settings)?;
    if data.len() > MAX_SETTINGS_BYTES {
        anyhow::bail!("refusing to write oversized compile acceleration settings");
    }
    let temporary = dir.join(format!(
        "compile_accel.json.tmp-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> Result<()> {
        let mut file = File::create(&temporary)
            .with_context(|| format!("create settings temp {}", temporary.display()))?;
        file.write_all(data.as_bytes())?;
        file.sync_all()?;
        atomic_replace_file(&temporary, &path)
            .with_context(|| format!("replace settings {}", path.display()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn append_compile_metric(root: &Path, record: &CompileMetricRecord) -> Result<()> {
    let dir = state_dir(root);
    fs::create_dir_all(&dir).with_context(|| format!("create state dir {}", dir.display()))?;
    let path = compile_metrics_path(root);
    validate_metric_record(record)?;
    let _guard = compile_metrics_io_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _file_guard = CompileMetricsFileLock::acquire(&dir)?;
    cleanup_compile_metric_temps(&dir);
    let mut snapshot = load_compile_metrics_bounded(&path)?;
    snapshot.records.push(record.clone());
    let encoded = encode_latest_compile_metrics(&snapshot.records)?;
    atomic_write_compile_metrics(&dir, &path, &encoded)
}

pub fn read_compile_metrics_jsonl(root: &Path) -> Result<String> {
    let (_records, encoded) = read_compile_metrics_snapshot(root)?;
    String::from_utf8(encoded).context("bounded compile metrics must remain UTF-8 JSONL")
}

pub fn read_compile_metric_records(root: &Path) -> Result<Vec<CompileMetricRecord>> {
    read_compile_metrics_snapshot(root).map(|(records, _)| records)
}

fn read_compile_metrics_snapshot(root: &Path) -> Result<(Vec<CompileMetricRecord>, Vec<u8>)> {
    let path = compile_metrics_path(root);
    let _guard = compile_metrics_io_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = state_dir(root);
    fs::create_dir_all(&dir).with_context(|| format!("create state dir {}", dir.display()))?;
    let _file_guard = CompileMetricsFileLock::acquire(&dir)?;
    cleanup_compile_metric_temps(&dir);
    if !path.exists() {
        return Ok((Vec::new(), Vec::new()));
    }
    let snapshot = load_compile_metrics_bounded(&path)?;
    let encoded = encode_latest_compile_metrics(&snapshot.records)?;
    if snapshot.needs_rewrite || snapshot.raw != encoded {
        fs::create_dir_all(&dir).with_context(|| format!("create state dir {}", dir.display()))?;
        atomic_write_compile_metrics(&dir, &path, &encoded)?;
    }
    Ok((snapshot.records, encoded))
}

#[derive(Debug)]
struct CompileMetricsSnapshot {
    records: Vec<CompileMetricRecord>,
    raw: Vec<u8>,
    needs_rewrite: bool,
}

fn validate_metric_record(record: &CompileMetricRecord) -> Result<()> {
    if record.fqbn.len() > COMPILE_METRIC_MAX_FQBN_BYTES
        || record.build_signature.len() > COMPILE_METRIC_MAX_SIGNATURE_BYTES
        || record
            .fqbn
            .chars()
            .chain(record.build_signature.chars())
            .any(|ch| matches!(ch, '\0' | '\r' | '\n'))
    {
        anyhow::bail!("compile metric string field exceeds its safety contract");
    }
    let serialized = serde_json::to_vec(record)?;
    if serialized.len().saturating_add(1) > COMPILE_METRIC_MAX_LINE_BYTES {
        anyhow::bail!(
            "compile metric exceeds the {} byte line limit",
            COMPILE_METRIC_MAX_LINE_BYTES
        );
    }
    Ok(())
}

fn serialize_metric_line(record: &CompileMetricRecord) -> Result<Vec<u8>> {
    validate_metric_record(record)?;
    let mut line = serde_json::to_vec(record)?;
    line.push(b'\n');
    Ok(line)
}

fn load_compile_metrics_bounded(path: &Path) -> Result<CompileMetricsSnapshot> {
    if !path.exists() {
        return Ok(CompileMetricsSnapshot {
            records: Vec::new(),
            raw: Vec::new(),
            needs_rewrite: false,
        });
    }
    let metadata =
        fs::metadata(path).with_context(|| format!("stat metrics {}", path.display()))?;
    let file_len = metadata.len();
    let read_len = file_len.min(COMPILE_METRICS_MAX_BYTES as u64);
    let start = file_len.saturating_sub(read_len);
    let mut file = File::open(path).with_context(|| format!("open metrics {}", path.display()))?;
    file.seek(SeekFrom::Start(start))?;
    let mut raw =
        Vec::with_capacity(usize::try_from(read_len).unwrap_or(COMPILE_METRICS_MAX_BYTES));
    file.take(COMPILE_METRICS_MAX_BYTES as u64)
        .read_to_end(&mut raw)?;
    debug_assert!(raw.len() <= COMPILE_METRICS_MAX_BYTES);

    let mut needs_rewrite = file_len > COMPILE_METRICS_MAX_BYTES as u64;
    if start > 0 {
        if let Some(first_newline) = raw.iter().position(|byte| *byte == b'\n') {
            raw.drain(..=first_newline);
        } else {
            raw.clear();
        }
        needs_rewrite = true;
    }

    let mut records = VecDeque::new();
    for raw_line in raw.split(|byte| *byte == b'\n') {
        let raw_line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        if raw_line.is_empty() {
            continue;
        }
        if raw_line.len() > COMPILE_METRIC_MAX_LINE_BYTES {
            needs_rewrite = true;
            continue;
        }
        let Ok(record) = serde_json::from_slice::<CompileMetricRecord>(raw_line) else {
            needs_rewrite = true;
            continue;
        };
        if validate_metric_record(&record).is_err() {
            needs_rewrite = true;
            continue;
        }
        records.push_back(record);
        if records.len() > COMPILE_METRICS_MAX_RECORDS {
            records.pop_front();
            needs_rewrite = true;
        }
    }

    Ok(CompileMetricsSnapshot {
        records: records.into_iter().collect(),
        raw,
        needs_rewrite,
    })
}

fn encode_latest_compile_metrics(records: &[CompileMetricRecord]) -> Result<Vec<u8>> {
    let mut newest_first = Vec::new();
    let mut total_bytes = 0usize;
    for record in records.iter().rev() {
        if newest_first.len() == COMPILE_METRICS_MAX_RECORDS {
            break;
        }
        let line = serialize_metric_line(record)?;
        if total_bytes.saturating_add(line.len()) > COMPILE_METRICS_MAX_BYTES {
            break;
        }
        total_bytes += line.len();
        newest_first.push(line);
    }
    newest_first.reverse();
    let mut encoded = Vec::with_capacity(total_bytes);
    for line in newest_first {
        encoded.extend_from_slice(&line);
    }
    debug_assert!(encoded.len() <= COMPILE_METRICS_MAX_BYTES);
    Ok(encoded)
}

fn cleanup_compile_metric_temps(dir: &Path) {
    let own_prefix = format!("{}{}-", COMPILE_METRICS_TEMP_PREFIX, std::process::id());
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name
            .to_str()
            .is_some_and(|name| name.starts_with(&own_prefix))
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(target_os = "windows")]
struct CompileMetricsFileLock {
    handle: *mut std::ffi::c_void,
}

#[cfg(target_os = "windows")]
impl CompileMetricsFileLock {
    fn acquire(dir: &Path) -> Result<Self> {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "Kernel32")]
        unsafe extern "system" {
            fn CreateFileW(
                name: *const u16,
                access: u32,
                share_mode: u32,
                security: *mut std::ffi::c_void,
                creation: u32,
                flags: u32,
                template: *mut std::ffi::c_void,
            ) -> *mut std::ffi::c_void;
        }
        const GENERIC_READ: u32 = 0x8000_0000;
        const GENERIC_WRITE: u32 = 0x4000_0000;
        const OPEN_ALWAYS: u32 = 4;
        const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
        const INVALID_HANDLE_VALUE: *mut std::ffi::c_void = -1isize as *mut std::ffi::c_void;

        let path = dir.join(COMPILE_METRICS_LOCK_FILE);
        let path_wide = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let started = Instant::now();
        loop {
            let handle = unsafe {
                CreateFileW(
                    path_wide.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    std::ptr::null_mut(),
                    OPEN_ALWAYS,
                    FILE_ATTRIBUTE_NORMAL,
                    std::ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                return Ok(Self { handle });
            }
            if started.elapsed() >= COMPILE_METRICS_LOCK_TIMEOUT {
                return Err(std::io::Error::last_os_error())
                    .with_context(|| format!("lock compile metrics {}", path.display()));
            }
            std::thread::sleep(COMPILE_METRICS_LOCK_RETRY);
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for CompileMetricsFileLock {
    fn drop(&mut self) {
        #[link(name = "Kernel32")]
        unsafe extern "system" {
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        let _ = unsafe { CloseHandle(self.handle) };
    }
}

#[cfg(unix)]
struct CompileMetricsFileLock {
    file: File,
}

#[cfg(unix)]
impl CompileMetricsFileLock {
    fn acquire(dir: &Path) -> Result<Self> {
        use std::os::fd::AsRawFd;
        unsafe extern "C" {
            fn flock(fd: std::ffi::c_int, operation: std::ffi::c_int) -> std::ffi::c_int;
        }
        const LOCK_EX: std::ffi::c_int = 2;
        const LOCK_NB: std::ffi::c_int = 4;
        let path = dir.join(COMPILE_METRICS_LOCK_FILE);
        let started = Instant::now();
        loop {
            let file = OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .open(&path)
                .with_context(|| format!("open compile metrics lock {}", path.display()))?;
            if unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) } == 0 {
                return Ok(Self { file });
            }
            if started.elapsed() >= COMPILE_METRICS_LOCK_TIMEOUT {
                return Err(std::io::Error::last_os_error())
                    .with_context(|| format!("lock compile metrics {}", path.display()));
            }
            std::thread::sleep(COMPILE_METRICS_LOCK_RETRY);
        }
    }
}

#[cfg(unix)]
impl Drop for CompileMetricsFileLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe extern "C" {
            fn flock(fd: std::ffi::c_int, operation: std::ffi::c_int) -> std::ffi::c_int;
        }
        const LOCK_UN: std::ffi::c_int = 8;
        let _ = unsafe { flock(self.file.as_raw_fd(), LOCK_UN) };
    }
}

#[cfg(not(any(target_os = "windows", unix)))]
struct CompileMetricsFileLock;

#[cfg(not(any(target_os = "windows", unix)))]
impl CompileMetricsFileLock {
    fn acquire(_dir: &Path) -> Result<Self> {
        Ok(Self)
    }
}

fn next_compile_metrics_temp_path(dir: &Path) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    dir.join(format!(
        "{}{}-{}",
        COMPILE_METRICS_TEMP_PREFIX,
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

fn atomic_write_compile_metrics(dir: &Path, destination: &Path, data: &[u8]) -> Result<()> {
    if data.len() > COMPILE_METRICS_MAX_BYTES {
        anyhow::bail!("refusing to write oversized compile metrics snapshot");
    }
    let temporary = next_compile_metrics_temp_path(dir);
    let result = (|| -> Result<()> {
        let mut file = File::create(&temporary)
            .with_context(|| format!("create metrics temp {}", temporary.display()))?;
        file.write_all(data)?;
        file.sync_all()?;
        atomic_replace_file(&temporary, destination)
            .with_context(|| format!("replace metrics {}", destination.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(target_os = "windows")]
fn atomic_replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn atomic_replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(test)]
mod compile_metric_tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::{Arc, Barrier};

    fn test_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "ck-compile-metrics-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn metric(index: u128, signature_payload: usize) -> CompileMetricRecord {
        CompileMetricRecord {
            timestamp_ms: index,
            fqbn: format!("esp32:esp32:esp32c6:Metric={index}"),
            library_resolution_ms: index + 1,
            cli_compile_ms: index + 2,
            total_ms: index + 3,
            cache_hit: index % 2 == 0,
            build_signature: format!("sig-{index}-{}", "s".repeat(signature_payload)),
        }
    }

    fn raw_metrics(records: impl IntoIterator<Item = CompileMetricRecord>) -> Vec<u8> {
        let mut out = Vec::new();
        for record in records {
            out.extend_from_slice(&serde_json::to_vec(&record).unwrap());
            out.push(b'\n');
        }
        out
    }

    #[test]
    fn recovery_keeps_only_the_latest_4096_valid_records() {
        let root = test_root("record-count");
        let path = compile_metrics_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, raw_metrics((0..4200).map(|index| metric(index, 0)))).unwrap();

        let records = read_compile_metric_records(&root).unwrap();
        assert_eq!(records.len(), COMPILE_METRICS_MAX_RECORDS);
        assert_eq!(records.first().unwrap().timestamp_ms, 104);
        assert_eq!(records.last().unwrap().timestamp_ms, 4199);
        append_compile_metric(&root, &metric(4200, 0)).unwrap();
        let records = read_compile_metric_records(&root).unwrap();
        assert_eq!(records.len(), COMPILE_METRICS_MAX_RECORDS);
        assert_eq!(records.first().unwrap().timestamp_ms, 105);
        assert_eq!(records.last().unwrap().timestamp_ms, 4200);
        assert!(fs::metadata(&path).unwrap().len() <= COMPILE_METRICS_MAX_BYTES as u64);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn historical_file_over_two_mib_is_tail_recovered_without_full_read() {
        let root = test_root("byte-budget");
        let path = compile_metrics_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let raw = raw_metrics((0..400).map(|index| metric(index, 8000)));
        assert!(raw.len() > COMPILE_METRICS_MAX_BYTES);
        fs::write(&path, raw).unwrap();

        let records = read_compile_metric_records(&root).unwrap();
        assert!(!records.is_empty());
        assert_eq!(records.last().unwrap().timestamp_ms, 399);
        let compacted = fs::read(&path).unwrap();
        assert!(compacted.len() <= COMPILE_METRICS_MAX_BYTES);
        assert_eq!(
            compacted,
            read_compile_metrics_jsonl(&root).unwrap().as_bytes()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_no_newline_and_bad_lines_are_discarded_fail_safe() {
        let root = test_root("bad-lines");
        let path = compile_metrics_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, vec![b'x'; COMPILE_METRICS_MAX_BYTES + 500_000]).unwrap();
        assert!(read_compile_metric_records(&root).unwrap().is_empty());
        assert_eq!(fs::metadata(&path).unwrap().len(), 0);

        let mut mixed = raw_metrics([metric(1, 0)]);
        mixed.extend_from_slice(&[0xff, 0xfe, b'\n']);
        mixed.extend(std::iter::repeat_n(b'z', COMPILE_METRIC_MAX_LINE_BYTES + 1));
        mixed.push(b'\n');
        mixed.extend_from_slice(&raw_metrics([CompileMetricRecord {
            fqbn: "esp32:esp32:esp32c6:名称=测试".to_string(),
            ..metric(2, 0)
        }]));
        fs::write(&path, mixed).unwrap();
        let records = read_compile_metric_records(&root).unwrap();
        assert_eq!(
            records
                .iter()
                .map(|record| record.timestamp_ms)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert!(
            read_compile_metrics_jsonl(&root)
                .unwrap()
                .contains("名称=测试")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn concurrent_append_is_serialized_and_cleans_owned_atomic_residue() {
        let root = Arc::new(test_root("concurrent"));
        let dir = state_dir(&root);
        fs::create_dir_all(&dir).unwrap();
        let own_prefix = format!("{}{}-", COMPILE_METRICS_TEMP_PREFIX, std::process::id());
        let stale = dir.join(format!("{own_prefix}stale"));
        let other_process = dir.join(format!(
            "{}{}-active",
            COMPILE_METRICS_TEMP_PREFIX,
            std::process::id().saturating_add(1)
        ));
        let foreign = dir.join("editor.tmp");
        fs::write(&stale, b"partial").unwrap();
        fs::write(&other_process, b"do-not-delete").unwrap();
        fs::write(&foreign, b"keep").unwrap();

        let workers = 48usize;
        let barrier = Arc::new(Barrier::new(workers));
        let mut threads = Vec::new();
        for index in 0..workers {
            let root = Arc::clone(&root);
            let barrier = Arc::clone(&barrier);
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                append_compile_metric(&root, &metric(index as u128, 0)).unwrap();
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }

        let records = read_compile_metric_records(&root).unwrap();
        assert_eq!(records.len(), workers);
        assert_eq!(
            records
                .iter()
                .map(|record| record.timestamp_ms)
                .collect::<HashSet<_>>()
                .len(),
            workers
        );
        assert!(!stale.exists());
        assert!(other_process.exists());
        assert!(foreign.exists());
        assert!(!fs::read_dir(&dir).unwrap().flatten().any(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(&own_prefix))
        }));
        let _ = fs::remove_dir_all(root.as_ref());
    }

    #[test]
    fn file_lock_serializes_independent_file_descriptors() {
        let root = test_root("file-lock");
        let dir = state_dir(&root);
        fs::create_dir_all(&dir).unwrap();
        let first = CompileMetricsFileLock::acquire(&dir).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let thread_dir = dir.clone();
        let waiter = std::thread::spawn(move || {
            let second = CompileMetricsFileLock::acquire(&thread_dir).unwrap();
            tx.send(()).unwrap();
            drop(second);
        });
        assert!(
            rx.recv_timeout(Duration::from_millis(100)).is_err(),
            "a second process/file descriptor must not enter while the first owns the lock"
        );
        drop(first);
        rx.recv_timeout(Duration::from_secs(2))
            .expect("file lock waiter should acquire after release");
        waiter.join().unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn append_rejects_one_oversized_record_before_serialization_growth() {
        let root = test_root("oversized-record");
        let mut record = metric(1, 0);
        record.build_signature = "x".repeat(COMPILE_METRIC_MAX_SIGNATURE_BYTES + 1);
        assert!(append_compile_metric(&root, &record).is_err());
        assert!(!compile_metrics_path(&root).exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn settings_missing_fields_inherit_safe_defaults() {
        let root = test_root("settings-defaults");
        let path = compile_accel_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"max_jobs":4,"prewarm_boards":["esp32:esp32:esp32c6:FlashSize=16M"]}"#,
        )
        .unwrap();

        let settings = load_compile_accel_settings(&root);
        assert_eq!(settings.max_jobs, 4);
        assert_eq!(settings.cache_limit_mb, 2048);
        assert!(settings.prewarm_on_startup);
        assert_eq!(settings.prewarm_debounce_ms, 800);
        assert_eq!(settings.prewarm_concurrency, 1);
        assert_eq!(
            settings.prewarm_boards,
            vec!["esp32:esp32:esp32c6:FlashSize=16M"]
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn fresh_settings_do_not_preheat_an_arbitrary_builtin_board() {
        let root = test_root("settings-fresh-idle");
        let settings = load_compile_accel_settings(&root);
        assert!(settings.prewarm_boards.is_empty());
        assert!(settings.prewarm_on_startup);
        assert!(!compile_accel_path(&root).exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn settings_update_is_atomic_and_preserves_concurrent_changes() {
        let root = Arc::new(test_root("settings-concurrent"));
        save_compile_accel_settings(&root, &CompileAccelSettings::default()).unwrap();
        let workers = 24usize;
        let barrier = Arc::new(Barrier::new(workers));
        let mut threads = Vec::new();
        for index in 0..workers {
            let root = Arc::clone(&root);
            let barrier = Arc::clone(&barrier);
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                update_compile_accel_settings(&root, |settings| {
                    settings
                        .prewarm_boards
                        .push(format!("vendor:arch:board{index}"));
                })
                .unwrap();
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }

        let settings = load_compile_accel_settings(&root);
        for index in 0..workers {
            assert!(
                settings
                    .prewarm_boards
                    .contains(&format!("vendor:arch:board{index}")),
                "transactional update lost board{index}"
            );
        }
        let dir = state_dir(&root);
        assert!(!fs::read_dir(&dir).unwrap().flatten().any(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("compile_accel.json.tmp-"))
        }));
        let _ = fs::remove_dir_all(root.as_ref());
    }

    #[test]
    fn corrupt_settings_abort_update_without_overwriting_evidence() {
        let root = test_root("settings-corrupt");
        let path = compile_accel_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let corrupt = br#"{"max_jobs":4,"prewarm_boards":["unterminated"#;
        fs::write(&path, corrupt).unwrap();

        let result = update_compile_accel_settings(&root, |settings| {
            settings.max_jobs = 12;
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), corrupt);
        let _ = fs::remove_dir_all(root);
    }
}

#[derive(Debug, Clone)]
struct CacheCandidate {
    path: PathBuf,
    canonical_path: PathBuf,
    bytes: u64,
    modified_ms: u128,
}

const CACHE_ACCESS_MARKER_NAME: &str = ".ck-cache-access-v1";

/// Result of recording a successful use of one CK-owned cache candidate.
///
/// `protected_path` is canonical and can safely be passed back to the budget
/// enforcer. `access_recorded=false` keeps the just-used path protected for the
/// current sweep even if an unexpected marker prevented the persistent LRU
/// timestamp from being refreshed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheAccessRecord {
    pub protected_path: PathBuf,
    pub access_recorded: bool,
}

fn cache_metadata_is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0;
    }
    #[cfg(not(windows))]
    false
}

fn system_time_ms(t: SystemTime) -> u128 {
    t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
}

fn managed_cache_roots() -> [PathBuf; 2] {
    [
        std::env::temp_dir().join("CK_Builds"),
        std::env::temp_dir().join("CK_LibShim"),
    ]
}

fn ordinary_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_dir() && !cache_metadata_is_link_or_reparse(&metadata))
}

/// Resolve an arbitrary directory inside a CK-owned build to the exact cache
/// candidate that the budget walker can remove. `CK_Builds/build` is a pinned
/// container, so each direct project child is a candidate. Other trees are
/// ranked by their direct child (including the isolated locked-build tree).
/// No caller-provided path may broaden the roots or cross a reparse point.
fn canonical_managed_cache_candidate(path: &Path, roots: &[PathBuf]) -> Option<PathBuf> {
    if !ordinary_directory(path) {
        return None;
    }
    let canonical = path.canonicalize().ok()?;
    for root in roots {
        if !ordinary_directory(root) {
            continue;
        }
        let Ok(canonical_root) = root.canonicalize() else {
            continue;
        };
        let Ok(relative) = canonical.strip_prefix(&canonical_root) else {
            continue;
        };
        let mut components = relative.components();
        let first = match components.next() {
            Some(std::path::Component::Normal(value)) => value,
            _ => continue,
        };
        if first == "metadata" {
            // Metadata is globally pinned and never enters the candidate list.
            return None;
        }
        let candidate = if root.file_name().and_then(|name| name.to_str()) == Some("CK_Builds")
            && first == "build"
        {
            let second = match components.next() {
                Some(std::path::Component::Normal(value)) => value,
                _ => continue,
            };
            canonical_root.join("build").join(second)
        } else {
            canonical_root.join(first)
        };
        if !ordinary_directory(&candidate) {
            continue;
        }
        let Ok(canonical_candidate) = candidate.canonicalize() else {
            continue;
        };
        if canonical == canonical_candidate || canonical.starts_with(&canonical_candidate) {
            return Some(canonical_candidate);
        }
    }
    None
}

fn paired_source_or_build_candidate(candidate: &Path, roots: &[PathBuf]) -> Option<PathBuf> {
    let name = candidate.file_name()?.to_str()?;
    if !name.starts_with("sketch_") {
        return None;
    }
    for root in roots {
        if root.file_name().and_then(|value| value.to_str()) != Some("CK_Builds")
            || !ordinary_directory(root)
        {
            continue;
        }
        let Ok(canonical_root) = root.canonicalize() else {
            continue;
        };
        let build_container = canonical_root.join("build");
        let canonical_build_container = ordinary_directory(&build_container)
            .then(|| build_container.canonicalize().ok())
            .flatten();
        let pair = if candidate.parent() == Some(canonical_root.as_path()) {
            canonical_build_container.as_ref()?.join(name)
        } else if canonical_build_container.as_deref() == candidate.parent() {
            canonical_root.join(name)
        } else {
            continue;
        };
        if !ordinary_directory(&pair) {
            return None;
        }
        let canonical_pair = pair.canonicalize().ok()?;
        let expected_parent = if candidate.parent() == Some(canonical_root.as_path()) {
            canonical_build_container.as_deref()
        } else {
            Some(canonical_root.as_path())
        };
        if canonical_pair.parent() == expected_parent
            && canonical_pair.file_name() == candidate.file_name()
        {
            return Some(canonical_pair);
        }
        return None;
    }
    None
}

fn cache_access_marker_modified_ms(path: &Path) -> Option<u128> {
    let marker = path.join(CACHE_ACCESS_MARKER_NAME);
    let metadata = fs::symlink_metadata(marker).ok()?;
    if !metadata.is_file() || cache_metadata_is_link_or_reparse(&metadata) {
        return None;
    }
    metadata.modified().ok().map(system_time_ms)
}

fn touch_cache_access_marker(path: &Path) -> bool {
    let marker = path.join(CACHE_ACCESS_MARKER_NAME);
    match fs::symlink_metadata(&marker) {
        Ok(metadata) => {
            if !metadata.is_file() || cache_metadata_is_link_or_reparse(&metadata) {
                return false;
            }
            OpenOptions::new()
                .write(true)
                .open(&marker)
                .and_then(|file| {
                    file.set_times(fs::FileTimes::new().set_modified(SystemTime::now()))
                })
                .is_ok()
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(marker)
            .and_then(|mut file| file.write_all(b"ck-cache-access-v1\n"))
            .is_ok(),
        Err(_) => false,
    }
}

/// Persist real successful-use timestamps and return every canonical candidate
/// that the immediately following budget sweep must not remove. Normal builds
/// have a paired `CK_Builds/sketch_*` source project and
/// `CK_Builds/build/sketch_*` object directory; both are one reusable baseline.
pub fn record_cache_candidate_accesses(path: &Path) -> Vec<CacheAccessRecord> {
    let roots = managed_cache_roots();
    record_cache_candidate_accesses_for_roots(path, &roots)
}

fn record_cache_candidate_accesses_for_roots(
    path: &Path,
    roots: &[PathBuf],
) -> Vec<CacheAccessRecord> {
    let Some(primary) = canonical_managed_cache_candidate(path, roots) else {
        return Vec::new();
    };
    let mut protected_paths = vec![primary.clone()];
    if let Some(pair) = paired_source_or_build_candidate(&primary, roots) {
        if pair != primary {
            protected_paths.push(pair);
        }
    }
    protected_paths
        .into_iter()
        .map(|protected_path| CacheAccessRecord {
            access_recorded: touch_cache_access_marker(&protected_path),
            protected_path,
        })
        .collect()
}

fn dir_size_until(path: &Path, should_abort: &dyn Fn() -> bool) -> Option<u64> {
    if should_abort() {
        return None;
    }
    if !path.exists() {
        return Some(0);
    }
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(_) => return Some(0),
    };
    if cache_metadata_is_link_or_reparse(&meta) {
        return Some(0);
    }
    if meta.is_file() {
        return Some(meta.len());
    }
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            total = total.saturating_add(dir_size_until(&entry.path(), should_abort)?);
        }
    }
    Some(total)
}

fn is_pinned_cache_candidate(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some("metadata")
    )
}

fn is_out_of_tree_build_container(root: &Path, path: &Path) -> bool {
    root.file_name().and_then(|name| name.to_str()) == Some("CK_Builds")
        && path.file_name().and_then(|name| name.to_str()) == Some("build")
        && fs::symlink_metadata(path).is_ok_and(|metadata| {
            metadata.is_dir() && !cache_metadata_is_link_or_reparse(&metadata)
        })
}

fn append_cache_candidate_until(
    path: PathBuf,
    out: &mut Vec<CacheCandidate>,
    should_abort: &dyn Fn() -> bool,
) -> bool {
    if should_abort() {
        return false;
    }
    if is_pinned_cache_candidate(&path) {
        return true;
    }
    let meta = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(_) => return true,
    };
    if cache_metadata_is_link_or_reparse(&meta) {
        return true;
    }
    let Ok(canonical_path) = path.canonicalize() else {
        return true;
    };
    let Some(bytes) = dir_size_until(&path, should_abort) else {
        return false;
    };
    let modified_ms = meta
        .modified()
        .map(system_time_ms)
        .unwrap_or(0)
        .max(cache_access_marker_modified_ms(&path).unwrap_or(0));
    out.push(CacheCandidate {
        modified_ms,
        bytes,
        path,
        canonical_path,
    });
    true
}

fn collect_cache_candidates_until(
    root: &Path,
    should_abort: &dyn Fn() -> bool,
) -> Option<Vec<CacheCandidate>> {
    let mut out = Vec::new();
    let root_metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(_) => return Some(out),
    };
    if !root_metadata.is_dir() || cache_metadata_is_link_or_reparse(&root_metadata) {
        return Some(out);
    }
    let read_dir = match fs::read_dir(root) {
        Ok(rd) => rd,
        Err(_) => return Some(out),
    };
    for entry in read_dir.flatten() {
        if should_abort() {
            return None;
        }
        let path = entry.path();
        // `CK_Builds/build` is the stable out-of-tree container shared by all
        // FQBN/profile projects. Treating it as one LRU candidate would let a
        // single over-budget sweep remove every board cache at once. Keep the
        // container pinned and rank each direct project directory separately.
        if is_out_of_tree_build_container(root, &path) {
            if let Ok(projects) = fs::read_dir(&path) {
                for project in projects.flatten() {
                    if !append_cache_candidate_until(project.path(), &mut out, should_abort) {
                        return None;
                    }
                }
            }
            continue;
        }
        if !append_cache_candidate_until(path, &mut out, should_abort) {
            return None;
        }
    }
    Some(out)
}

#[cfg(test)]
fn collect_cache_candidates(root: &Path) -> Vec<CacheCandidate> {
    collect_cache_candidates_until(root, &|| false).unwrap_or_default()
}

fn remove_cache_candidate_if_safe(path: &Path) -> bool {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        // A concurrently removed candidate already consumes no budget.
        Err(_) => return !path.exists(),
    };
    if cache_metadata_is_link_or_reparse(&metadata) {
        return false;
    }
    if metadata.is_dir() {
        fs::remove_dir_all(path).is_ok()
    } else if metadata.is_file() {
        fs::remove_file(path).is_ok()
    } else {
        false
    }
}

pub fn enforce_cache_budget(limit_mb: u64) -> Result<()> {
    let limit_bytes = limit_mb.saturating_mul(1024 * 1024);
    enforce_cache_budget_for_roots(limit_bytes, &managed_cache_roots())
}

pub fn enforce_cache_budget_cancellable<F>(limit_mb: u64, should_abort: F) -> Result<bool>
where
    F: Fn() -> bool,
{
    enforce_cache_budget_cancellable_protecting(limit_mb, &[], should_abort)
}

/// Enforce the same low-disk/size budget while preserving cache candidates
/// used by successful builds that completed immediately before this sweep.
pub fn enforce_cache_budget_cancellable_protecting<F>(
    limit_mb: u64,
    protected_paths: &[PathBuf],
    should_abort: F,
) -> Result<bool>
where
    F: Fn() -> bool,
{
    let limit_bytes = limit_mb.saturating_mul(1024 * 1024);
    enforce_cache_budget_for_roots_until(
        limit_bytes,
        &managed_cache_roots(),
        protected_paths,
        &should_abort,
    )
}

/// Returns the bytes currently available to CK's temporary build cache.
///
/// This is deliberately a lightweight volume query rather than a recursive
/// cache scan.  The desktop uses it to decide whether cache-budget enforcement
/// must remain synchronous under critical disk pressure.
#[cfg(windows)]
pub fn available_cache_volume_bytes() -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let mut path: Vec<u16> = std::env::temp_dir()
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut available = 0u64;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            path.as_mut_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(available)
}

#[cfg(unix)]
pub fn available_cache_volume_bytes() -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;

    let path = std::ffi::CString::new(std::env::temp_dir().as_os_str().as_bytes()).ok()?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    let ok = unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) };
    if ok != 0 {
        return None;
    }
    let stats = unsafe { stats.assume_init() };
    Some((stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64))
}

#[cfg(not(any(windows, unix)))]
pub fn available_cache_volume_bytes() -> Option<u64> {
    None
}

pub fn enforce_cache_budget_for_roots(limit_bytes: u64, roots: &[PathBuf]) -> Result<()> {
    let _ = enforce_cache_budget_for_roots_until(limit_bytes, roots, &[], &|| false)?;
    Ok(())
}

fn enforce_cache_budget_for_roots_until(
    limit_bytes: u64,
    roots: &[PathBuf],
    protected_paths: &[PathBuf],
    should_abort: &dyn Fn() -> bool,
) -> Result<bool> {
    let protected: HashSet<PathBuf> = protected_paths
        .iter()
        .filter_map(|path| canonical_managed_cache_candidate(path, roots))
        .collect();
    let mut candidates = Vec::new();
    for root in roots {
        let Some(found) = collect_cache_candidates_until(root, should_abort) else {
            return Ok(false);
        };
        candidates.extend(found);
    }

    let mut total: u64 = candidates.iter().map(|c| c.bytes).sum();
    if total <= limit_bytes || limit_bytes == 0 {
        return Ok(true);
    }

    candidates.sort_by_key(|c| (c.modified_ms, Reverse(c.bytes)));
    for c in candidates {
        if should_abort() {
            return Ok(false);
        }
        if total <= limit_bytes {
            break;
        }
        if protected.contains(&c.canonical_path) {
            continue;
        }
        if remove_cache_candidate_if_safe(&c.path) {
            total = total.saturating_sub(c.bytes);
        }
    }

    Ok(true)
}

#[cfg(test)]
mod cache_budget_tests {
    use super::*;

    #[test]
    fn out_of_tree_build_container_is_never_an_eviction_candidate() {
        let temp = tempfile::tempdir().expect("cache root");
        let root = temp.path().join("CK_Builds");
        let build = root.join("build");
        let first = build.join("sketch_first_rel");
        let second = build.join("sketch_second_rel");
        fs::create_dir_all(&first).expect("first project");
        fs::write(first.join("first.bin"), [1u8; 8]).expect("first artifact");
        std::thread::sleep(Duration::from_millis(25));
        fs::create_dir_all(&second).expect("second project");
        fs::write(second.join("second.bin"), [2u8; 4]).expect("second artifact");

        let candidates = collect_cache_candidates(&root);
        assert!(candidates.iter().any(|candidate| candidate.path == first));
        assert!(candidates.iter().any(|candidate| candidate.path == second));
        assert!(candidates.iter().all(|candidate| candidate.path != build));

        enforce_cache_budget_for_roots(4, std::slice::from_ref(&root))
            .expect("project-granular eviction");
        assert!(
            build.is_dir(),
            "the shared build container must remain pinned"
        );
        assert!(!first.exists(), "the older project should be evicted first");
        assert!(
            second.is_dir(),
            "the newer project must remain independently reusable"
        );
    }

    #[test]
    fn linked_out_of_tree_build_container_is_fail_closed() {
        let temp = tempfile::tempdir().expect("cache root");
        let root = temp.path().join("CK_Builds");
        let outside = temp.path().join("outside");
        let build = root.join("build");
        fs::create_dir_all(outside.join("external_project")).expect("outside project");
        fs::write(outside.join("external_project/firmware.bin"), [7u8; 16])
            .expect("outside artifact");
        fs::create_dir_all(&root).expect("CK cache root");
        #[cfg(windows)]
        junction::create(&outside, &build).expect("build junction");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &build).expect("build symlink");

        let candidates = collect_cache_candidates(&root);
        assert!(
            candidates.is_empty(),
            "a linked build container must not expose external children as eviction candidates"
        );
        assert!(
            !remove_cache_candidate_if_safe(&build),
            "the delete-time guard must also reject a linked candidate"
        );
        enforce_cache_budget_for_roots(1, std::slice::from_ref(&root))
            .expect("fail-closed linked container sweep");
        assert!(outside.join("external_project/firmware.bin").is_file());
    }

    #[test]
    fn linked_cache_root_never_exposes_external_candidates() {
        let temp = tempfile::tempdir().expect("cache root");
        let outside = temp.path().join("outside");
        fs::create_dir_all(outside.join("external_project")).expect("outside project");
        fs::write(outside.join("external_project/firmware.bin"), [9u8; 16])
            .expect("outside artifact");

        for root_name in ["CK_Builds", "CK_LibShim"] {
            let root = temp.path().join(root_name);
            #[cfg(windows)]
            junction::create(&outside, &root).expect("cache-root junction");
            #[cfg(unix)]
            std::os::unix::fs::symlink(&outside, &root).expect("cache-root symlink");

            assert!(collect_cache_candidates(&root).is_empty());
            enforce_cache_budget_for_roots(1, std::slice::from_ref(&root))
                .expect("fail-closed root sweep");
            assert!(outside.join("external_project/firmware.bin").is_file());
            #[cfg(windows)]
            junction::delete(&root).expect("remove cache-root junction");
            #[cfg(unix)]
            fs::remove_file(&root).expect("remove cache-root symlink");
        }
    }

    #[test]
    fn cancellable_sweep_stops_before_inspection_or_deletion() {
        let temp = tempfile::tempdir().expect("cache root");
        let root = temp.path().join("CK_Builds");
        let project = root.join("build/sketch_active_rel");
        fs::create_dir_all(&project).expect("active project");
        fs::write(project.join("firmware.bin"), [3u8; 32]).expect("active artifact");

        let completed =
            enforce_cache_budget_for_roots_until(1, std::slice::from_ref(&root), &[], &|| true)
                .expect("cancellable sweep");
        assert!(!completed);
        assert!(project.join("firmware.bin").is_file());
    }

    #[test]
    fn current_successful_build_is_protected_from_the_same_budget_sweep() {
        let temp = tempfile::tempdir().expect("cache root");
        let root = temp.path().join("CK_Builds");
        let protected = root.join("build/sketch_current_qfast");
        let newer_peer = root.join("build/sketch_peer_qfast");
        fs::create_dir_all(&protected).expect("protected project");
        fs::write(protected.join("firmware.bin"), [1u8; 8]).expect("protected artifact");
        std::thread::sleep(Duration::from_millis(30));
        fs::create_dir_all(&newer_peer).expect("peer project");
        fs::write(newer_peer.join("firmware.bin"), [2u8; 8]).expect("peer artifact");

        let completed = enforce_cache_budget_for_roots_until(
            8,
            std::slice::from_ref(&root),
            std::slice::from_ref(&protected),
            &|| false,
        )
        .expect("protected sweep");

        assert!(completed);
        assert!(
            protected.join("firmware.bin").is_file(),
            "the build that triggered this sweep must survive even when it is the oldest candidate"
        );
        assert!(
            !newer_peer.exists(),
            "an unprotected peer should be evicted to satisfy the budget"
        );
    }

    #[test]
    fn successful_access_marker_becomes_the_candidate_lru_timestamp() {
        let temp = tempfile::tempdir().expect("cache root");
        let root = temp.path().join("CK_Builds");
        let used = root.join("build/sketch_used_qfast");
        let peer = root.join("build/sketch_peer_qfast");
        fs::create_dir_all(&used).expect("used project");
        fs::write(used.join("firmware.bin"), [1u8; 8]).expect("used artifact");
        std::thread::sleep(Duration::from_millis(30));
        fs::create_dir_all(&peer).expect("peer project");
        fs::write(peer.join("firmware.bin"), [2u8; 8]).expect("peer artifact");
        std::thread::sleep(Duration::from_millis(30));
        assert!(touch_cache_access_marker(&used));

        let candidates = collect_cache_candidates(&root);
        let used_time = candidates
            .iter()
            .find(|candidate| candidate.path == used)
            .expect("used candidate")
            .modified_ms;
        let peer_time = candidates
            .iter()
            .find(|candidate| candidate.path == peer)
            .expect("peer candidate")
            .modified_ms;
        assert!(
            used_time > peer_time,
            "a real successful use must refresh LRU independently of directory mtime"
        );
    }

    #[test]
    fn nested_locked_build_maps_to_its_actual_eviction_candidate() {
        let temp = tempfile::tempdir().expect("cache root");
        let root = temp.path().join("CK_Builds");
        let isolated = root.join("isolated");
        let build = isolated.join("lock-key/build/sketch_locked_rel");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&build).expect("locked build");
        fs::create_dir_all(&outside).expect("outside directory");

        assert_eq!(
            canonical_managed_cache_candidate(&build, std::slice::from_ref(&root)),
            Some(isolated.canonicalize().expect("isolated candidate"))
        );
        assert_eq!(
            canonical_managed_cache_candidate(&outside, std::slice::from_ref(&root)),
            None,
            "an external path must never become a protected cache candidate"
        );
    }

    #[test]
    fn successful_object_build_records_and_protects_its_source_project_pair() {
        let temp = tempfile::tempdir().expect("cache root");
        let root = temp.path().join("CK_Builds");
        let source = root.join("sketch_pair_qfast");
        let objects = root.join("build/sketch_pair_qfast");
        fs::create_dir_all(&source).expect("source project");
        fs::create_dir_all(&objects).expect("object project");

        let records =
            record_cache_candidate_accesses_for_roots(&objects, std::slice::from_ref(&root));
        let paths = records
            .iter()
            .map(|record| record.protected_path.clone())
            .collect::<HashSet<_>>();
        assert_eq!(records.len(), 2);
        assert!(records.iter().all(|record| record.access_recorded));
        assert!(paths.contains(&source.canonicalize().expect("canonical source")));
        assert!(paths.contains(&objects.canonicalize().expect("canonical objects")));
        assert!(source.join(CACHE_ACCESS_MARKER_NAME).is_file());
        assert!(objects.join(CACHE_ACCESS_MARKER_NAME).is_file());
    }

    #[test]
    fn missing_or_escaped_source_pair_is_never_fabricated_or_followed() {
        let temp = tempfile::tempdir().expect("cache root");
        let root = temp.path().join("CK_Builds");
        let objects = root.join("build/sketch_missing_qfast");
        fs::create_dir_all(&objects).expect("object project");

        let missing_records =
            record_cache_candidate_accesses_for_roots(&objects, std::slice::from_ref(&root));
        assert_eq!(missing_records.len(), 1, "a missing pair is simply absent");

        let escaped_objects = root.join("build/sketch_escaped_qfast");
        let escaped_source = root.join("sketch_escaped_qfast");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&escaped_objects).expect("escaped object project");
        fs::create_dir_all(&outside).expect("outside project");
        #[cfg(windows)]
        junction::create(&outside, &escaped_source).expect("source junction");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &escaped_source).expect("source symlink");

        let escaped_records = record_cache_candidate_accesses_for_roots(
            &escaped_objects,
            std::slice::from_ref(&root),
        );
        assert_eq!(
            escaped_records.len(),
            1,
            "a reparse/symlink source pair must be rejected"
        );
        assert!(!outside.join(CACHE_ACCESS_MARKER_NAME).exists());

        #[cfg(windows)]
        junction::delete(&escaped_source).expect("remove source junction");
        #[cfg(unix)]
        fs::remove_file(&escaped_source).expect("remove source symlink");
    }
}
