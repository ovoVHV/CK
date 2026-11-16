//! Explicitly enabled, local-only transport to the qualified Linux worker.
//! All public compile/upload entrypoints already converge in the parent module.
//! No fixture code, alternate library resolver, or native-cache metadata lives here.
use super::*;
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const WORKER: &str =
    include_str!("../../../../../scripts/experimental-linux-backend/product_worker.py");
const PROCESS_TREE: &str =
    include_str!("../../../../../scripts/experimental-linux-backend/process_tree.py");
const CONFIG_ENV: &str = "CK_LINUX_BACKEND_CONFIG";

#[derive(Clone)]
struct ProvenInputs {
    core_files: BTreeMap<String, String>,
    sdk_files: BTreeMap<String, String>,
}

#[derive(Clone)]
struct ProvenArtifact {
    source_sha256: String,
    export: PathBuf,
    request: Value,
    receipt: Value,
}

// Only populated after the existing toolchain lease has been revalidated.
// The lease's content identity includes these exact Core/SDK roots. This is
// request-proof reuse, not a second metadata/mtime-only identity resolver.
static INPUT_PROOFS: std::sync::OnceLock<std::sync::Mutex<BTreeMap<String, ProvenInputs>>> =
    std::sync::OnceLock::new();
static ARTIFACT_PROOFS: std::sync::OnceLock<std::sync::Mutex<BTreeMap<String, ProvenArtifact>>> =
    std::sync::OnceLock::new();

fn input_proofs() -> &'static std::sync::Mutex<BTreeMap<String, ProvenInputs>> {
    INPUT_PROOFS.get_or_init(Default::default)
}

fn artifact_proofs() -> &'static std::sync::Mutex<BTreeMap<String, ProvenArtifact>> {
    ARTIFACT_PROOFS.get_or_init(Default::default)
}

fn may_replay(
    clean: bool,
    policy: CkExactReusePolicy,
    managed_cli: bool,
    source: &str,
    previous: &str,
) -> bool {
    !clean
        && ck_exact_reuse_allowed_with_managed_cli(policy, source == previous, false, managed_cli)
}

#[derive(Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Transport {
    #[default]
    Docker,
    Wsl,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    #[serde(alias = "launcherPath")]
    docker_path: PathBuf,
    #[serde(default)]
    context: String,
    #[serde(alias = "workerId")]
    container: String,
    worker_root: String,
    allowed_fqbns: Vec<String>,
    #[serde(default)]
    transport: Transport,
    #[serde(default)]
    allow_cold_start: bool,
    #[serde(default)]
    direct_mapped_exchange: bool,
}

fn wsl_local_path(path: &str) -> Result<String> {
    let path = path
        .strip_prefix("\\\\?\\")
        .unwrap_or(path)
        .replace('\\', "/");
    let bytes = path.as_bytes();
    anyhow::ensure!(
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/',
        "WSL transfer requires a local absolute drive path"
    );
    anyhow::ensure!(
        !path[2..].contains(':') && !path.contains('\0') && !path.split('/').any(|s| s == ".."),
        "Unsafe WSL transfer path"
    );
    Ok(format!(
        "/mnt/{}{}",
        (bytes[0] as char).to_ascii_lowercase(),
        &path[2..]
    ))
}

fn wsl_list_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.iter().skip(1).step_by(2).any(|b| *b == 0) {
        let text = String::from_utf16_lossy(
            &bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect::<Vec<_>>(),
        );
        text.trim_start_matches('\u{feff}').replace('\0', "")
    } else {
        String::from_utf8_lossy(bytes)
            .trim_start_matches('\u{feff}')
            .to_string()
    }
}

