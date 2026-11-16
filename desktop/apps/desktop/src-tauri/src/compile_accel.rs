use crate::{normalize_base_fqbn, normalize_complete_fqbn};
use ck_core::builder::accel::{
    CompileAccelSettings, CompileMetricRecord, append_compile_metric, load_compile_accel_settings,
    read_compile_metric_records, read_compile_metrics_jsonl, save_compile_accel_settings,
    update_compile_accel_settings,
};
use ck_core::sysroot::Sysroot;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    Mutex, OnceLock,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::sync::{mpsc, watch};

#[derive(Clone)]
struct PrewarmJob {
    sysroot: Sysroot,
    fqbn: String,
    code: Option<String>,
    code_hash_hint: Option<String>,
    build_signature_hint: Option<String>,
}

#[derive(Clone)]
struct ActiveWarmup {
    cancel_tx: watch::Sender<bool>,
    stage: WarmupStage,
    fqbn: String,
    code_hash_hint: Option<String>,
    build_signature_hint: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WarmupStage {
    QuickFast,
    SharedFast,
    PortableFast,
}

const STARTUP_PREWARM_TOP_N: usize = 1;
const STARTUP_PREWARM_BUDGET_MS: u128 = 20_000;
const HOTSET_WINDOW_MS: u128 = 7 * 24 * 60 * 60 * 1000;
const HOTSET_RETENTION_MS: u128 = 30 * 24 * 60 * 60 * 1000;
const HOTSET_MAX_EVENTS: usize = 2000;
const HOTSET_SCHEMA_VERSION: u32 = 2;
const HOTSET_DEFAULT_ESTIMATE_MS: u128 = 15_000;
const HOTSET_MIN_ESTIMATE_MS: u128 = 8_000;
const HOTSET_MAX_ESTIMATE_MS: u128 = 30_000;
const CACHE_BUDGET_THROTTLE: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const CACHE_BUDGET_LOW_DISK_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const CACHE_BUDGET_EMERGENCY_LIMIT_MB: u64 = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CacheBudgetAction {
    Skip,
    Background,
    Synchronous,
}

#[derive(Default)]
struct CacheBudgetSweepState {
    running: bool,
    last_started: Option<std::time::Instant>,
    protected_paths: HashSet<PathBuf>,
}

fn cache_budget_sweep_state() -> &'static Mutex<CacheBudgetSweepState> {
    static STATE: OnceLock<Mutex<CacheBudgetSweepState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(CacheBudgetSweepState::default()))
}

fn cache_budget_action(
    enabled: bool,
    running: bool,
    elapsed_since_last_start: Option<std::time::Duration>,
    available_bytes: Option<u64>,
    force_synchronous: bool,
) -> CacheBudgetAction {
    if !enabled || running {
        return CacheBudgetAction::Skip;
    }
    // Explicit maintenance is allowed to bypass the normal throttle.  Low
    // disk pressure is urgent on the first pass, but must still respect the
    // ten-minute throttle afterwards; otherwise every hot compile on a nearly
    // full drive performs a recursive synchronous sweep.
    if force_synchronous {
        return CacheBudgetAction::Synchronous;
    }
    if elapsed_since_last_start.is_some_and(|elapsed| elapsed < CACHE_BUDGET_THROTTLE) {
        CacheBudgetAction::Skip
    } else if available_bytes.is_some_and(|bytes| bytes < CACHE_BUDGET_LOW_DISK_BYTES) {
        CacheBudgetAction::Synchronous
    } else {
        CacheBudgetAction::Background
    }
}

fn effective_cache_budget_limit_mb(limit_mb: u64, available_bytes: Option<u64>) -> u64 {
    if available_bytes.is_some_and(|bytes| bytes < CACHE_BUDGET_LOW_DISK_BYTES) {
        if limit_mb == 0 {
            CACHE_BUDGET_EMERGENCY_LIMIT_MB
        } else {
            limit_mb.min(CACHE_BUDGET_EMERGENCY_LIMIT_MB)
        }
    } else {
        limit_mb
    }
}

fn register_cache_budget_decision(
    state: &mut CacheBudgetSweepState,
    action: CacheBudgetAction,
    now: std::time::Instant,
    protected_paths: Vec<PathBuf>,
) {
    if action != CacheBudgetAction::Skip {
        state.running = true;
        state.last_started = Some(now);
    }
    // A compile can finish while a delayed sweep is waiting for the exclusive
    // build-cache gate. Register that success even though this invocation is a
    // single-flight Skip; the already-running sweep must protect it as well.
    if state.running {
        for path in protected_paths {
            state.protected_paths.insert(path);
        }
    }
}

fn take_cache_budget_protected_paths() -> Vec<PathBuf> {
    let mut state = cache_budget_sweep_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.protected_paths.drain().collect()
}

fn finish_cache_budget_sweep(retry_soon: bool) {
    let mut state = cache_budget_sweep_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.running = false;
    if retry_soon {
        state.last_started = None;
    }
}

/// Guards the lifetime of any CK-owned build directory consumer.  A cache
/// sweep/clear takes the write side, while compile/upload/warmup consumers take
/// the read side.  Keep this separate from `cache_budget_compile_gate`: the
/// latter serializes compile-budget operations, and a consumer may legitimately
/// hold this read side while waiting for the budget read side.
fn cache_build_use_gate() -> &'static tokio::sync::RwLock<()> {
    static GATE: OnceLock<tokio::sync::RwLock<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::RwLock::new(()))
}

/// Serializes cache-budget operations after the build-use gate has been
/// acquired.  The lock order is always build-use -> budget -> board lock.
/// Keeping these two gates distinct prevents a queued budget writer from
/// deadlocking a task that already owns the outer build-use read guard.
fn cache_budget_compile_gate() -> &'static tokio::sync::RwLock<()> {
    static GATE: OnceLock<tokio::sync::RwLock<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::RwLock::new(()))
}

fn cache_consumer_pending_count() -> &'static AtomicUsize {
    static COUNT: AtomicUsize = AtomicUsize::new(0);
    &COUNT
}

fn any_cache_consumer_pending() -> bool {
    cache_consumer_pending_count().load(Ordering::Acquire) > 0
}

struct CacheConsumerPendingGuard;

impl CacheConsumerPendingGuard {
    fn new() -> Self {
        cache_consumer_pending_count().fetch_add(1, Ordering::AcqRel);
        Self
    }
}

impl Drop for CacheConsumerPendingGuard {
    fn drop(&mut self) {
        let _ = cache_consumer_pending_count().fetch_update(
            Ordering::AcqRel,
            Ordering::Acquire,
            |count| Some(count.saturating_sub(1)),
        );
    }
}

pub struct BuildCacheUseGuard {
    _read_guard: tokio::sync::RwLockReadGuard<'static, ()>,
    _pending_guard: CacheConsumerPendingGuard,
}

struct CacheBudgetSweepGuards {
    // Field order is intentional: the use writer is acquired before the
    // budget writer and is dropped after it (struct fields drop in declaration
    // order). Every cache mutation follows this same order so it cannot
    // deadlock a foreground reader.
    _budget: tokio::sync::RwLockWriteGuard<'static, ()>,
    _build_use: tokio::sync::RwLockWriteGuard<'static, ()>,
}

fn try_acquire_cache_budget_sweep_guards() -> Option<CacheBudgetSweepGuards> {
    let build_use = cache_build_use_gate().try_write().ok()?;
    let budget = cache_budget_compile_gate().try_write().ok()?;
    Some(CacheBudgetSweepGuards {
        _budget: budget,
        _build_use: build_use,
    })
}

async fn acquire_cache_budget_sweep_guards() -> CacheBudgetSweepGuards {
    let build_use = cache_build_use_gate().write().await;
    let budget = cache_budget_compile_gate().write().await;
    CacheBudgetSweepGuards {
        _budget: budget,
        _build_use: build_use,
    }
}

/// Protects a build directory across operations that consume artifacts after
/// compilation (notably upload and last-working-version recovery).
pub async fn protect_build_cache_use() -> BuildCacheUseGuard {
    // Publish intent before waiting. A sweep that already owns the write side
    // observes this counter and aborts its recursive walk, so a foreground
    // compile/upload is never hidden behind a full cache scan.
    let pending_guard = CacheConsumerPendingGuard::new();
    let read_guard = cache_build_use_gate().read().await;
    BuildCacheUseGuard {
        _read_guard: read_guard,
        _pending_guard: pending_guard,
    }
}