impl Config {
    fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            self.docker_path.is_absolute() && self.docker_path.is_file(),
            "Local worker launcher unavailable"
        );
        let identifiers = if self.transport == Transport::Docker {
            vec![&self.container, &self.context]
        } else {
            vec![&self.container]
        };
        for value in identifiers {
            anyhow::ensure!(
                !value.is_empty()
                    && value.len() <= 100
                    && value
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c)),
                "Invalid local worker identifier"
            );
        }
        anyhow::ensure!(
            self.worker_root == "/lab",
            "Only the already-qualified local worker root is enabled"
        );
        anyhow::ensure!(
            !self.allowed_fqbns.is_empty(),
            "No exact FQBN has been enabled"
        );
        anyhow::ensure!(
            !self.direct_mapped_exchange || self.transport == Transport::Wsl,
            "Direct mapped exchange requires WSL"
        );
        Ok(())
    }

    fn launcher(&self) -> Command {
        let mut cmd = Command::new(&self.docker_path);
        hide_window(&mut cmd);
        cmd.env_remove("DOCKER_HOST")
            .env_remove("DOCKER_CONTEXT")
            .kill_on_drop(true);
        cmd
    }

    fn command(&self, args: &[String]) -> Result<Command> {
        let mut cmd = self.launcher();
        if self.transport == Transport::Docker {
            cmd.args(["--context", &self.context]).args(args);
            return Ok(cmd);
        }
        cmd.args([
            "-d",
            &self.container,
            "-u",
            "root",
            "--cd",
            "/lab",
            "--exec",
        ]);
        match args.first().map(String::as_str) {
            Some("exec") => {
                let worker = if args.get(1).map(String::as_str) == Some("-i") {
                    2
                } else {
                    1
                };
                anyhow::ensure!(
                    args.get(worker) == Some(&self.container) && args.len() > worker + 1,
                    "Invalid WSL execution target"
                );
                cmd.args(&args[worker + 1..]);
            }
            Some("cp") if args.len() == 3 => {
                let prefix = format!("{}:", self.container);
                let (source, destination) = if let Some(remote) = args[2].strip_prefix(&prefix) {
                    anyhow::ensure!(
                        remote.starts_with("/tmp/ck-product-")
                            && !remote.split('/').any(|s| s == ".."),
                        "Invalid WSL staging path"
                    );
                    (wsl_local_path(&args[1])?, remote.to_string())
                } else if let Some(remote) = args[1].strip_prefix(&prefix) {
                    anyhow::ensure!(
                        remote.starts_with("/tmp/ck-product-")
                            && remote.ends_with("/export")
                            && !remote.split('/').any(|s| s == ".."),
                        "Invalid WSL export path"
                    );
                    (remote.to_string(), wsl_local_path(&args[2])?)
                } else {
                    anyhow::bail!(
                        "WSL transfer must have exactly one local and one worker endpoint"
                    )
                };
                cmd.args(["/usr/bin/python3", "-c", "import shutil,sys; from pathlib import Path; a,b=map(Path,sys.argv[1:]); assert a.is_dir() and not b.exists(); shutil.copytree(a,b)", &source, &destination]);
            }
            _ => anyhow::bail!("Unsupported WSL transport operation"),
        }
        Ok(cmd)
    }

    async fn check_wsl_ready(&self) -> Result<()> {
        // Enumerating the registration list does not boot any distribution.
        let mut list = self.launcher();
        list.args(["--list", "--quiet"]);
        if !self.allow_cold_start {
            list.arg("--running");
        }
        let result = tokio::time::timeout(Duration::from_secs(10), list.output()).await??;
        anyhow::ensure!(
            result.status.success()
                && wsl_list_text(&result.stdout)
                    .lines()
                    .any(|s| s.trim() == self.container),
            "Configured local WSL worker is not registered/running; nothing is installed automatically"
        );
        let ready = output(self, &["exec".into(), self.container.clone(), "/usr/bin/python3".into(), "-c".into(), "from pathlib import Path; assert Path('/lab/bin/arduino-cli').is_file(); assert Path('/mnt/c').is_dir(); print('ready')".into()], 30).await?;
        anyhow::ensure!(
            ready.status.success() && String::from_utf8_lossy(&ready.stdout).trim() == "ready",
            "Configured WSL worker did not become ready"
        );
        Ok(())
    }
}

async fn output(config: &Config, args: &[String], seconds: u64) -> Result<std::process::Output> {
    let mut command = config.command(args)?;
    Ok(
        tokio::time::timeout(Duration::from_secs(seconds), command.output())
            .await
            .context("Linux worker transport timeout")??,
    )
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn record_phase(phases: &mut BTreeMap<String, u128>, at: &mut Instant, name: &str) {
    let now = Instant::now();
    phases.insert(name.into(), now.duration_since(*at).as_millis());
    *at = now;
}

fn inventory(root: &Path, core: bool) -> Result<BTreeMap<String, String>> {
    fn visit(
        root: &Path,
        current: &Path,
        core: bool,
        out: &mut Vec<(String, PathBuf)>,
    ) -> Result<()> {
        for entry in std::fs::read_dir(current)? {
            let entry = entry?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ".git"
                || name == "__pycache__"
                || name.ends_with(".pyc")
                || (core && name == "installed.json")
            {
                continue;
            }
            let kind = entry.file_type()?;
            // Reparse points can target files outside the selected library.
            anyhow::ensure!(
                !kind.is_symlink(),
                "Library/Core contains a symlink: {}",
                path.display()
            );
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                anyhow::ensure!(
                    std::fs::symlink_metadata(&path)?.file_attributes() & 0x400 == 0,
                    "Library/Core contains a reparse point: {}",
                    path.display()
                );
            }
            if kind.is_dir() {
                visit(root, &path, core, out)?;
            } else if kind.is_file() {
                let relative = path
                    .strip_prefix(root)?
                    .to_str()
                    .context("Non UTF-8 resource path")?
                    .replace('\\', "/");
                anyhow::ensure!(
                    !relative.contains(':') && !relative.split('/').any(|part| part == ".."),
                    "Unsafe resource path"
                );
                out.push((relative, path));
            }
        }
        Ok(())
    }
    let mut paths = Vec::new();
    visit(root, root, core, &mut paths)?;
    // Bound I/O parallelism. Every file is still content hashed, including on
    // first use; no old object or unchecked metadata replaces this proof.
    let workers = std::thread::available_parallelism()
        .map_or(1, |n| n.get())
        .min(4);
    std::thread::scope(|scope| {
        let handles: Vec<_> = paths
            .chunks(paths.len().div_ceil(workers).max(1))
            .map(|chunk| {
                scope.spawn(move || -> Result<Vec<(String, String)>> {
                    chunk
                        .iter()
                        .map(|(name, path)| Ok((name.clone(), digest(&std::fs::read(path)?))))
                        .collect()
                })
            })
            .collect();
        let mut result = BTreeMap::new();
        for handle in handles {
            result.extend(
                handle
                    .join()
                    .map_err(|_| anyhow::anyhow!("Input hashing worker failed"))??,
            );
        }
        Ok(result)
    })
}

fn append_bytes(archive: &mut tar::Builder<std::fs::File>, name: &str, bytes: &[u8]) -> Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    archive.append_data(&mut header, name, bytes)?;
    Ok(())
}

fn validate_receipt(receipt: &Value, request: &Value) -> Result<()> {
    for key in [
        "protocol",
        "requestId",
        "fqbn",
        "sourceSha256",
        "buildSignature",
    ] {
        anyhow::ensure!(
            receipt.get(key) == request.get(key),
            "Linux receipt request mismatch: {key}"
        );
    }
    if receipt["success"] == true {
        anyhow::ensure!(
            receipt["resolvedProperties"] == request["resolvedIdentity"],
            "Linux resolved target mismatch"
        );
        anyhow::ensure!(
            receipt["compileStarted"] == true && receipt["fallbackAllowed"] == false,
            "Linux success without an authoritative compile"
        );
        anyhow::ensure!(
            receipt["processCleanup"]["remainingChildren"] == json!([]),
            "Linux compiler cleanup incomplete"
        );
    }
    Ok(())
}

fn verify_exports(directory: &Path, receipt: &Value) -> Result<()> {
    let files = receipt["artifacts"]
        .as_array()
        .context("Missing exported artifact manifest")?;
    let mut names = BTreeSet::new();
    for file in files {
        let name = file["name"].as_str().context("Invalid artifact name")?;
        anyhow::ensure!(
            !name.is_empty()
                && !name.contains(['/', '\\', ':'])
                && name != "."
                && name != ".."
                && names.insert(name.to_owned()),
            "Unsafe or duplicate artifact name"
        );
        let bytes = std::fs::read(directory.join(name))?;
        anyhow::ensure!(
            file["bytes"].as_u64() == Some(bytes.len() as u64)
                && file["sha256"].as_str() == Some(&digest(&bytes)),
            "Exported artifact hash mismatch: {name}"
        );
    }
    anyhow::ensure!(
        names.contains("sketch.ino.bin") && names.contains("sketch.ino.elf"),
        "Missing firmware outputs"
    );
    Ok(())
}