/// Keeps cache eviction out of the successful compile response path.
///
/// Cache eviction is storage housekeeping, not part of CK's toolchain,
/// artifact, Exact, or upload proofs. Ordinary sweeps are process-wide
/// single-flight, limited to once per ten minutes, and delayed off the response
/// path. Critical disk pressure and explicit maintenance remain synchronous.
/// The write side of `cache_build_use_gate` proves that no CK compile, warmup,
/// or upload can be using a build directory while candidates are scanned or
/// removed; the paired budget writer serializes other cache mutations.
pub fn maintain_cache_budget_after_success(
    limit_mb: u64,
    force_synchronous: bool,
    build_path: &Path,
    build_cache_use: BuildCacheUseGuard,
) {
    // Record and register the successful cache candidate while the caller still
    // owns the shared build-use guard. This closes the race where an older
    // delayed sweep could acquire the writer immediately after compilation and
    // delete the artifacts before this success became visible. The global
    // CK_Builds/metadata directory is independently pinned by the core walker.
    let access_records = ck_core::builder::accel::record_cache_candidate_accesses(build_path);
    let protected_paths = if access_records.is_empty() {
        log::warn!(
            "Successful build path is outside the recognized CK cache candidates: {}",
            build_path.display()
        );
        Vec::new()
    } else {
        access_records
            .into_iter()
            .map(|record| {
                if !record.access_recorded {
                    log::warn!(
                        "Could not refresh cache access marker for {}; protecting it for this sweep only",
                        record.protected_path.display()
                    );
                }
                record.protected_path
            })
            .collect()
    };
    let available_bytes = ck_core::builder::accel::available_cache_volume_bytes();
    let low_disk = available_bytes.is_some_and(|bytes| bytes < CACHE_BUDGET_LOW_DISK_BYTES);
    let effective_limit_mb = effective_cache_budget_limit_mb(limit_mb, available_bytes);
    let now = std::time::Instant::now();
    let action = {
        let mut state = cache_budget_sweep_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let action = cache_budget_action(
            limit_mb > 0 || low_disk || force_synchronous,
            state.running,
            state
                .last_started
                .map(|started| now.duration_since(started)),
            available_bytes,
            force_synchronous,
        );
        register_cache_budget_decision(&mut state, action, now, protected_paths);
        action
    };

    // The success is now durably timestamped and, when a sweep exists, present
    // in its explicit protection set. Release the consumer side before an
    // urgent synchronous sweep attempts to acquire the exclusive writer.
    drop(build_cache_use);

    match action {
        CacheBudgetAction::Skip => {}
        CacheBudgetAction::Synchronous => {
            if any_cache_consumer_pending() || any_manual_compile_pending() {
                finish_cache_budget_sweep(true);
                return;
            }
            let Some(_exclusive_build_cache) = try_acquire_cache_budget_sweep_guards() else {
                // A compile or warmup is active (or already queued with the
                // shared side). Retry after that operation instead of touching
                // a live Arduino build directory.
                finish_cache_budget_sweep(true);
                return;
            };
            // A foreground consumer may publish intent in the small window
            // between the initial check and acquiring the exclusive guards.
            // Use the cancellable walker even for the urgent path so it can
            // yield immediately instead of deleting a directory needed by the
            // newly arrived request.
            if any_cache_consumer_pending() || any_manual_compile_pending() {
                finish_cache_budget_sweep(true);
                return;
            }
            let protected_paths = take_cache_budget_protected_paths();
            match ck_core::builder::accel::enforce_cache_budget_cancellable_protecting(
                effective_limit_mb,
                &protected_paths,
                || any_cache_consumer_pending() || any_manual_compile_pending(),
            ) {
                Ok(true) => finish_cache_budget_sweep(false),
                Ok(false) => finish_cache_budget_sweep(true),
                Err(error) => {
                    log::warn!("Synchronous cache-budget enforcement failed: {error:#}");
                    finish_cache_budget_sweep(false);
                }
            }
        }
        CacheBudgetAction::Background => {
            tauri::async_runtime::spawn(async move {
                // Let response construction/IPC finish and give an immediately
                // requested follow-up compile the shared side first.
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                if any_cache_consumer_pending() || any_manual_compile_pending() {
                    finish_cache_budget_sweep(true);
                    return;
                }
                let Some(exclusive_build_cache) = try_acquire_cache_budget_sweep_guards() else {
                    finish_cache_budget_sweep(true);
                    return;
                };
                let protected_paths = take_cache_budget_protected_paths();
                let sweep = tauri::async_runtime::spawn_blocking(move || {
                    let _exclusive_build_cache = exclusive_build_cache;
                    ck_core::builder::accel::enforce_cache_budget_cancellable_protecting(
                        effective_limit_mb,
                        &protected_paths,
                        || any_cache_consumer_pending() || any_manual_compile_pending(),
                    )
                })
                .await;
                match sweep {
                    Ok(Ok(true)) => finish_cache_budget_sweep(false),
                    Ok(Ok(false)) => finish_cache_budget_sweep(true),
                    Ok(Err(error)) => {
                        log::warn!("Background cache-budget enforcement failed: {error:#}");
                        finish_cache_budget_sweep(false);
                    }
                    Err(error) => {
                        log::warn!("Background cache-budget task failed: {error}");
                        finish_cache_budget_sweep(true);
                    }
                }
            });
        }
    }
}

// Application shutdown is terminal for the process. Once armed, no startup,
// board-change, or edit warmup may publish another Arduino child after the
// exit coordinator has taken its cancellation snapshot.
static WARMUP_SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WarmupShutdownReport {
    pub initially_active: usize,
    pub remaining_active: usize,
    pub timed_out: bool,
}

fn warmup_shutdown_requested() -> bool {
    WARMUP_SHUTDOWN_REQUESTED.load(Ordering::Acquire)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct HotsetEvent {
    ts_ms: u128,
    fqbn: String,
    compile_ms: Option<u128>,
    cache_hit: Option<bool>,
    #[serde(default)]
    source: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
struct HotsetState {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    events: Vec<HotsetEvent>,
}

#[derive(Debug, Clone, Default)]
struct HotsetScore {
    recent_count: u32,
    last_seen_ms: u128,
    compile_sum_ms: u128,
    compile_count: u32,
}

#[derive(Debug, Clone)]
struct RankedBoard {
    fqbn: String,
    recent_count: u32,
    last_seen_ms: u128,
    avg_compile_ms: u128,
    original_idx: usize,
}

fn active_warmups() -> &'static tokio::sync::Mutex<HashMap<String, ActiveWarmup>> {
    static ACTIVE: OnceLock<tokio::sync::Mutex<HashMap<String, ActiveWarmup>>> = OnceLock::new();
    ACTIVE.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

fn pending_jobs() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

fn pending_job_overrides() -> &'static Mutex<HashMap<String, PrewarmJob>> {
    static MAP: OnceLock<Mutex<HashMap<String, PrewarmJob>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn prewarm_sender() -> &'static OnceLock<mpsc::Sender<PrewarmJob>> {
    static SENDER: OnceLock<mpsc::Sender<PrewarmJob>> = OnceLock::new();
    &SENDER
}

type WeakAsyncMutex = std::sync::Weak<tokio::sync::Mutex<()>>;

fn compile_lock_map() -> &'static Mutex<HashMap<String, WeakAsyncMutex>> {
    static MAP: OnceLock<Mutex<HashMap<String, WeakAsyncMutex>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn reusable_async_mutex_for_key(
    locks: &mut HashMap<String, WeakAsyncMutex>,
    key: String,
) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    // The registry coordinates active jobs; it must not own every board key forever.
    // Prune entries whose last foreground/background owner has already gone away.
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(std::sync::Weak::upgrade) {
        return lock;
    }

    let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(key, std::sync::Arc::downgrade(&lock));
    lock
}

fn manual_compile_targets() -> &'static Mutex<HashMap<String, usize>> {
    static MAP: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn manual_compile_pending_count() -> &'static AtomicUsize {
    static COUNT: AtomicUsize = AtomicUsize::new(0);
    &COUNT
}

fn hotset_io_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn board_capsule_key(fqbn: &str) -> String {
    normalize_base_fqbn(fqbn).unwrap_or_else(|| fqbn.to_string())
}

fn prepare_prewarm_job(
    sysroot: Sysroot,
    fqbn: String,
    code: Option<String>,
    build_signature_hint: Option<String>,
) -> (String, PrewarmJob) {
    let queue_key = board_capsule_key(&fqbn);
    let code_hash_hint = code.as_deref().map(stable_code_hash);
    (
        queue_key,
        PrewarmJob {
            sysroot,
            // Queue coalescing and compile locks intentionally use the base
            // board capsule, but the work itself must retain every option.
            fqbn,
            code,
            code_hash_hint,
            build_signature_hint,
        },
    )
}

pub fn stable_code_hash(code: &str) -> String {
    let normalized = code.replace("\r\n", "\n");
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in normalized.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn compile_lock_for(fqbn: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    let key = board_capsule_key(fqbn);
    let mut guard = match compile_lock_map().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    reusable_async_mutex_for_key(&mut guard, key)
}

fn increment_manual_compile_pending(key: &str) {
    manual_compile_pending_count().fetch_add(1, Ordering::AcqRel);
    if let Ok(mut guard) = manual_compile_targets().lock() {
        let count = guard.entry(key.to_string()).or_insert(0);
        *count = count.saturating_add(1);
    }
}

fn decrement_manual_compile_pending(key: &str) {
    if let Ok(mut guard) = manual_compile_targets().lock() {
        if let Some(count) = guard.get_mut(key) {
            if *count > 1 {
                *count -= 1;
            } else {
                guard.remove(key);
            }
        }
    }
    let _ =
        manual_compile_pending_count().fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
            Some(count.saturating_sub(1))
        });
}

fn any_manual_compile_pending() -> bool {
    manual_compile_pending_count().load(Ordering::Acquire) > 0
}

struct ManualCompilePendingGuard {
    key: String,
}

impl ManualCompilePendingGuard {
    fn new(target_fqbn: &str) -> Self {
        let key = board_capsule_key(target_fqbn);
        increment_manual_compile_pending(&key);
        Self { key }
    }
}

impl Drop for ManualCompilePendingGuard {
    fn drop(&mut self) {
        decrement_manual_compile_pending(&self.key);
    }
}

pub(crate) struct ForegroundCompilePriorityGuard {
    _manual_pending: ManualCompilePendingGuard,
}

/// Marks a user request as pending before library and toolchain identity work.
/// The later compile-lock guard remains authoritative for serialization; this
/// earlier guard only prevents optional prewarm work from starting in the
/// otherwise unprotected preparation window.
pub(crate) fn begin_foreground_compile_priority(
    target_fqbn: &str,
) -> ForegroundCompilePriorityGuard {
    invalidate_all_pending_jobs();
    ForegroundCompilePriorityGuard {
        _manual_pending: ManualCompilePendingGuard::new(target_fqbn),
    }
}

#[cfg(test)]
mod foreground_priority_tests {
    #[test]
    fn priority_guard_is_declared_before_compile_lock_api() {
        let source = include_str!("compile_accel.rs");
        let priority = source
            .find("pub(crate) fn begin_foreground_compile_priority")
            .expect("priority helper");
        let lock = source
            .find("pub async fn with_compile_lock_for<")
            .expect("foreground lock helper");
        assert!(priority < lock);
    }
}

fn invalidate_pending_job(queue_key: &str) {
    if let Ok(mut pending) = pending_jobs().lock() {
        pending.remove(queue_key);
    }
    if let Ok(mut overrides) = pending_job_overrides().lock() {
        overrides.remove(queue_key);
    }
}

fn invalidate_all_pending_jobs() {
    if let Ok(mut pending) = pending_jobs().lock() {
        pending.clear();
    }
    if let Ok(mut overrides) = pending_job_overrides().lock() {
        overrides.clear();
    }
}

/// Claims a queued warmup only after its per-board compile lock is held.
///
/// The pending membership deliberately survives channel receive and lock wait.
/// Foreground compile/cache-clear paths remove that membership as a cancellation
/// token, preventing an already-dequeued stale worker from running after them.
fn claim_pending_job_after_lock(queue_key: &str, fallback: PrewarmJob) -> Option<PrewarmJob> {
    let should_run = pending_jobs()
        .lock()
        .map(|mut pending| pending.remove(queue_key))
        .unwrap_or(true);
    if !should_run {
        if let Ok(mut overrides) = pending_job_overrides().lock() {
            overrides.remove(queue_key);
        }
        return None;
    }

    Some(
        pending_job_overrides()
            .lock()
            .ok()
            .and_then(|mut overrides| overrides.remove(queue_key))
            .unwrap_or(fallback),
    )
}

fn hotset_path(root: &PathBuf) -> PathBuf {
    ck_core::builder::accel::state_dir(root).join("prewarm_hotset_v2.json")
}

fn load_hotset_state(root: &PathBuf) -> HotsetState {
    let path = hotset_path(root);
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str::<HotsetState>(&raw)
            .ok()
            .filter(|state| state.version == HOTSET_SCHEMA_VERSION)
            .unwrap_or(HotsetState {
                version: HOTSET_SCHEMA_VERSION,
                events: Vec::new(),
            }),
        Err(_) => HotsetState {
            version: HOTSET_SCHEMA_VERSION,
            events: Vec::new(),
        },
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn replace_hotset_file(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<()> {
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
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn replace_hotset_file(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

fn save_hotset_state(root: &PathBuf, state: &HotsetState) -> Result<(), String> {
    let state_dir = ck_core::builder::accel::state_dir(root);
    std::fs::create_dir_all(&state_dir)
        .map_err(|e| format!("create state dir {} failed: {}", state_dir.display(), e))?;
    let path = hotset_path(root);
    let data = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    let temporary = state_dir.join(format!(
        "prewarm_hotset_v2.json.tmp-{}",
        uuid::Uuid::new_v4()
    ));
    let result = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(data.as_bytes())?;
        file.sync_all()?;
        replace_hotset_file(&temporary, &path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|e| format!("write hotset {} failed: {}", path.display(), e))
}

fn trim_hotset_events(state: &mut HotsetState, now: u128) {
    let cutoff = now.saturating_sub(HOTSET_RETENTION_MS);
    state.events.retain(|e| e.ts_ms >= cutoff);
    if state.events.len() > HOTSET_MAX_EVENTS {
        let drop_n = state.events.len().saturating_sub(HOTSET_MAX_EVENTS);
        state.events.drain(0..drop_n);
    }
    state.version = HOTSET_SCHEMA_VERSION;
}

pub fn record_board_activity(
    root: &PathBuf,
    fqbn: &str,
    compile_ms: Option<u128>,
    cache_hit: Option<bool>,
    source: &str,
) {
    let Some(complete_fqbn) = normalize_complete_fqbn(fqbn) else {
        return;
    };
    let _guard = match hotset_io_lock().lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let mut state = load_hotset_state(root);
    let now = now_ms();
    trim_hotset_events(&mut state, now);
    state.events.push(HotsetEvent {
        ts_ms: now,
        // Keep every option. Core snapshots deliberately reject base-FQBN
        // seeding for optioned boards, so collapsing here made startup prewarm
        // useless for FlashSize/partition/PSRAM configurations.
        fqbn: complete_fqbn,
        compile_ms,
        cache_hit,
        source: source.to_string(),
    });
    if let Err(e) = save_hotset_state(root, &state) {
        log::warn!("Failed to save hotset state: {}", e);
    }
}

fn startup_targets_from_hotset(root: &PathBuf, prewarm_boards: &[String]) -> Vec<String> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for fqbn in prewarm_boards {
        if let Some(complete) = normalize_complete_fqbn(fqbn) {
            if seen.insert(complete.clone()) {
                candidates.push(complete);
            }
        }
    }
    if candidates.is_empty() {
        return Vec::new();
    }

    let state = {
        let _guard = match hotset_io_lock().lock() {
            Ok(g) => g,
            Err(_) => return candidates.into_iter().take(STARTUP_PREWARM_TOP_N).collect(),
        };
        load_hotset_state(root)
    };
    let now = now_ms();
    let recent_cutoff = now.saturating_sub(HOTSET_WINDOW_MS);
    let candidate_set: HashSet<String> = candidates.iter().cloned().collect();
    let mut stats: HashMap<String, HotsetScore> = HashMap::new();

    for event in state.events {
        if !candidate_set.contains(&event.fqbn) {
            continue;
        }
        let entry = stats.entry(event.fqbn.clone()).or_default();
        if event.ts_ms > entry.last_seen_ms {
            entry.last_seen_ms = event.ts_ms;
        }
        if event.ts_ms >= recent_cutoff {
            entry.recent_count = entry.recent_count.saturating_add(1);
        }
        if let Some(ms) = event.compile_ms {
            entry.compile_sum_ms = entry.compile_sum_ms.saturating_add(ms);
            entry.compile_count = entry.compile_count.saturating_add(1);
        }
    }
    let targets_with_hotset_evidence: HashSet<String> = stats.keys().cloned().collect();
    // Bootstrap ranking from historical compile metrics so fresh installs/upgrades
    // still choose sensible startup targets before v2 hotset activity accumulates.
    // Once a target has real activity, metrics provide no second vote for the
    // same compile; this avoids double-counting one foreground operation.
    if let Ok(records) = read_compile_metric_records(root) {
        for record in records {
            let Some(complete_fqbn) = normalize_complete_fqbn(&record.fqbn) else {
                continue;
            };
            if !candidate_set.contains(&complete_fqbn) {
                continue;
            }
            if targets_with_hotset_evidence.contains(&complete_fqbn) {
                continue;
            }
            let entry = stats.entry(complete_fqbn).or_default();
            if record.timestamp_ms > entry.last_seen_ms {
                entry.last_seen_ms = record.timestamp_ms;
            }
            if record.timestamp_ms >= recent_cutoff {
                entry.recent_count = entry.recent_count.saturating_add(1);
            }
            entry.compile_sum_ms = entry.compile_sum_ms.saturating_add(record.cli_compile_ms);
            entry.compile_count = entry.compile_count.saturating_add(1);
        }
    }

    let mut ranked = Vec::with_capacity(candidates.len());
    for (idx, fqbn) in candidates.iter().enumerate() {
        let score = stats.get(fqbn).cloned().unwrap_or_default();
        let avg_compile_ms = if score.compile_count > 0 {
            score.compile_sum_ms / score.compile_count as u128
        } else {
            0
        };
        ranked.push(RankedBoard {
            fqbn: fqbn.clone(),
            recent_count: score.recent_count,
            last_seen_ms: score.last_seen_ms,
            avg_compile_ms,
            original_idx: idx,
        });
    }

    ranked.sort_by(|a, b| {
        b.recent_count
            .cmp(&a.recent_count)
            .then_with(|| b.last_seen_ms.cmp(&a.last_seen_ms))
            .then_with(|| b.avg_compile_ms.cmp(&a.avg_compile_ms))
            .then_with(|| a.original_idx.cmp(&b.original_idx))
    });

    let mut selected = Vec::new();
    let mut used_budget = 0u128;
    for board in ranked {
        if selected.len() >= STARTUP_PREWARM_TOP_N {
            break;
        }
        let estimate = if board.avg_compile_ms > 0 {
            board
                .avg_compile_ms
                .clamp(HOTSET_MIN_ESTIMATE_MS, HOTSET_MAX_ESTIMATE_MS)
        } else {
            HOTSET_DEFAULT_ESTIMATE_MS
        };
        if !selected.is_empty() && used_budget.saturating_add(estimate) > STARTUP_PREWARM_BUDGET_MS
        {
            continue;
        }
        used_budget = used_budget.saturating_add(estimate);
        selected.push(board.fqbn);
    }

    if selected.is_empty() {
        let fallback_n = STARTUP_PREWARM_TOP_N.min(candidates.len());
        return candidates.into_iter().take(fallback_n.max(1)).collect();
    }
    selected
}

/// Returns the bounded startup selection without exposing the hotset storage
/// details to Tauri commands. Manual "prewarm now" must follow the same TOP-N
/// policy as automatic startup instead of expanding every installed board.
pub fn select_startup_prewarm_targets(root: &PathBuf, prewarm_boards: &[String]) -> Vec<String> {
    startup_targets_from_hotset(root, prewarm_boards)
}

/// Returns the most recently observed complete targets. This is used only to
/// migrate/compact the old settings list that historically contained the full
/// installed-board inventory. Hotset activity wins; bounded compile metrics are
/// the fallback for machines upgrading before the v2 hotset has accumulated.
pub fn recent_complete_prewarm_targets(root: &PathBuf, limit: usize) -> Vec<String> {
    if limit == 0 {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let state = {
        let _guard = match hotset_io_lock().lock() {
            Ok(guard) => guard,
            Err(_) => return Vec::new(),
        };
        load_hotset_state(root)
    };
    for event in state.events.iter().rev() {
        let Some(fqbn) = normalize_complete_fqbn(&event.fqbn) else {
            continue;
        };
        if seen.insert(fqbn.clone()) {
            out.push(fqbn);
            if out.len() >= limit {
                return out;
            }
        }
    }

    if let Ok(records) = read_compile_metric_records(root) {
        for record in records.iter().rev() {
            let Some(fqbn) = normalize_complete_fqbn(&record.fqbn) else {
                continue;
            };
            if seen.insert(fqbn.clone()) {
                out.push(fqbn);
                if out.len() >= limit {
                    break;
                }
            }
        }
    }
    out
}

pub async fn with_compile_lock_for<F, Fut, T>(target_fqbn: &str, f: F) -> T
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = T>,
{
    let target_key = board_capsule_key(target_fqbn);
    let _manual_pending_guard = ManualCompilePendingGuard::new(&target_key);
    // Callers normally hold the outer build-use read guard for the whole
    // command.  This budget read is deliberately a *different* gate, so a
    // queued cache-sweep writer cannot block a re-entrant read and deadlock the
    // command while it still owns the outer use guard.
    let _cache_budget_read_guard = cache_budget_compile_gate().read().await;

    // Foreground work always wins. A same-board warmup owns this exact build
    // directory, so preserving it here can make the user wait for an entire
    // background full build before their (often 10-second) relink can start.
    // Cancel every active warmup, including a seemingly compatible same-board
    // one. The worker keeps the lock until arduino-cli has stopped, which still
    // prevents concurrent writes to the build directory.
    {
        let mut guard = active_warmups().lock().await;
        for active in guard.values_mut() {
            let _ = active.cancel_tx.send(true);
        }
    }

    let wait_start = std::time::Instant::now();
    let lock = compile_lock_for(&target_key);
    let _guard = lock.lock().await;
    let wait_ms = wait_start.elapsed().as_millis();
    if wait_ms > 300 {
        log::warn!(
            "[CompileLock] Waited {} ms for compile lock ({})",
            wait_ms,
            target_key
        );
    }
    let out = f().await;
    out
}

/// Foreground lock acquisition that can be canceled safely while queued. Once
/// the lock is acquired, the supplied build future remains responsible for
/// process-tree termination and waiting before it returns.
pub async fn with_compile_lock_for_cancellable<F, Fut, T>(
    target_fqbn: &str,
    cancellation: &ck_core::builder::demo::BuildCancellation,
    f: F,
) -> Result<T, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = T>,
{
    let target_key = board_capsule_key(target_fqbn);
    let _manual_pending_guard = ManualCompilePendingGuard::new(&target_key);
    // See with_compile_lock_for: build-use is acquired by the command entry
    // point, while this independent budget read serializes cache mutations.
    let _cache_budget_read_guard = cache_budget_compile_gate().read().await;
    {
        let mut guard = active_warmups().lock().await;
        for active in guard.values_mut() {
            let _ = active.cancel_tx.send(true);
        }
    }

    if cancellation.is_cancelled() {
        return Err(format!(
            "{}: build cancelled while waiting for compile lock",
            ck_core::builder::demo::BUILD_CANCELED_MARKER
        ));
    }
    let wait_start = std::time::Instant::now();
    let lock = compile_lock_for(&target_key);
    let mut cancel_rx = cancellation.subscribe();
    let guard = tokio::select! {
        biased;
        changed = cancel_rx.changed() => {
            if changed.is_ok() && *cancel_rx.borrow() {
                return Err(format!(
                    "{}: build cancelled while waiting for compile lock",
                    ck_core::builder::demo::BUILD_CANCELED_MARKER
                ));
            }
            lock.lock().await
        }
        guard = lock.lock() => guard,
    };
    if cancellation.is_cancelled() {
        drop(guard);
        return Err(format!(
            "{}: build cancelled before compiler start",
            ck_core::builder::demo::BUILD_CANCELED_MARKER
        ));
    }
    let wait_ms = wait_start.elapsed().as_millis();
    if wait_ms > 300 {
        log::warn!(
            "[CompileLock] Waited {} ms for compile lock ({})",
            wait_ms,
            target_key
        );
    }
    let output = f().await;
    drop(guard);
    Ok(output)
}

/// A silent-mode variant of `with_compile_lock_for`.
/// Silent precompiles should NEVER block a user-triggered compile.
/// If a manual compile is already pending (or becomes pending while waiting),
/// this function returns `None` immediately instead of waiting.
pub async fn with_compile_lock_for_silent<F, Fut, T>(target_fqbn: &str, f: F) -> Option<T>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = T>,
{
    let target_key = board_capsule_key(target_fqbn);

    // 1. Bail immediately if any manual compile is already pending.
    if any_manual_compile_pending() {
        log::info!(
            "[CompileLock] Silent compile skipped: manual compile pending while scheduling {}",
            target_key
        );
        return None;
    }

    let Ok(_cache_budget_read_guard) = cache_budget_compile_gate().try_read() else {
        log::info!(
            "[CompileLock] Silent compile skipped while cache maintenance owns the build cache"
        );
        return None;
    };

    // 2. Try to acquire the lock with a short timeout.
    //    If the lock is held by a real compile, bail out immediately (don't wait).
    let lock = compile_lock_for(&target_key);
    let lock_result =
        tokio::time::timeout(std::time::Duration::from_millis(200), lock.lock()).await;

    let _guard = match lock_result {
        Ok(g) => g,
        Err(_) => {
            // Lock held by someone else; don't block the user's compile.
            log::info!(
                "[CompileLock] Silent compile skipped: could not acquire lock within 200ms for {}",
                target_key
            );
            return None;
        }
    };

    // 3. Check again with lock held — a manual compile may have arrived during the 200ms window.
    if any_manual_compile_pending() {
        log::info!(
            "[CompileLock] Silent compile aborted: manual compile pending after lock acquire for {}",
            target_key
        );
        return None;
    }

    Some(f().await)
}

pub async fn with_compile_lock<F, Fut, T>(f: F) -> T
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = T>,
{
    with_compile_lock_for("__global__", f).await
}

pub async fn cancel_running_warmup() {
    let mut guard = active_warmups().lock().await;
    for active in guard.values_mut() {
        let _ = active.cancel_tx.send(true);
    }
}

/// Terminal application-shutdown path. It rejects new queue entries, removes
/// jobs that have not started, signals every active worker, and does not return
/// until each worker has reaped its Arduino child (or the explicit deadline is
/// reached). Normal foreground prioritization continues to use
/// cancel_running_warmup() and therefore does not permanently close the queue.
pub async fn shutdown_running_warmups(timeout: std::time::Duration) -> WarmupShutdownReport {
    WARMUP_SHUTDOWN_REQUESTED.store(true, Ordering::Release);
    invalidate_all_pending_jobs();

    let started = std::time::Instant::now();
    let initially_active = {
        let mut active = active_warmups().lock().await;
        for warmup in active.values_mut() {
            let _ = warmup.cancel_tx.send(true);
        }
        active.len()
    };

    loop {
        let remaining_active = {
            let mut active = active_warmups().lock().await;
            for warmup in active.values_mut() {
                let _ = warmup.cancel_tx.send(true);
            }
            active.len()
        };
        if remaining_active == 0 {
            return WarmupShutdownReport {
                initially_active,
                remaining_active: 0,
                timed_out: false,
            };
        }
        if started.elapsed() >= timeout {
            return WarmupShutdownReport {
                initially_active,
                remaining_active,
                timed_out: true,
            };
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

/// 在 warmup 已启动后补全其 build_signature_hint。
/// 场景：代码编辑触发 warmup 时 signature 未知（传 None），
/// compile_sketch 完成 library scan 后调用此函数将 signature 填进去，
/// 避免因 signature="-" 与已计算的 signature 不等而误触发 hint mismatch cancel。
pub async fn update_active_warmup_hints(
    target_fqbn: &str,
    code_hash_hint: &str,
    build_signature_hint: &str,
) {
    let target_key = board_capsule_key(target_fqbn);
    let mut guard = active_warmups().lock().await;
    if let Some(active) = guard.get_mut(&target_key) {
        // 只在 code hash 匹配、且 signature 尚未设置时补全，防止误覆盖
        if active.fqbn == target_fqbn
            && active.code_hash_hint.as_deref() == Some(code_hash_hint)
            && active.build_signature_hint.is_none()
        {
            log::info!(
                "[CompileLock] Patching warmup build_signature hint for {} (code matched, sig was None)",
                target_key
            );
            active.build_signature_hint = Some(build_signature_hint.to_string());
        }
    }
}

pub async fn prioritize_manual_compile(target_fqbn: &str) {
    let _ = prioritize_manual_compile_with_hints(target_fqbn, None, None).await;
}

pub async fn prioritize_manual_compile_with_hints(
    target_fqbn: &str,
    code_hash_hint: Option<String>,
    build_signature_hint: Option<String>,
) -> bool {
    let target_key = board_capsule_key(target_fqbn);

    // Drop queued warmups outright. Re-queueing can happen after the foreground
    // compile finishes, and keeping old jobs around only increases contention.
    invalidate_all_pending_jobs();

    // Always cancel active warmups so a user-triggered compile is never queued
    // behind background work. Matching code/signature only means the resulting
    // cache is reusable; it does not justify making the foreground wait for a
    // potentially minutes-long ESP32 warmup.
    let mut guard = active_warmups().lock().await;
    for (active_key, active) in guard.iter_mut() {
        if active_key == &target_key {
            let matches_exact_target = active.fqbn == target_fqbn;
            let matches_active_code =
                match (code_hash_hint.as_deref(), active.code_hash_hint.as_deref()) {
                    (Some(a), Some(b)) => a == b,
                    _ => false,
                };
            let matches_active_signature = match (
                build_signature_hint.as_deref(),
                active.build_signature_hint.as_deref(),
            ) {
                (Some(a), Some(b)) => a == b,
                _ => false,
            };
            if active.stage == WarmupStage::QuickFast {
                let req_code = code_hash_hint.as_deref().unwrap_or("-");
                let act_code = active.code_hash_hint.as_deref().unwrap_or("-");
                let req_sig = build_signature_hint.as_deref().unwrap_or("-");
                let act_sig = active.build_signature_hint.as_deref().unwrap_or("-");
                let req_code_s = &req_code[..req_code.len().min(12)];
                let act_code_s = &act_code[..act_code.len().min(12)];
                let req_sig_s = &req_sig[..req_sig.len().min(12)];
                let act_sig_s = &act_sig[..act_sig.len().min(12)];
                if matches_exact_target && matches_active_code && matches_active_signature {
                    log::info!(
                        "[CompileLock] Cancel compatible warmup for {} to prioritize foreground compile",
                        target_key
                    );
                } else {
                    log::info!(
                        "[CompileLock] Cancel warmup for {} due hint mismatch (code {} != {}, sig {} != {})",
                        target_key,
                        req_code_s,
                        act_code_s,
                        req_sig_s,
                        act_sig_s
                    );
                }
            }
        } else {
            log::info!(
                "[CompileLock] Cancel warmup for {} because foreground compile is prioritizing {}",
                active_key,
                target_key
            );
        }
        let _ = active.cancel_tx.send(true);
    }
    false
}

pub async fn clear_board_compile_cache(
    sysroot: &Sysroot,
    target_fqbn: &str,
) -> Result<ck_core::builder::demo::BoardCompileCacheClearReport, String> {
    let target_key = board_capsule_key(target_fqbn);
    let _manual_pending_guard = ManualCompilePendingGuard::new(&target_key);
    // Cache clear is a writer: acquire the global build-cache gate before the
    // per-board lock so it cannot delete artifacts used by compile/upload and
    // cannot invert the read-gate -> board-lock order used by compilers.

    invalidate_pending_job(&target_key);
    {
        let mut active = active_warmups().lock().await;
        if let Some(warmup) = active.get_mut(&target_key) {
            let _ = warmup.cancel_tx.send(true);
        }
    }
    let _cache_budget_write_guards = acquire_cache_budget_sweep_guards().await;

    let lock = compile_lock_for(&target_key);
    let _guard = lock.lock().await;
    ck_core::builder::demo::request_board_compile_cache_rebuild(sysroot, target_fqbn)
        .map_err(|error| error.to_string())
}

/// Clear CK-owned caches for an exact target while preserving reusable global
/// ccache objects. This benchmark-only path intentionally differs from the
/// user-facing hard refresh above, which arms a forced ccache recache.
pub async fn clear_board_first_project_compile_cache(
    sysroot: &Sysroot,
    target_fqbn: &str,
) -> Result<ck_core::builder::demo::BoardCompileCacheClearReport, String> {
    let target_key = board_capsule_key(target_fqbn);
    let _manual_pending_guard = ManualCompilePendingGuard::new(&target_key);

    invalidate_pending_job(&target_key);
    {
        let mut active = active_warmups().lock().await;
        if let Some(warmup) = active.get_mut(&target_key) {
            let _ = warmup.cancel_tx.send(true);
        }
    }
    let _cache_budget_write_guards = acquire_cache_budget_sweep_guards().await;

    // The active worker owns this same per-board lock until its Arduino child
    // has stopped. Waiting here prevents a canceled warmup from recreating the
    // just-cleared cache after the benchmark reset returns.
    let lock = compile_lock_for(&target_key);
    let _guard = lock.lock().await;
    ck_core::builder::demo::clear_board_compile_cache_for_first_project(sysroot, target_fqbn)
        .map_err(|error| error.to_string())
}

pub async fn clear_board_ready_install_project_compile_cache(
    sysroot: &Sysroot,
    target_fqbn: &str,
) -> Result<ck_core::builder::demo::BoardCompileCacheClearReport, String> {
    let target_key = board_capsule_key(target_fqbn);
    let _manual_pending_guard = ManualCompilePendingGuard::new(&target_key);

    invalidate_pending_job(&target_key);
    {
        let mut active = active_warmups().lock().await;
        if let Some(warmup) = active.get_mut(&target_key) {
            let _ = warmup.cancel_tx.send(true);
        }
    }
    let _cache_budget_write_guards = acquire_cache_budget_sweep_guards().await;

    let lock = compile_lock_for(&target_key);
    let _guard = lock.lock().await;
    let report = ck_core::builder::demo::clear_board_compile_cache_for_ready_install_project(
        sysroot,
        target_fqbn,
    )
    .map_err(|error| error.to_string())?;
    if !report.prebuilt_core_preserved || !report.prebuilt_core_validated {
        return Err(
            "Ready-install cold refused to continue without a validated exact-target Core"
                .to_string(),
        );
    }
    Ok(report)
}

pub fn load_settings(root: &PathBuf) -> CompileAccelSettings {
    let settings = load_compile_accel_settings(root);
    let settings_path = ck_core::builder::accel::compile_accel_path(root);
    if !settings_path.exists() {
        let _ = save_compile_accel_settings(root, &settings);
    }
    settings
}

pub fn update_settings<T, F>(root: &PathBuf, update: F) -> Result<T, String>
where
    F: FnOnce(&mut CompileAccelSettings) -> T,
{
    update_compile_accel_settings(root, update).map_err(|error| error.to_string())
}

pub fn metrics_jsonl(root: &PathBuf) -> Result<String, String> {
    read_compile_metrics_jsonl(root).map_err(|e| e.to_string())
}

pub fn push_metric(root: &PathBuf, record: &CompileMetricRecord) {
    if let Err(e) = append_compile_metric(root, record) {
        log::warn!("Failed to append compile metric: {}", e);
    }
}

fn ensure_worker(worker_count: u32) -> mpsc::Sender<PrewarmJob> {
    if let Some(existing) = prewarm_sender().get() {
        return existing.clone();
    }

    let (tx, rx) = mpsc::channel::<PrewarmJob>(64);
    let _ = prewarm_sender().set(tx.clone());

    let workers = worker_count.max(1).min(4);
    let shared_rx = std::sync::Arc::new(tokio::sync::Mutex::new(rx));
    for _ in 0..workers {
        let rx_ref = shared_rx.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let maybe_job = {
                    let mut guard = rx_ref.lock().await;
                    guard.recv().await
                };
                let Some(job) = maybe_job else {
                    break;
                };
                let queued_key = board_capsule_key(&job.fqbn);

                if warmup_shutdown_requested() {
                    invalidate_pending_job(&queued_key);
                    continue;
                }

                if any_manual_compile_pending() {
                    invalidate_pending_job(&queued_key);
                    continue;
                }

                let settings = load_compile_accel_settings(&job.sysroot.root_dir);
                let jobs = settings.effective_jobs();

                // A managed Core/index install owns the exclusive side of
                // this gate. Hold the shared side from identity resolution
                // through both warmup profiles so package files cannot change
                // between CK Forge authentication and compiler consumption.
                let _managed_package_read_guard =
                    crate::managed_package_mutation_gate().read().await;
                // Warmups are standalone build-directory consumers. Match the
                // foreground command order: managed package -> build use ->
                // budget -> board. The cache reads stay non-blocking so a
                // housekeeping writer can discard this optional warmup.
                let Ok(_cache_build_use_guard) = cache_build_use_gate().try_read() else {
                    invalidate_pending_job(&queued_key);
                    continue;
                };
                let Ok(_cache_budget_read_guard) = cache_budget_compile_gate().try_read() else {
                    invalidate_pending_job(&queued_key);
                    continue;
                };
                if any_manual_compile_pending() || warmup_shutdown_requested() {
                    invalidate_pending_job(&queued_key);
                    continue;
                }

                // Full Core/toolchain content authentication can be expensive
                // on the first process run. Keep it off the async/UI executor
                // and do it before taking the board compile lock, so a manual
                // build is never queued behind background identity scanning.
                let gate_sysroot = job.sysroot.clone();
                let gate_fqbn = job.fqbn.clone();
                let forge_prewarm_profiles = tauri::async_runtime::spawn_blocking(move || {
                    crate::forge_prewarm_profile_plan(&gate_sysroot, &gate_fqbn)
                })
                .await
                .unwrap_or_default();
                if forge_prewarm_profiles.is_empty() {
                    invalidate_pending_job(&queued_key);
                    log::info!(
                        "[AUTO PREWARM] CK Forge rejected warmup after Core/toolchain authentication: {}",
                        job.fqbn
                    );
                    continue;
                }

                let capsule_key = board_capsule_key(&job.fqbn);
                // Warmup and foreground compilation write the same per-board build directory.
                // They must share one lock; foreground cancellation makes an active warmup
                // release it quickly without allowing the two arduino-cli processes to race.
                let lock = compile_lock_for(&capsule_key);
                let _guard = lock.lock().await;
                if warmup_shutdown_requested() {
                    invalidate_pending_job(&queued_key);
                    continue;
                }
                let Some(job) = claim_pending_job_after_lock(&queued_key, job) else {
                    log::info!(
                        "[AUTO PREWARM] Dropped stale dequeued warmup after lock acquire: {}",
                        queued_key
                    );
                    continue;
                };
                if any_manual_compile_pending() || warmup_shutdown_requested() {
                    continue;
                }
                let (cancel_tx, cancel_rx) = watch::channel(false);
                {
                    let mut active = active_warmups().lock().await;
                    active.insert(
                        capsule_key.clone(),
                        ActiveWarmup {
                            cancel_tx: cancel_tx.clone(),
                            stage: if forge_prewarm_profiles.first()
                                == Some(&ck_core::builder::demo::CompileProfile::PortableFast)
                            {
                                WarmupStage::PortableFast
                            } else {
                                WarmupStage::QuickFast
                            },
                            fqbn: job.fqbn.clone(),
                            code_hash_hint: job.code_hash_hint.clone(),
                            build_signature_hint: job.build_signature_hint.clone(),
                        },
                    );
                }

                // Close the race between the pre-registration pending check and
                // publishing ActiveWarmup. If foreground work arrived in that
                // window it could not send cancellation because there was no
                // active entry yet. Re-check now, before spawning arduino-cli.
                if any_manual_compile_pending()
                    || warmup_shutdown_requested()
                    || *cancel_rx.borrow()
                {
                    let mut active = active_warmups().lock().await;
                    active.remove(&capsule_key);
                    continue;
                }

                // Profile 1: either specialized QuickFast or the portable
                // Core-agnostic cache lane. PortableFast never invokes
                // Fast Relink/direct-link.
                let _ = ck_core::builder::demo::warmup_sketch_with_cancel(
                    &job.sysroot,
                    &job.fqbn,
                    job.code.clone(),
                    jobs,
                    forge_prewarm_profiles[0],
                    cancel_rx.clone(),
                    job.build_signature_hint.clone(),
                )
                .await;
                // Profile 2: shared-fast upload-ready cache (for upload compile latency).
                // For code-aware edit warmup, quick-fast is enough and avoids duplicate long builds.
                let run_shared_fast = forge_prewarm_profiles
                    .contains(&ck_core::builder::demo::CompileProfile::SharedFast)
                    && job.code.is_none()
                    && pending_jobs()
                        .lock()
                        .map(|queued| queued.is_empty())
                        .unwrap_or(true);
                if run_shared_fast
                    && !any_manual_compile_pending()
                    && !warmup_shutdown_requested()
                    && !*cancel_rx.borrow()
                {
                    {
                        let mut active = active_warmups().lock().await;
                        if let Some(a) = active.get_mut(&capsule_key) {
                            a.stage = WarmupStage::SharedFast;
                        }
                    }
                    let _ = ck_core::builder::demo::warmup_sketch_with_cancel(
                        &job.sysroot,
                        &job.fqbn,
                        job.code,
                        jobs,
                        ck_core::builder::demo::CompileProfile::SharedFast,
                        cancel_rx.clone(),
                        None,
                    )
                    .await;
                }
                let mut active = active_warmups().lock().await;
                active.remove(&capsule_key);
            }
        });
    }

    tx
}

fn prepare_default_prewarm_job(sysroot: Sysroot, fqbn: String) -> (String, PrewarmJob) {
    // Default/startup work is deliberately board-level. Carrying the canonical
    // seed as source code would overwrite the single exact-project cache slot.
    // A code-less warmup cannot exact-match a foreground request, and the worker
    // authenticates its Core independently. Avoid the otherwise redundant
    // canonical library/toolchain signature scan on this scheduling path.
    prepare_prewarm_job(sysroot, fqbn, None, None)
}

pub async fn enqueue_warmup(sysroot: Sysroot, fqbn: String, code: Option<String>) {
    enqueue_warmup_with_signature(sysroot, fqbn, code, None).await;
}

pub async fn enqueue_default_prewarm(sysroot: Sysroot, fqbn: String) {
    // A default/startup request prepares board cores only. It must never put
    // the canonical seed sketch into the single exact-code cache slot, because
    // that would evict the user's last project warmup on every application
    // start. Workspace code-aware warmup remains responsible for exact source.
    let (fqbn_key, job) = prepare_default_prewarm_job(sysroot, fqbn);
    enqueue_prepared_warmup(fqbn_key, job).await;
}

pub async fn enqueue_warmup_with_signature(
    sysroot: Sysroot,
    fqbn: String,
    code: Option<String>,
    build_signature_hint: Option<String>,
) {
    let (fqbn_key, job) = prepare_prewarm_job(sysroot, fqbn, code, build_signature_hint);
    enqueue_prepared_warmup(fqbn_key, job).await;
}

async fn enqueue_prepared_warmup(fqbn_key: String, job: PrewarmJob) {
    if warmup_shutdown_requested() {
        log::info!("[AUTO PREWARM] Ignored warmup request during application shutdown");
        return;
    }
    if !crate::forge_prewarm_candidate_allowed(&job.sysroot, &job.fqbn) {
        log::info!(
            "[AUTO PREWARM] CK Forge skipped unqualified fast warmup for {}; platform-native build remains available",
            job.fqbn
        );
        return;
    }
    if let Ok(mut overrides) = pending_job_overrides().lock() {
        overrides.insert(fqbn_key.clone(), job.clone());
    }

    let should_enqueue = {
        if let Ok(mut guard) = pending_jobs().lock() {
            guard.insert(fqbn_key.clone())
        } else {
            true
        }
    };
    if !should_enqueue {
        return;
    }

    let settings = load_compile_accel_settings(&job.sysroot.root_dir);
    let sender = ensure_worker(settings.prewarm_concurrency);
    if sender.send(job).await.is_err() {
        invalidate_pending_job(&fqbn_key);
        log::warn!("Prewarm scheduler channel closed");
    }
}

pub async fn startup_prewarm(sysroot: Sysroot) {
    let settings = load_settings(&sysroot.root_dir);
    if !settings.prewarm_on_startup {
        return;
    }
    if settings.prewarm_boards.is_empty() {
        return;
    }
    let targets = startup_targets_from_hotset(&sysroot.root_dir, &settings.prewarm_boards);
    if targets.is_empty() {
        return;
    }
    log::info!(
        "[AUTO PREWARM] Startup hotset selected {}/{} board(s): {}",
        targets.len(),
        settings.prewarm_boards.len(),
        targets.join(", ")
    );
    for board in targets {
        enqueue_default_prewarm(sysroot.clone(), board).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_budget_decision_throttles_normal_and_repeated_low_disk_work() {
        assert_eq!(
            cache_budget_action(true, false, None, Some(10 * 1024 * 1024 * 1024), false),
            CacheBudgetAction::Background
        );
        assert_eq!(
            cache_budget_action(
                true,
                false,
                Some(CACHE_BUDGET_THROTTLE - std::time::Duration::from_millis(1)),
                Some(10 * 1024 * 1024 * 1024),
                false,
            ),
            CacheBudgetAction::Skip
        );
        assert_eq!(
            cache_budget_action(
                true,
                false,
                Some(CACHE_BUDGET_THROTTLE),
                Some(10 * 1024 * 1024 * 1024),
                false,
            ),
            CacheBudgetAction::Background
        );
        assert_eq!(
            cache_budget_action(
                true,
                false,
                Some(std::time::Duration::from_secs(1)),
                Some(CACHE_BUDGET_LOW_DISK_BYTES - 1),
                false,
            ),
            CacheBudgetAction::Skip,
            "a nearly full disk must not add a recursive sweep to every hot compile"
        );
        assert_eq!(
            cache_budget_action(
                true,
                false,
                Some(CACHE_BUDGET_THROTTLE),
                Some(CACHE_BUDGET_LOW_DISK_BYTES - 1),
                false,
            ),
            CacheBudgetAction::Synchronous
        );
        assert_eq!(
            cache_budget_action(
                true,
                false,
                Some(std::time::Duration::from_secs(1)),
                Some(10 * 1024 * 1024 * 1024),
                true,
            ),
            CacheBudgetAction::Synchronous
        );
        assert_eq!(
            cache_budget_action(true, true, None, Some(0), true),
            CacheBudgetAction::Skip,
            "single-flight must win even under a force request"
        );
        assert_eq!(
            cache_budget_action(false, false, None, Some(0), true),
            CacheBudgetAction::Skip,
            "a disabled cache budget must never start a recursive scan"
        );
        assert_eq!(
            effective_cache_budget_limit_mb(2048, Some(CACHE_BUDGET_LOW_DISK_BYTES - 1)),
            CACHE_BUDGET_EMERGENCY_LIMIT_MB,
            "critical disk pressure must lower a permissive configured limit so cleanup releases space"
        );
        assert_eq!(
            effective_cache_budget_limit_mb(256, Some(CACHE_BUDGET_LOW_DISK_BYTES - 1)),
            256,
            "emergency mode must not loosen an already stricter user limit"
        );
        assert_eq!(
            effective_cache_budget_limit_mb(0, Some(CACHE_BUDGET_LOW_DISK_BYTES - 1)),
            CACHE_BUDGET_EMERGENCY_LIMIT_MB,
            "critical disk pressure must override an unlimited-cache setting"
        );
        assert_eq!(
            effective_cache_budget_limit_mb(2048, Some(CACHE_BUDGET_LOW_DISK_BYTES)),
            2048
        );
    }

    #[test]
    fn running_sweep_collects_successes_from_single_flight_skips() {
        let now = std::time::Instant::now();
        let first = PathBuf::from("first-success");
        let second = PathBuf::from("second-success");
        let throttled = PathBuf::from("throttled-without-sweep");
        let mut state = CacheBudgetSweepState::default();

        register_cache_budget_decision(
            &mut state,
            CacheBudgetAction::Background,
            now,
            vec![first.clone()],
        );
        register_cache_budget_decision(
            &mut state,
            CacheBudgetAction::Skip,
            now,
            vec![second.clone()],
        );
        assert!(state.protected_paths.contains(&first));
        assert!(state.protected_paths.contains(&second));

        state.running = false;
        state.protected_paths.clear();
        register_cache_budget_decision(&mut state, CacheBudgetAction::Skip, now, vec![throttled]);
        assert!(
            state.protected_paths.is_empty(),
            "a throttled invocation with no active sweep relies on its persistent LRU marker"
        );
    }

    #[tokio::test]
    async fn cache_budget_write_side_excludes_compile_and_upload_readers() {
        let _serial = coordinator_test_lock().lock().await;
        let reader = protect_build_cache_use().await;
        assert!(cache_build_use_gate().try_write().is_err());
        assert!(
            cache_budget_compile_gate().try_write().is_ok(),
            "the independent budget gate must not be recursively held by the outer use guard"
        );
        drop(reader);
        assert!(cache_build_use_gate().try_write().is_ok());
    }

    #[tokio::test]
    async fn waiting_cache_consumer_publishes_abort_intent_before_read_lock() {
        let _serial = coordinator_test_lock().lock().await;
        let writer = cache_build_use_gate().write().await;
        let waiter = tokio::spawn(async { protect_build_cache_use().await });
        tokio::time::timeout(std::time::Duration::from_millis(250), async {
            while !any_cache_consumer_pending() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("waiting consumer should publish pending intent");
        drop(writer);
        let reader = waiter.await.expect("cache consumer guard");
        drop(reader);
        assert!(!any_cache_consumer_pending());
    }

    #[tokio::test]
    async fn outer_use_reader_can_enter_compile_budget_with_use_writer_queued() {
        let _serial = coordinator_test_lock().lock().await;
        let fqbn = "test:avr:outer_use_budget_reentry";
        reset_test_target(fqbn).await;

        // Model a foreground command after its command-boundary build-use
        // guard, then queue the writer used by cache clear/eviction.
        let outer_use_reader = protect_build_cache_use().await;
        let queued_writer = tokio::spawn(async {
            let _writer = cache_build_use_gate().write().await;
        });
        tokio::task::yield_now().await;
        assert!(
            cache_build_use_gate().try_write().is_err(),
            "the cache writer should be queued behind the command-boundary reader"
        );

        // Tokio RwLock is write-preferring.  If both layers used one gate,
        // this read would wait behind queued_writer while still owning
        // outer_use_reader, producing a permanent deadlock.
        let compile =
            tokio::spawn(async move { with_compile_lock_for(fqbn, || async { "compiled" }).await });
        let result = tokio::time::timeout(std::time::Duration::from_millis(500), compile)
            .await
            .expect("independent budget reader must not deadlock behind a use writer")
            .expect("compile task");
        assert_eq!(result, "compiled");

        drop(outer_use_reader);
        tokio::time::timeout(std::time::Duration::from_millis(500), queued_writer)
            .await
            .expect("use writer should enter after the outer reader drops")
            .expect("use writer task");
        reset_test_target(fqbn).await;
    }

    #[test]
    fn compile_lock_registry_reuses_active_locks_without_retaining_stale_keys() {
        let mut locks = HashMap::new();
        let anchor = reusable_async_mutex_for_key(&mut locks, "anchor".to_string());
        let same_anchor = reusable_async_mutex_for_key(&mut locks, "anchor".to_string());
        assert!(
            std::sync::Arc::ptr_eq(&anchor, &same_anchor),
            "concurrent work for one board must share the same mutex"
        );
        drop(same_anchor);

        for index in 0..1_000 {
            let temporary = reusable_async_mutex_for_key(&mut locks, format!("board-{index}"));
            drop(temporary);
        }

        let anchor_again = reusable_async_mutex_for_key(&mut locks, "anchor".to_string());
        assert!(std::sync::Arc::ptr_eq(&anchor, &anchor_again));
        assert!(
            locks.len() <= 2,
            "only active locks and at most the newest stale weak entry may remain"
        );
    }

    #[test]
    fn startup_ranking_consumes_the_bounded_core_metric_reader() {
        let root = std::env::temp_dir().join(format!(
            "ck-startup-metrics-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let timestamp = now_ms();
        for (offset, fqbn) in [
            (0u128, "esp32:esp32:esp32c6:FlashSize=16M"),
            (1, "esp32:esp32:esp32c6:FlashSize=16M"),
            (2, "esp32:esp32:esp32c3"),
        ] {
            append_compile_metric(
                &root,
                &CompileMetricRecord {
                    timestamp_ms: timestamp + offset,
                    fqbn: fqbn.to_string(),
                    library_resolution_ms: 5,
                    cli_compile_ms: 10_000,
                    total_ms: 10_010,
                    cache_hit: false,
                    build_signature: format!("signature-{offset}"),
                },
            )
            .unwrap();
        }

        assert_eq!(
            startup_targets_from_hotset(
                &root,
                &[
                    "esp32:esp32:esp32c3".to_string(),
                    "esp32:esp32:esp32c6:FlashSize=16M".to_string(),
                ]
            ),
            vec!["esp32:esp32:esp32c6:FlashSize=16M".to_string()]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn hotset_activity_and_ranking_preserve_complete_fqbn_options() {
        let root = std::env::temp_dir().join(format!(
            "ck-startup-full-fqbn-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let full = "esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB";
        record_board_activity(&root, full, Some(80_000), Some(false), "compile");
        let state = load_hotset_state(&root);
        assert_eq!(state.events.len(), 1);
        assert_eq!(state.events[0].fqbn, full);
        assert_eq!(
            startup_targets_from_hotset(
                &root,
                &["esp32:esp32:esp32c6".to_string(), full.to_string()]
            ),
            vec![full.to_string()]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recent_target_compaction_prefers_v2_activity_then_bounded_metrics() {
        let root = std::env::temp_dir().join(format!(
            "ck-recent-prewarm-targets-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let metric_target = "esp32:esp32:esp32c3:FlashSize=4M";
        append_compile_metric(
            &root,
            &CompileMetricRecord {
                timestamp_ms: now_ms(),
                fqbn: metric_target.to_string(),
                library_resolution_ms: 1,
                cli_compile_ms: 2,
                total_ms: 3,
                cache_hit: false,
                build_signature: "metric-signature".to_string(),
            },
        )
        .unwrap();
        let hot_target = "esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB";
        record_board_activity(&root, hot_target, Some(8_000), Some(false), "compile");

        assert_eq!(
            recent_complete_prewarm_targets(&root, 2),
            vec![hot_target.to_string(), metric_target.to_string()]
        );
        assert_eq!(
            recent_complete_prewarm_targets(&root, 1),
            vec![hot_target.to_string()]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    fn coordinator_test_lock() -> &'static tokio::sync::Mutex<()> {
        static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
    }

    async fn reset_test_target(fqbn: &str) {
        let key = board_capsule_key(fqbn);
        if let Ok(mut manual) = manual_compile_targets().lock() {
            manual.remove(&key);
        }
        active_warmups().lock().await.remove(&key);
        invalidate_pending_job(&key);
    }

    fn reset_shutdown_gate_for_test() {
        WARMUP_SHUTDOWN_REQUESTED.store(false, Ordering::Release);
    }

    #[tokio::test]
    async fn foreground_cancels_same_signature_warmup_when_code_differs() {
        let _serial = coordinator_test_lock().lock().await;
        let fqbn = "test:esp32:foreground_priority_code_mismatch";
        let key = board_capsule_key(fqbn);
        reset_test_target(fqbn).await;

        let (cancel_tx, mut cancel_rx) = watch::channel(false);
        active_warmups().lock().await.insert(
            key.clone(),
            ActiveWarmup {
                cancel_tx,
                stage: WarmupStage::QuickFast,
                fqbn: fqbn.to_string(),
                code_hash_hint: Some("old-code".into()),
                build_signature_hint: Some("same-signature".into()),
            },
        );

        let joined = prioritize_manual_compile_with_hints(
            fqbn,
            Some("new-code".into()),
            Some("same-signature".into()),
        )
        .await;

        assert!(!joined, "foreground must never join a background warmup");
        tokio::time::timeout(std::time::Duration::from_millis(250), cancel_rx.changed())
            .await
            .expect("foreground cancellation should be immediate")
            .expect("active warmup sender should remain alive");
        assert!(*cancel_rx.borrow());

        reset_test_target(fqbn).await;
    }

    #[tokio::test]
    async fn foreground_cancels_fully_compatible_warmup_instead_of_joining_it() {
        let _serial = coordinator_test_lock().lock().await;
        let fqbn = "test:avr:foreground_priority_exact_match";
        let key = board_capsule_key(fqbn);
        reset_test_target(fqbn).await;

        let (cancel_tx, mut cancel_rx) = watch::channel(false);
        active_warmups().lock().await.insert(
            key,
            ActiveWarmup {
                cancel_tx,
                stage: WarmupStage::QuickFast,
                fqbn: fqbn.to_string(),
                code_hash_hint: Some("same-code".into()),
                build_signature_hint: Some("same-signature".into()),
            },
        );

        let joined = prioritize_manual_compile_with_hints(
            fqbn,
            Some("same-code".into()),
            Some("same-signature".into()),
        )
        .await;

        assert!(
            !joined,
            "foreground compilation must not join an edit warmup"
        );
        tokio::time::timeout(std::time::Duration::from_millis(250), cancel_rx.changed())
            .await
            .expect("compatible warmup cancellation should be immediate")
            .expect("active warmup sender should remain alive");
        assert!(*cancel_rx.borrow());

        reset_test_target(fqbn).await;
    }

    #[tokio::test]
    async fn same_base_different_complete_fqbn_cannot_patch_active_warmup() {
        let _serial = coordinator_test_lock().lock().await;
        let fqbn_a = "esp32:esp32:esp32c6:FlashSize=8M,PartitionScheme=default";
        let fqbn_b = "esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB";
        let key = board_capsule_key(fqbn_a);
        assert_eq!(key, board_capsule_key(fqbn_b));
        reset_test_target(fqbn_a).await;

        let (cancel_tx, _cancel_rx) = watch::channel(false);
        active_warmups().lock().await.insert(
            key.clone(),
            ActiveWarmup {
                cancel_tx,
                stage: WarmupStage::QuickFast,
                fqbn: fqbn_a.to_string(),
                code_hash_hint: Some("same-code".into()),
                build_signature_hint: None,
            },
        );

        update_active_warmup_hints(fqbn_b, "same-code", "signature-b").await;
        assert_eq!(
            active_warmups()
                .lock()
                .await
                .get(&key)
                .and_then(|active| active.build_signature_hint.as_deref()),
            None,
            "another complete FQBN must not patch the active target's signature"
        );
        update_active_warmup_hints(fqbn_a, "same-code", "signature-a").await;
        assert_eq!(
            active_warmups()
                .lock()
                .await
                .get(&key)
                .and_then(|active| active.build_signature_hint.as_deref()),
            Some("signature-a")
        );
        reset_test_target(fqbn_a).await;
    }

    #[tokio::test]
    async fn compile_lock_entry_cancels_same_board_warmup_before_waiting() {
        let _serial = coordinator_test_lock().lock().await;
        let fqbn = "test:esp32:foreground_lock_priority";
        let key = board_capsule_key(fqbn);
        reset_test_target(fqbn).await;

        // Simulate a warmup that currently owns the per-board build directory.
        let lock = compile_lock_for(fqbn);
        let warmup_guard = lock.lock().await;
        let (cancel_tx, mut cancel_rx) = watch::channel(false);
        active_warmups().lock().await.insert(
            key,
            ActiveWarmup {
                cancel_tx,
                stage: WarmupStage::QuickFast,
                fqbn: fqbn.to_string(),
                code_hash_hint: Some("code".into()),
                build_signature_hint: Some("signature".into()),
            },
        );

        let foreground =
            tokio::spawn(async move { with_compile_lock_for(fqbn, || async { "compiled" }).await });

        tokio::time::timeout(std::time::Duration::from_millis(250), cancel_rx.changed())
            .await
            .expect("foreground should signal the warmup before waiting on its lock")
            .expect("active warmup sender should remain alive");
        assert!(*cancel_rx.borrow());

        // A real warmup releases this only after arduino-cli has stopped.
        drop(warmup_guard);
        let result = tokio::time::timeout(std::time::Duration::from_millis(250), foreground)
            .await
            .expect("foreground should acquire the lock as soon as warmup yields")
            .expect("foreground task should not panic");
        assert_eq!(result, "compiled");

        reset_test_target(fqbn).await;
    }

    #[tokio::test]
    async fn cancelled_foreground_waiter_never_runs_or_releases_the_owners_lock() {
        let _serial = coordinator_test_lock().lock().await;
        let fqbn = "test:esp32:cancellable_lock_waiter";
        reset_test_target(fqbn).await;
        let lock = compile_lock_for(fqbn);
        let owner = lock.lock().await;
        let cancellation = ck_core::builder::demo::BuildCancellation::new();
        let task_cancellation = cancellation.clone();
        let ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let task_ran = std::sync::Arc::clone(&ran);
        let waiter = tokio::spawn(async move {
            with_compile_lock_for_cancellable(fqbn, &task_cancellation, || async move {
                task_ran.store(true, std::sync::atomic::Ordering::SeqCst);
            })
            .await
        });
        tokio::task::yield_now().await;
        cancellation.cancel();

        let error = tokio::time::timeout(std::time::Duration::from_millis(500), waiter)
            .await
            .expect("cancelled lock waiter should return immediately")
            .expect("waiter task")
            .expect_err("cancelled lock waiter must not run");
        assert!(error.contains(ck_core::builder::demo::BUILD_CANCELED_MARKER));
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
        assert!(
            lock.try_lock().is_err(),
            "cancelling a waiter must not disturb the current lock owner"
        );
        drop(owner);
        reset_test_target(fqbn).await;
    }

    #[tokio::test]
    async fn first_project_cache_clear_cancels_warmup_and_waits_for_board_lock() {
        let _serial = coordinator_test_lock().lock().await;
        let temp =
            std::env::temp_dir().join(format!("ck-first-project-clear-{}", uuid::Uuid::new_v4()));
        let sysroot = Sysroot::init(Some(temp.join("sysroot")), "ck-first-project-clear-test")
            .await
            .expect("sysroot");
        let fqbn = format!("test:esp32:first_project_{}", uuid::Uuid::new_v4());
        let key = board_capsule_key(&fqbn);
        reset_test_target(&fqbn).await;

        let lock = compile_lock_for(&fqbn);
        let warmup_guard = lock.lock().await;
        let (cancel_tx, mut cancel_rx) = watch::channel(false);
        active_warmups().lock().await.insert(
            key,
            ActiveWarmup {
                cancel_tx,
                stage: WarmupStage::QuickFast,
                fqbn: fqbn.to_string(),
                code_hash_hint: None,
                build_signature_hint: None,
            },
        );

        let clear_sysroot = sysroot.clone();
        let clear_fqbn = fqbn.clone();
        let clear_task = tokio::spawn(async move {
            clear_board_first_project_compile_cache(&clear_sysroot, &clear_fqbn).await
        });
        tokio::time::timeout(std::time::Duration::from_millis(250), cancel_rx.changed())
            .await
            .expect("cache clear should signal the active warmup before waiting")
            .expect("warmup cancel sender should remain alive");
        assert!(*cancel_rx.borrow());
        assert!(
            !clear_task.is_finished(),
            "cache deletion must wait until the warmup releases the board lock"
        );

        drop(warmup_guard);
        let report = tokio::time::timeout(std::time::Duration::from_millis(500), clear_task)
            .await
            .expect("cache clear should continue after the warmup yields")
            .expect("cache clear task")
            .expect("first-project cache clear");
        assert_eq!(report.reset_scope, "first-project-full-fqbn");
        assert!(report.ccache_store_preserved);
        assert!(!report.prebuilt_core_preserved);
        assert!(!report.force_rebuild_pending);
        assert!(!report.force_ccache_recache);

        reset_test_target(&fqbn).await;
        let _ = std::fs::remove_dir_all(temp);
    }

    #[tokio::test]
    async fn manual_pending_guard_is_reference_counted_and_releases_on_drop() {
        let _serial = coordinator_test_lock().lock().await;
        let fqbn = "test:esp32:manual_pending_reference_count";
        let key = board_capsule_key(fqbn);
        reset_test_target(fqbn).await;

        let first = ManualCompilePendingGuard::new(fqbn);
        let second = ManualCompilePendingGuard::new(fqbn);
        assert_eq!(
            manual_compile_targets()
                .lock()
                .expect("manual targets")
                .get(&key)
                .copied(),
            Some(2)
        );

        drop(first);
        assert_eq!(
            manual_compile_targets()
                .lock()
                .expect("manual targets")
                .get(&key)
                .copied(),
            Some(1),
            "one foreground owner must not clear another owner's pending state"
        );

        drop(second);
        assert!(
            !manual_compile_targets()
                .lock()
                .expect("manual targets")
                .contains_key(&key),
            "the final RAII owner should release the pending state"
        );
        reset_test_target(fqbn).await;
    }

    #[tokio::test]
    async fn aborted_foreground_waiter_releases_manual_pending_guard() {
        let _serial = coordinator_test_lock().lock().await;
        let fqbn = "test:esp32:manual_pending_abort";
        let key = board_capsule_key(fqbn);
        reset_test_target(fqbn).await;

        let lock = compile_lock_for(fqbn);
        let held = lock.lock().await;
        let target = fqbn.to_string();
        let waiter =
            tokio::spawn(
                async move { with_compile_lock_for(&target, || async { "unexpected" }).await },
            );

        tokio::time::timeout(std::time::Duration::from_millis(250), async {
            loop {
                let is_pending = manual_compile_targets()
                    .lock()
                    .map(|manual| manual.contains_key(&key))
                    .unwrap_or(false);
                if is_pending {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("foreground waiter should publish its pending state");

        waiter.abort();
        let _ = waiter.await;
        assert!(
            !manual_compile_targets()
                .lock()
                .expect("manual targets")
                .contains_key(&key),
            "task cancellation must release the RAII pending state"
        );
        drop(held);
        reset_test_target(fqbn).await;
    }

    #[tokio::test]
    async fn dequeued_warmup_canceled_while_waiting_for_lock_cannot_run_later() {
        let _serial = coordinator_test_lock().lock().await;
        let temp =
            std::env::temp_dir().join(format!("ck-prewarm-race-test-{}", uuid::Uuid::new_v4()));
        let sysroot = Sysroot::init(Some(temp.join("sysroot")), "ck-prewarm-race-test")
            .await
            .expect("sysroot");
        let fqbn = "test:esp32:dequeued_warmup_race";
        let key = board_capsule_key(fqbn);
        reset_test_target(fqbn).await;

        let (_, fallback) = prepare_prewarm_job(
            sysroot,
            fqbn.to_string(),
            Some("void setup() {}\nvoid loop() {}".to_string()),
            Some("stale-signature".to_string()),
        );
        pending_jobs()
            .lock()
            .expect("pending jobs")
            .insert(key.clone());
        pending_job_overrides()
            .lock()
            .expect("pending overrides")
            .insert(key.clone(), fallback.clone());

        // Model a worker that has already received its channel item but has not
        // acquired the board lock yet. Pending membership must remain visible.
        let lock = compile_lock_for(fqbn);
        let foreground_lock = lock.lock().await;
        let worker_key = key.clone();
        let worker = tokio::spawn(async move {
            let lock = compile_lock_for(&worker_key);
            let _guard = lock.lock().await;
            claim_pending_job_after_lock(&worker_key, fallback)
        });
        tokio::task::yield_now().await;

        // Foreground prioritization invalidates the still-visible token while
        // the dequeued worker is blocked on the compile lock.
        let joined = prioritize_manual_compile_with_hints(fqbn, None, None).await;
        assert!(!joined);
        drop(foreground_lock);

        let claimed = tokio::time::timeout(std::time::Duration::from_millis(250), worker)
            .await
            .expect("worker should wake after foreground lock release")
            .expect("worker task");
        assert!(
            claimed.is_none(),
            "a stale dequeued warmup must not run after foreground invalidation"
        );

        reset_test_target(fqbn).await;
        let _ = std::fs::remove_dir_all(temp);
    }

    #[tokio::test]
    async fn prewarm_queue_coalesces_by_board_but_preserves_complete_fqbn() {
        let temp =
            std::env::temp_dir().join(format!("ck-prewarm-fqbn-test-{}", uuid::Uuid::new_v4()));
        let sysroot = Sysroot::init(Some(temp.join("sysroot")), "ck-prewarm-fqbn-test")
            .await
            .expect("sysroot");
        let fqbn =
            "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=fatflash,PSRAM=opi,USBMode=hwcdc"
                .to_string();

        let (queue_key, job) = prepare_prewarm_job(
            sysroot,
            fqbn.clone(),
            Some("void setup() {}\nvoid loop() {}".to_string()),
            Some("signature-flash16".to_string()),
        );

        assert_eq!(queue_key, "esp32:esp32:esp32s3");
        assert_eq!(job.fqbn, fqbn, "prewarm target must retain board options");
        assert_eq!(
            job.build_signature_hint.as_deref(),
            Some("signature-flash16")
        );
        assert!(job.code_hash_hint.is_some());
        let _ = std::fs::remove_dir_all(temp);
    }

    #[tokio::test]
    async fn default_prewarm_is_board_level_and_cannot_replace_exact_project_source() {
        let temp = std::env::temp_dir().join(format!(
            "ck-default-prewarm-policy-test-{}",
            uuid::Uuid::new_v4()
        ));
        let sysroot = Sysroot::init(Some(temp.join("sysroot")), "ck-default-prewarm-policy-test")
            .await
            .expect("sysroot");
        let fqbn = "test:esp32:default_board_seed".to_string();

        let (queue_key, job) = prepare_default_prewarm_job(sysroot, fqbn.clone());

        assert_eq!(queue_key, "test:esp32:default_board_seed");
        assert_eq!(job.fqbn, fqbn);
        assert!(
            job.code.is_none(),
            "default/startup warmup must not carry canonical source into the exact-project slot"
        );
        assert!(
            job.code_hash_hint.is_none(),
            "board-level warmup must not advertise an exact project code identity"
        );
        assert!(
            job.build_signature_hint.is_none(),
            "board-only warmup must not calculate or advertise an unusable build signature"
        );
        let _ = std::fs::remove_dir_all(temp);
    }

    #[tokio::test]
    async fn terminal_warmup_shutdown_signals_and_waits_for_worker_removal() {
        let _serial = coordinator_test_lock().lock().await;
        reset_shutdown_gate_for_test();
        let fqbn = "test:esp32:terminal_shutdown";
        let key = board_capsule_key(fqbn);
        reset_test_target(fqbn).await;
        let (cancel_tx, mut cancel_rx) = watch::channel(false);
        active_warmups().lock().await.insert(
            key.clone(),
            ActiveWarmup {
                cancel_tx,
                stage: WarmupStage::QuickFast,
                fqbn: fqbn.to_string(),
                code_hash_hint: None,
                build_signature_hint: None,
            },
        );

        let worker_key = key.clone();
        let simulated_owner = tokio::spawn(async move {
            cancel_rx.changed().await.expect("shutdown signal");
            assert!(*cancel_rx.borrow());
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            active_warmups().lock().await.remove(&worker_key);
        });
        let started = std::time::Instant::now();
        let report = shutdown_running_warmups(std::time::Duration::from_secs(1)).await;
        simulated_owner.await.expect("simulated warmup owner");
        assert_eq!(report.initially_active, 1);
        assert_eq!(report.remaining_active, 0);
        assert!(!report.timed_out);
        assert!(
            started.elapsed() >= std::time::Duration::from_millis(25),
            "shutdown must wait until the warmup owner removes its active entry"
        );

        reset_shutdown_gate_for_test();
        reset_test_target(fqbn).await;
    }
}