/// None means the request never began compiling on Linux and can safely use
/// the ordinary native route. Once compilation starts, errors/cancellation are
/// authoritative and are never retried as a hidden second full build.
pub(super) async fn try_compile<F, L>(
    sysroot: &Sysroot,
    code: &str,
    fqbn: &str,
    extra_libs: &[PathBuf],
    jobs: u32,
    build_signature: &str,
    identity_lease: &ToolchainIdentityLease,
    clean: bool,
    exact_reuse_policy: CkExactReusePolicy,
    progress: &F,
    log: &L,
) -> Result<Option<(PathBuf, String)>>
where
    F: Fn(f32, String),
    L: Fn(String),
{
    let Some(config_path) = std::env::var_os(CONFIG_ENV) else {
        return Ok(None);
    };
    let started = Instant::now();
    let mut phase_at = started;
    let mut host_phases = BTreeMap::new();
    let config: Config = match std::fs::read(config_path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
    {
        Some(config) => config,
        None => {
            log(
                "[LinuxBackend] Invalid opt-in config; native fallback before compilation.\n"
                    .into(),
            );
            return Ok(None);
        }
    };
    if !config.allowed_fqbns.iter().any(|target| target == fqbn) {
        return Ok(None);
    }
    if let Err(error) = config.validate() {
        log(format!("[LinuxBackend] Native fallback: {error}\n"));
        return Ok(None);
    }
    current_build_cancellation_checkpoint()?;
    let ready: Result<()> = async {
        if config.transport == Transport::Wsl {
            return config.check_wsl_ready().await;
        }
        // Never send project contents through a remote Docker endpoint.
        let context = output(
            &config,
            &["context".into(), "inspect".into(), config.context.clone()],
            3,
        )
        .await?;
        let value: Value = serde_json::from_slice(&context.stdout)?;
        let endpoint = value[0]["Endpoints"]["docker"]["Host"]
            .as_str()
            .context("Missing local endpoint")?;
        anyhow::ensure!(
            endpoint.starts_with("npipe://") || endpoint.starts_with("unix://"),
            "Remote Docker endpoint is not allowed"
        );
        let state = output(
            &config,
            &[
                "inspect".into(),
                "--format".into(),
                "{{.State.Running}}".into(),
                config.container.clone(),
            ],
            3,
        )
        .await?;
        anyhow::ensure!(
            state.status.success() && String::from_utf8_lossy(&state.stdout).trim() == "true",
            "Optional local worker is not running"
        );
        Ok(())
    }
    .await;
    if let Err(error) = ready {
        current_build_cancellation_checkpoint()?;
        log(format!(
            "[LinuxBackend] Native fallback before compilation: {error} ({}ms). No software installed; cold start occurs only when explicitly configured.\n",
            started.elapsed().as_millis()
        ));
        return Ok(None);
    }
    record_phase(&mut host_phases, &mut phase_at, "readinessMs");
    progress(2.0, "Preparing verified local Linux worker".into());
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let request_id = digest(
        format!(
            "{}:{stamp}:{fqbn}:{build_signature}:{}",
            std::process::id(),
            digest(code.as_bytes())
        )
        .as_bytes(),
    );
    let stage = std::env::temp_dir()
        .join("CK_Builds")
        .join("linux-worker")
        .join(&request_id);
    std::fs::create_dir_all(stage.join("source/sketch"))?;
    let host_sketch = stage.join("source/sketch/sketch.ino");
    std::fs::write(&host_sketch, code)?;
    let resolved = crate::builder::direct_engine::resolve_properties(
        &sysroot.root_dir,
        fqbn,
        &stage.join("build"),
        &stage.join("source/sketch"),
        "sketch",
        &[],
    )
    .await?;
    let platform = PathBuf::from(
        resolved
            .props
            .get("runtime.platform.path")
            .context("Missing Core path")?,
    );
    if platform.file_name().and_then(|v| v.to_str()) != Some("3.3.6")
        || platform.join("platform.local.txt").exists()
        || platform.join("boards.local.txt").exists()
    {
        log("[LinuxBackend] Unqualified Core/version/local override; native fallback.\n".into());
        return Ok(None);
    }
    let preflight =
        crate::builder::direct_engine::runtime_tool_preflight_from_resolved_props(&resolved);
    anyhow::ensure!(
        !preflight.is_blocked(),
        "{}",
        preflight.blocking_message(fqbn)
    );
    let compiler = PathBuf::from(
        resolved
            .props
            .get("compiler.path")
            .context("Missing compiler path")?,
    )
    .join(
        resolved
            .props
            .get("compiler.cpp.cmd")
            .context("Missing compiler executable")?,
    );
    let compiler = if cfg!(windows) && compiler.extension().is_none() {
        compiler.with_extension("exe")
    } else {
        compiler
    };
    let mut version_command = Command::new(compiler);
    hide_window(&mut version_command).arg("--version");
    let version = managed_command_output(&mut version_command).await?;
    anyhow::ensure!(
        version.status.success(),
        "Cannot authenticate the host compiler version"
    );
    let version_text = String::from_utf8_lossy(&version.stdout);
    let compiler_version = version_text
        .lines()
        .next()
        .and_then(|s| s.split_once(' '))
        .map(|(_, v)| v)
        .context("Missing compiler version text")?;
    let sdk_root = PathBuf::from(
        resolved
            .props
            .get("compiler.sdk.path")
            .context("Missing SDK path")?,
    );
    let proof_key = digest(&serde_json::to_vec(&json!([
        identity_lease.toolchain_key(),
        platform,
        sdk_root
    ]))?);
    let previous_inputs = input_proofs()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&proof_key)
        .cloned();
    let preparation: Result<Value> = (|| {
        let (core_files, sdk_files) = match previous_inputs {
            Some(ref proof) => (proof.core_files.clone(), proof.sdk_files.clone()),
            None => (inventory(&platform, true)?, inventory(&sdk_root, true)?),
        };
        let mut files = BTreeMap::from([(
            "source/sketch/sketch.ino".to_string(),
            digest(code.as_bytes()),
        )]);
        let mut archive = tar::Builder::new(std::fs::File::create(stage.join("inputs.tar"))?);
        append_bytes(&mut archive, "source/sketch/sketch.ino", code.as_bytes())?;
        let mut libraries = Vec::new();
        for (index, library) in extra_libs.iter().enumerate() {
            current_build_cancellation_checkpoint()?;
            let name = library
                .file_name()
                .and_then(|v| v.to_str())
                .context("Invalid library name")?;
            let prefix = format!("libraries/{index}/{name}");
            for (relative, expected) in inventory(library, false)? {
                let bytes = std::fs::read(library.join(&relative))?;
                anyhow::ensure!(
                    digest(&bytes) == expected,
                    "Library changed during synchronization"
                );
                let destination = format!("{prefix}/{relative}");
                append_bytes(&mut archive, &destination, &bytes)?;
                files.insert(destination, expected);
            }
            libraries.push(prefix);
        }
        archive.finish()?;
        let identity: BTreeMap<String, String> =
            ["build.fqbn", "build.mcu", "build.variant", "build.f_cpu"]
                .into_iter()
                .map(|key| {
                    Ok((
                        key.into(),
                        resolved
                            .props
                            .get(key)
                            .with_context(|| format!("Missing identity {key}"))?
                            .clone(),
                    ))
                })
                .collect::<Result<_>>()?;
        let epoch = std::env::var("SOURCE_DATE_EPOCH").ok();
        let mut library_files = files.clone();
        library_files.remove("source/sketch/sketch.ino");
        let cache_key = digest(&serde_json::to_vec(&json!([
            "linux-worker-v1",
            format!("{:?}:{}", config.transport, config.container),
            config.direct_mapped_exchange,
            fqbn,
            build_signature,
            identity_lease.toolchain_key(),
            core_files,
            sdk_files,
            compiler_version,
            library_files,
            epoch,
            digest(WORKER.as_bytes())
        ]))?);
        Ok(
            json!({"protocol":1,"requestId":request_id,"cacheKey":cache_key,
            "fqbn":fqbn,"coreVersion":"3.3.6","workerRoot":config.worker_root,
            "sourceSha256":digest(code.as_bytes()),"buildSignature":build_signature,
            "hostToolchainKey":identity_lease.toolchain_key(),"coreFiles":core_files,
            "sdkFiles":sdk_files,"compilerVersion":compiler_version,
            "files":files,"libraries":libraries,"jobs":jobs.clamp(1,8),"timeoutSeconds":600,
            "clean":clean,"sourceDateEpoch":epoch,"resolvedIdentity":identity}),
        )
    })();
    let request = match preparation {
        Ok(request) => request,
        Err(error) => {
            current_build_cancellation_checkpoint()?;
            log(format!(
                "[LinuxBackend] Input synchronization not supported; native fallback: {error}\n"
            ));
            return Ok(None);
        }
    };
    let cache_key = request["cacheKey"]
        .as_str()
        .context("Missing worker cache identity")?
        .to_owned();
    record_phase(&mut host_phases, &mut phase_at, "inputPreparationMs");
    let previous = artifact_proofs()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&cache_key);
    if let Some(previous) = previous.filter(|proof| {
        may_replay(
            clean,
            exact_reuse_policy,
            identity_lease.managed_cli_identity_reuse_allowed(&sysroot.root_dir),
            &digest(code.as_bytes()),
            &proof.source_sha256,
        )
    }) {
        let replay: Result<_> = (|| {
            validate_receipt(&previous.receipt, &previous.request)?;
            verify_exports(&previous.export, &previous.receipt)?;
            identity_lease.ensure_exact_return_is_current(&sysroot.root_dir, fqbn)?;
            current_build_cancellation_checkpoint()?;
            Ok(previous)
        })();
        match replay {
            Ok(proof) => {
                let export = stage.join("artifacts/sketch");
                std::fs::create_dir_all(&export)?;
                for file in proof.receipt["artifacts"]
                    .as_array()
                    .context("Missing artifact proof")?
                {
                    let name = file["name"].as_str().context("Missing artifact name")?;
                    std::fs::copy(proof.export.join(name), export.join(name))?;
                }
                for name in ["compile.log", "backend-receipt.json"] {
                    std::fs::copy(proof.export.join(name), export.join(name))?;
                }
                verify_exports(&export, &proof.receipt)?;
                identity_lease.ensure_exact_return_is_current(&sysroot.root_dir, fqbn)?;
                current_build_cancellation_checkpoint()?;
                let summary = format!(
                    "[INFO] Build backend: linux-worker-v1 (authenticated exact reuse)\n[LinuxBackend] Exact output reuse; compiler not invoked; {}ms including input and artifact validation.\n",
                    started.elapsed().as_millis()
                );
                std::fs::write(
                    export.join("backend-host-receipt.json"),
                    serde_json::to_vec_pretty(&json!({
                        "requestId":request_id,"endToEndMs":started.elapsed().as_millis(),
                        "transport": if config.transport == Transport::Wsl { "wsl" } else { "docker" },
                        "directMappedExchange": config.direct_mapped_exchange,
                        "request":proof.request,"worker":proof.receipt,"nativeCacheUsed":false,
                        "uploadTransportChanged":false,"compileInvoked":false,
                        "reuseOfRequestId":proof.request["requestId"]
                    }))?,
                )?;
                artifact_proofs()
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(cache_key, proof);
                log(summary.clone());
                progress(100.0, "Compilation complete".into());
                return Ok(Some((export, summary)));
            }
            Err(error) => log(format!(
                "[LinuxBackend] Exact proof rejected; real compilation required: {error}\n"
            )),
        }
    }
    std::fs::write(
        stage.join("request.json"),
        serde_json::to_vec_pretty(&request)?,
    )?;
    std::fs::write(stage.join("product_worker.py"), WORKER)?;
    std::fs::write(stage.join("process_tree.py"), PROCESS_TREE)?;
    // Only the bounded request archive, worker code and exported output cross
    // DrvFS. Compiler sources, objects and locks remain in /lab/product-builds.
    let remote = if config.direct_mapped_exchange {
        wsl_local_path(stage.to_str().context("Non UTF-8 staging path")?)?
    } else {
        let remote = format!("/tmp/ck-product-{request_id}");
        let transfer = output(
            &config,
            &[
                "cp".into(),
                stage.to_string_lossy().into_owned(),
                format!("{}:{remote}", config.container),
            ],
            60,
        )
        .await?;
        anyhow::ensure!(
            transfer.status.success(),
            "Linux source transfer failed: {}",
            String::from_utf8_lossy(&transfer.stderr)
        );
        remote
    };
    record_phase(&mut host_phases, &mut phase_at, "stageTransferMs");
    current_build_cancellation_checkpoint()?;
    log(format!(
        "[LinuxBackend] Actual request {request_id}; source/libraries staged for verification in {}ms. Native caches are not used.\n",
        started.elapsed().as_millis()
    ));
    let args = vec![
        "exec".into(),
        "-i".into(),
        config.container.clone(),
        "python3".into(),
        format!("{remote}/product_worker.py"),
        remote.clone(),
    ];
    let mut command = config.command(&args)?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let mut heartbeat = child
        .stdin
        .take()
        .context("Missing worker heartbeat pipe")?;
    heartbeat.write_all(b".").await?;
    let stdout = child.stdout.take().context("Missing worker stdout")?;
    let stderr = child.stderr.take().context("Missing worker stderr")?;
    // These reader tasks only collect transport output. Cancellation below is
    // sent into the worker, not just to docker.exe, to reap Linux descendants.
    let lines = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut text = String::new();
        while let Some(line) = reader.next_line().await? {
            if text.len() < 65536 {
                text.push_str(&line);
                text.push('\n');
            }
        }
        Ok::<_, std::io::Error>(text)
    });
    let errors = tokio::spawn(async move {
        let mut reader = stderr.take(65536);
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await?;
        Ok::<_, std::io::Error>(String::from_utf8_lossy(&bytes).into_owned())
    });
    let running_at = Instant::now();
    let mut next_progress = 5;
    let mut next_heartbeat = 1;
    let mut cancel_at: Option<Instant> = None;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if running_at.elapsed().as_secs() >= next_heartbeat {
            // A dead desktop/client loses this pipe; the remote supervisor then
            // cancels and reaps its own process tree instead of running orphaned.
            let _ = heartbeat.write_all(b".").await;
            next_heartbeat += 2;
        }
        let cancelled = current_build_cancellation().is_some_and(|c| c.is_cancelled());
        if running_at.elapsed().as_secs() >= next_progress {
            progress(
                3.0,
                format!(
                    "Local Linux compilation: {}s elapsed",
                    running_at.elapsed().as_secs()
                ),
            );
            next_progress += 5;
        }
        if (cancelled || running_at.elapsed().as_secs() > 615) && cancel_at.is_none() {
            let delivered = if config.direct_mapped_exchange {
                std::fs::write(stage.join("cancel"), b"").is_ok()
            } else {
                output(
                    &config,
                    &[
                        "exec".into(),
                        config.container.clone(),
                        "python3".into(),
                        "-c".into(),
                        "from pathlib import Path; import sys; Path(sys.argv[1]).touch()".into(),
                        format!("{remote}/cancel"),
                    ],
                    5,
                )
                .await
                .is_ok_and(|r| r.status.success())
            };
            log(format!(
                "[LinuxBackend] Cancellation sent to worker: {}\n",
                delivered
            ));
            cancel_at = Some(Instant::now());
        }
        if cancel_at.is_some_and(|at| at.elapsed().as_secs() > 15) {
            child.kill().await?;
            anyhow::bail!(
                "Linux worker cancellation could not confirm remote cleanup; output rejected (worker watchdog remains active)"
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let transport_log = lines.await?? + &errors.await??;
    log(transport_log.clone());
    record_phase(&mut host_phases, &mut phase_at, "workerTransportMs");
    // Preserve the existing uploader's <build>/<sketch-name> convention.
    let export = stage.join("artifacts/sketch");
    std::fs::create_dir_all(export.parent().context("Missing export parent")?)?;
    if config.direct_mapped_exchange {
        std::fs::rename(stage.join("export"), &export)
            .context("WSL mapped export is incomplete; no success published")?;
    } else {
        let copied = output(
            &config,
            &[
                "cp".into(),
                format!("{}:{remote}/export", config.container),
                export.to_string_lossy().into_owned(),
            ],
            60,
        )
        .await?;
        anyhow::ensure!(
            copied.status.success(),
            "Linux result export failed; no success published: {transport_log}"
        );
    }
    record_phase(&mut host_phases, &mut phase_at, "artifactTransferMs");
    let receipt: Value =
        serde_json::from_slice(&std::fs::read(export.join("backend-receipt.json"))?)?;
    validate_receipt(&receipt, &request)?;
    current_build_cancellation_checkpoint()?;
    if receipt["success"] != true {
        if receipt["fallbackAllowed"] == true && receipt["compileStarted"] == false {
            log(format!(
                "[LinuxBackend] Pre-compile verification rejected worker; native fallback: {}\n",
                receipt["error"]
            ));
            return Ok(None);
        }
        let error = receipt["error"].as_str().unwrap_or(&transport_log);
        let error = match receipt["remoteSource"].as_str() {
            Some(path) => error.replace(path, &host_sketch.to_string_lossy()),
            None => error.to_string(),
        };
        log(error.clone());
        anyhow::bail!("Linux worker compile failed (no native retry): {error}");
    }
    anyhow::ensure!(
        status.success() && cancel_at.is_none(),
        "Linux worker transport failed; output rejected"
    );
    verify_exports(&export, &receipt)?;
    identity_lease.revalidate_after_real_compile(&sysroot.root_dir, fqbn)?;
    let raw_log = std::fs::read_to_string(export.join("compile.log"))?;
    let log_text = raw_log.replace(
        receipt["remoteSource"]
            .as_str()
            .context("Missing source alias")?,
        &host_sketch.to_string_lossy(),
    );
    // Preserve raw log and receipt; only the UI copy maps the authenticated
    // sketch path for CK's existing block/source locator.
    let summary = format!(
        "[INFO] Build backend: linux-worker-v1 (opt-in, official Arduino CLI)\n[Timing] Linux backend end-to-end: {}ms (includes readiness, sync, compile, export, verification)\n{}",
        started.elapsed().as_millis(),
        log_text
    );
    log(summary.clone());
    record_phase(&mut host_phases, &mut phase_at, "resultValidationMs");
    let host_receipt = json!({"requestId":request_id,"endToEndMs":started.elapsed().as_millis(),
        "transport": if config.transport == Transport::Wsl { "wsl" } else { "docker" },
        "directMappedExchange":config.direct_mapped_exchange,"hostPhases":host_phases,
        "request":request,"worker":receipt,"nativeCacheUsed":false,"uploadTransportChanged":false,"compileInvoked":true});
    std::fs::write(
        export.join("backend-host-receipt.json"),
        serde_json::to_vec_pretty(&host_receipt)?,
    )?;
    {
        let mut inputs = input_proofs().lock().unwrap_or_else(|p| p.into_inner());
        if inputs.len() >= 4 {
            inputs.clear();
        }
        inputs.insert(
            proof_key,
            ProvenInputs {
                core_files: serde_json::from_value(request["coreFiles"].clone())?,
                sdk_files: serde_json::from_value(request["sdkFiles"].clone())?,
            },
        );
        let mut artifacts = artifact_proofs().lock().unwrap_or_else(|p| p.into_inner());
        if artifacts.len() >= 8 {
            artifacts.clear();
        }
        artifacts.insert(
            cache_key,
            ProvenArtifact {
                source_sha256: digest(code.as_bytes()),
                export: export.clone(),
                request,
                receipt,
            },
        );
    }
    progress(100.0, "Compilation complete".into());
    Ok(Some((export, summary)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_config_stays_docker_and_never_cold_starts() {
        let config: Config = serde_json::from_value(json!({
            "dockerPath":"C:/Docker/docker.exe", "context":"desktop-linux",
            "container":"existing-worker", "workerRoot":"/lab", "allowedFqbns":["exact"]
        }))
        .unwrap();
        assert_eq!(config.transport, Transport::Docker);
        assert!(!config.allow_cold_start);
        assert!(!config.direct_mapped_exchange);
        let command = config
            .command(&["inspect".into(), "existing-worker".into()])
            .unwrap();
        assert_eq!(
            command.as_std().get_args().collect::<Vec<_>>(),
            ["--context", "desktop-linux", "inspect", "existing-worker"]
        );
    }

    fn wsl_test_config(cold_start: bool) -> Config {
        serde_json::from_value(json!({
            "transport":"wsl", "launcherPath":"C:/Windows/System32/wsl.exe",
            "workerId":"CK-Compiler-Lab-20261024", "allowColdStart":cold_start,
            "workerRoot":"/lab", "allowedFqbns":["exact"]
        }))
        .unwrap()
    }

    #[test]
    fn mapped_exchange_is_explicit_and_wsl_only() {
        let mut config = wsl_test_config(true);
        assert!(!config.direct_mapped_exchange);
        config.docker_path = std::env::current_exe().unwrap();
        config.direct_mapped_exchange = true;
        assert!(config.validate().is_ok());
        config.transport = Transport::Docker;
        config.context = "desktop-linux".into();
        assert!(config.validate().is_err());
        config.direct_mapped_exchange = false;
        assert!(config.validate().is_ok());
    }

    #[test]
    fn wsl_config_and_argument_translation_preserve_boundaries() {
        let config = wsl_test_config(true);
        assert_eq!(config.transport, Transport::Wsl);
        assert!(config.allow_cold_start);
        assert!(config.context.is_empty());
        let code = "print('space and ; shell $syntax')";
        let command = config
            .command(&[
                "exec".into(),
                "-i".into(),
                config.container.clone(),
                "python3".into(),
                "-c".into(),
                code.into(),
            ])
            .unwrap();
        assert_eq!(
            command.as_std().get_args().collect::<Vec<_>>(),
            [
                "-d",
                "CK-Compiler-Lab-20261024",
                "-u",
                "root",
                "--cd",
                "/lab",
                "--exec",
                "python3",
                "-c",
                code
            ]
        );
        assert!(
            config
                .command(&["exec".into(), "another-worker".into(), "true".into()])
                .is_err()
        );
        assert!(
            config
                .command(&["start".into(), config.container.clone()])
                .is_err()
        );
        assert!(!wsl_test_config(false).allow_cold_start);
    }

    #[test]
    fn wsl_paths_support_local_unicode_and_reject_other_namespaces() {
        assert_eq!(
            wsl_local_path(r"C:\Users\project name\代码").unwrap(),
            "/mnt/c/Users/project name/代码"
        );
        assert_eq!(
            wsl_local_path(r"\\?\D:\build\file").unwrap(),
            "/mnt/d/build/file"
        );
        for path in [
            r"\\server\share",
            r"\\?\UNC\server\share",
            r"C:relative",
            "relative",
            "/tmp/other",
            "C:/safe/../outside",
            "C:/file:stream",
            "C:/a\0b",
        ] {
            assert!(wsl_local_path(path).is_err(), "accepted {path:?}");
        }
    }

    #[test]
    fn wsl_transfer_is_limited_to_request_staging_and_export() {
        let config = wsl_test_config(false);
        let prefix = format!("{}:/tmp/ck-product-id", config.container);
        let command = config
            .command(&["cp".into(), "C:/input with spaces".into(), prefix.clone()])
            .unwrap();
        let args = command.as_std().get_args().collect::<Vec<_>>();
        assert_eq!(args[args.len() - 2], "/mnt/c/input with spaces");
        assert_eq!(args[args.len() - 1], "/tmp/ck-product-id");
        assert!(
            config
                .command(&["cp".into(), format!("{prefix}/export"), "D:/output".into()])
                .is_ok()
        );
        for remote in [
            format!("{}:/lab", config.container),
            format!("{prefix}/../outside"),
            "different:/tmp/ck-product-id".into(),
        ] {
            assert!(
                config
                    .command(&["cp".into(), "C:/input".into(), remote])
                    .is_err()
            );
        }
        assert!(
            config
                .command(&["cp".into(), prefix, "D:/output".into()])
                .is_err()
        );
    }

    #[test]
    fn wsl_distribution_list_decodes_windows_unicode_and_utf8() {
        let names = "docker-desktop\r\nCK-Compiler-Lab-20261024\r\n";
        let wide: Vec<u8> = names.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(wsl_list_text(&wide), names);
        let bom = [vec![0xff, 0xfe], wide].concat();
        assert_eq!(wsl_list_text(&bom), names);
        assert_eq!(wsl_list_text(names.as_bytes()), names);
        assert_eq!(wsl_list_text(&[]), "");
    }

    #[test]
    fn exact_replay_preserves_existing_policy_and_source_boundary() {
        assert!(may_replay(
            false,
            CkExactReusePolicy::Allow,
            true,
            "same",
            "same"
        ));
        assert!(!may_replay(
            true,
            CkExactReusePolicy::Allow,
            true,
            "same",
            "same"
        ));
        assert!(!may_replay(
            false,
            CkExactReusePolicy::Deny,
            true,
            "same",
            "same"
        ));
        assert!(!may_replay(
            false,
            CkExactReusePolicy::Allow,
            false,
            "same",
            "same"
        ));
        assert!(!may_replay(
            false,
            CkExactReusePolicy::Allow,
            true,
            "new",
            "old"
        ));
    }
    #[test]
    fn parallel_inventory_is_complete_and_content_sensitive() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("nested")).unwrap();
        std::fs::write(directory.path().join("a.h"), b"first").unwrap();
        std::fs::write(directory.path().join("nested/b.a"), b"archive").unwrap();
        std::fs::write(directory.path().join("installed.json"), b"host receipt").unwrap();
        let original = inventory(directory.path(), true).unwrap();
        assert_eq!(
            original,
            BTreeMap::from([
                ("a.h".into(), digest(b"first")),
                ("nested/b.a".into(), digest(b"archive"))
            ])
        );
        std::fs::write(directory.path().join("a.h"), b"other").unwrap();
        assert_ne!(inventory(directory.path(), true).unwrap(), original);
        assert_eq!(inventory(directory.path(), false).unwrap().len(), 3);
    }
    #[test]
    fn receipt_must_match_the_actual_request() {
        let request = json!({"protocol":1,"requestId":"id","fqbn":"target","sourceSha256":"source","buildSignature":"signature"});
        let mut receipt = request.clone();
        assert!(validate_receipt(&receipt, &request).is_ok());
        for key in ["requestId", "fqbn", "sourceSha256", "buildSignature"] {
            receipt = request.clone();
            receipt[key] = json!("changed");
            assert!(validate_receipt(&receipt, &request).is_err());
        }
        receipt = request.clone();
        receipt["success"] = json!(true);
        assert!(validate_receipt(&receipt, &request).is_err());
    }
    #[test]
    fn export_rejects_traversal_and_tampering() {
        let directory = tempfile::tempdir().unwrap();
        let mut rows = Vec::new();
        for name in ["sketch.ino.bin", "sketch.ino.elf"] {
            std::fs::write(directory.path().join(name), b"data").unwrap();
            rows.push(json!({"name":name,"bytes":4,"sha256":digest(b"data")}));
        }
        let mut receipt = json!({"artifacts":rows});
        assert!(verify_exports(directory.path(), &receipt).is_ok());
        std::fs::write(directory.path().join("sketch.ino.bin"), b"evil").unwrap();
        assert!(verify_exports(directory.path(), &receipt).is_err());
        receipt["artifacts"][0]["name"] = json!("../outside.bin");
        assert!(verify_exports(directory.path(), &receipt).is_err());
    }
}
