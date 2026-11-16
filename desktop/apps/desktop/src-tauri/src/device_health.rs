use ck_core::builder::demo::{Esp32DeviceObservation, Esp32DeviceProbeOutcome, probe_esp32_device};
use ck_core::sysroot::Sysroot;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use std::time::Instant;

const DEVICE_HEALTH_SCHEMA_VERSION: u8 = 1;
const MAX_FQBN_LEN: usize = 500;
const MAX_PORT_LEN: usize = 160;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectDeviceRequest {
    pub request_id: u64,
    pub fqbn: String,
    pub port: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceHealthReport {
    schema_version: u8,
    request_id: u64,
    outcome: DeviceHealthOutcome,
    observed_at: String,
    duration_ms: u64,
    target: DeviceHealthTarget,
    device: DeviceHealthDevice,
    memory: DeviceHealthMemory,
    checks: Vec<DeviceHealthCheck>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum DeviceHealthOutcome {
    Complete,
    Partial,
    Failed,
    Unsupported,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceHealthTarget {
    requested_fqbn: String,
    resolved_fqbn: String,
    build_mcu: Option<String>,
    configured_flash_bytes: Option<u64>,
    partition_scheme: Option<String>,
    psram_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceHealthDevice {
    device_id: Option<String>,
    identity_source: DeviceHealthIdentitySource,
    chip: Option<String>,
    revision: Option<String>,
    /// Full MAC is returned only to the local, ephemeral device-health UI.
    /// Persistent baselines continue to store only `device_id`, and diagnostic
    /// bundle export independently redacts hardware addresses.
    mac: Option<String>,
    mac_suffix: Option<String>,
    port_before: String,
    port_after: Option<String>,
    usb: Option<DeviceHealthUsbIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceHealthUsbIdentity {
    vid: u16,
    pid: u16,
    serial_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum DeviceHealthIdentitySource {
    ChipMac,
    SessionPort,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceHealthMemory {
    flash_bytes: Option<u64>,
    psram_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceHealthCheck {
    id: String,
    state: DeviceHealthCheckState,
    certainty: DeviceHealthCheckCertainty,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    evidence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<DeviceHealthAction>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum DeviceHealthCheckState {
    Pass,
    Warning,
    Error,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum DeviceHealthCheckCertainty {
    Certain,
    Hint,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum DeviceHealthAction {
    RescanPorts,
    ShowBootHelp,
    OpenBoardConfig,
}

#[derive(Debug, Clone, Default)]
struct ResolvedTargetFacts {
    build_mcu: Option<String>,
    configured_flash_bytes: Option<u64>,
    configured_flash_raw: Option<String>,
    partition_scheme: Option<String>,
    psram_mode: Option<String>,
    psram_expected_enabled: Option<bool>,
}

fn serial_operation_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

pub type SerialOperationGuard = tokio::sync::MutexGuard<'static, ()>;

/// Evidence returned by the stricter recovery gate. Unlike the normal upload
/// probe, firmware recovery refuses to continue when the chip family or
/// physical Flash capacity cannot be confirmed. The full MAC is never exposed.
pub struct FirmwareRestoreGateEvidence {
    pub chip: String,
    pub flash_bytes: u64,
    pub psram_bytes: Option<u64>,
}

pub fn try_acquire_serial_operation() -> Result<SerialOperationGuard, String> {
    serial_operation_lock()
        .try_lock()
        .map_err(|_| "另一项串口操作正在进行，请等待其结束后重试".to_string())
}

pub async fn validate_firmware_restore_target(
    sysroot: &Sysroot,
    resolved_fqbn: &str,
    port: &str,
) -> Result<(SerialOperationGuard, FirmwareRestoreGateEvidence), String> {
    let normalized_port = port.trim();
    if normalized_port.is_empty()
        || normalized_port.len() > MAX_PORT_LEN
        || normalized_port
            .chars()
            .any(|character| matches!(character, '\0' | '\r' | '\n'))
    {
        return Err("恢复固件已阻止：串口参数无效".into());
    }
    if !is_supported_esp32_fqbn(resolved_fqbn) {
        return Err("恢复固件已阻止：当前目标不支持 ESP32 真机门禁".into());
    }
    let facts = resolve_target_facts(sysroot, resolved_fqbn)
        .await
        .map_err(|_| "恢复固件已阻止：无法解析基线的芯片和 Flash 配置".to_string())?;
    let expected_chip = facts
        .build_mcu
        .as_deref()
        .and_then(chip_family_token)
        .ok_or_else(|| "恢复固件已阻止：基线没有可验证的芯片族".to_string())?;
    let configured_flash = facts
        .configured_flash_bytes
        .ok_or_else(|| "恢复固件已阻止：基线没有可验证的 Flash 容量配置".to_string())?;

    let guard =
        try_acquire_serial_operation().map_err(|reason| format!("恢复固件未开始：{reason}"))?;
    let (_cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    let observation = match probe_esp32_device(sysroot, normalized_port, &mut cancel_rx).await {
        Esp32DeviceProbeOutcome::Success(observation) => observation,
        Esp32DeviceProbeOutcome::Failed(reason) => {
            return Err(format!(
                "恢复固件已阻止：真机握手失败（{}）",
                sanitized_probe_failure(&reason)
            ));
        }
        Esp32DeviceProbeOutcome::TimedOut => {
            return Err("恢复固件已阻止：真机握手超时，未确认芯片与 Flash".into());
        }
        Esp32DeviceProbeOutcome::Canceled => {
            return Err("恢复固件已取消：真机门禁尚未完成".into());
        }
    };
    let chip = observation
        .chip
        .as_deref()
        .and_then(bounded_chip_label)
        .ok_or_else(|| "恢复固件已阻止：真机未明确报告芯片型号".to_string())?;
    let observed_chip =
        chip_family_token(&chip).ok_or_else(|| "恢复固件已阻止：无法识别真机芯片族".to_string())?;
    if observed_chip != expected_chip {
        return Err(format!(
            "恢复固件已阻止：基线目标为 {expected_chip}，当前真机为 {observed_chip}"
        ));
    }
    let flash_bytes = positive_capacity(observation.detected_flash_bytes)
        .ok_or_else(|| "恢复固件已阻止：真机未明确报告实体 Flash 容量".to_string())?;
    if configured_flash > flash_bytes {
        return Err(format!(
            "恢复固件已阻止：基线配置需要 {}，真机只报告 {}",
            format_capacity(configured_flash),
            format_capacity(flash_bytes)
        ));
    }

    Ok((
        guard,
        FirmwareRestoreGateEvidence {
            chip,
            flash_bytes,
            psram_bytes: positive_capacity(observation.detected_psram_bytes),
        },
    ))
}

fn bounded_chip_label(value: &str) -> Option<String> {
    bounded_text(value, 120)
}

pub fn unsupported_report(
    request: InspectDeviceRequest,
    resolved_fqbn: Option<String>,
    started: Instant,
) -> DeviceHealthReport {
    let request = normalized_request(request);
    base_report(
        &request,
        resolved_fqbn.unwrap_or_else(|| request.fqbn.clone()),
        DeviceHealthOutcome::Unsupported,
        started,
        ResolvedTargetFacts::default(),
        empty_device(&request.port),
        DeviceHealthMemory {
            flash_bytes: None,
            psram_bytes: None,
        },
        vec![check(
            "target-support",
            DeviceHealthCheckState::Unknown,
            DeviceHealthCheckCertainty::Hint,
            "当前编译目标暂不支持真机体检",
            Some("首版仅支持解析为 esp32:esp32:* 的板卡目标".into()),
            None,
        )],
    )
}

pub fn failed_report(
    request: InspectDeviceRequest,
    resolved_fqbn: Option<String>,
    started: Instant,
    check_id: &str,
    title: &str,
    evidence: &str,
    action: Option<&str>,
) -> DeviceHealthReport {
    let request = normalized_request(request);
    let action = match action {
        Some("rescan_ports") => Some(DeviceHealthAction::RescanPorts),
        Some("show_boot_help") => Some(DeviceHealthAction::ShowBootHelp),
        Some("open_board_config") => Some(DeviceHealthAction::OpenBoardConfig),
        _ => None,
    };
    base_report(
        &request,
        resolved_fqbn.unwrap_or_else(|| request.fqbn.clone()),
        DeviceHealthOutcome::Failed,
        started,
        ResolvedTargetFacts::default(),
        empty_device(&request.port),
        DeviceHealthMemory {
            flash_bytes: None,
            psram_bytes: None,
        },
        vec![check(
            check_id,
            DeviceHealthCheckState::Error,
            DeviceHealthCheckCertainty::Certain,
            title,
            bounded_text(evidence, 300),
            action,
        )],
    )
}

pub async fn inspect_resolved_device(
    sysroot: &Sysroot,
    request: InspectDeviceRequest,
    resolved_fqbn: String,
    started: Instant,
) -> DeviceHealthReport {
    let request = normalized_request(request);
    if let Some(reason) = invalid_request_reason(&request) {
        return failed_report(
            request,
            Some(resolved_fqbn),
            started,
            "invalid-request",
            "真机体检请求无效",
            reason,
            Some("rescan_ports"),
        );
    }
    if !is_supported_esp32_fqbn(&resolved_fqbn) {
        return unsupported_report(request, Some(resolved_fqbn), started);
    }

    let facts = match resolve_target_facts(sysroot, &resolved_fqbn).await {
        Ok(facts) => facts,
        Err(_) => {
            return failed_report(
                request,
                Some(resolved_fqbn),
                started,
                "target-properties",
                "未能解析当前板卡核心配置",
                "无法可靠读取 build.mcu、Flash、分区或 PSRAM 配置；未执行真机探测",
                Some("open_board_config"),
            );
        }
    };

    let _serial_guard = match try_acquire_serial_operation() {
        Ok(guard) => guard,
        Err(reason) => {
            return report_for_probe_failure(
                &request,
                resolved_fqbn,
                facts,
                started,
                "device-probe-busy",
                "串口正被其他操作占用",
                &reason,
                None,
            );
        }
    };

    let (_cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    let outcome = probe_esp32_device(sysroot, &request.port, &mut cancel_rx).await;
    report_from_probe_outcome(&request, resolved_fqbn, facts, outcome, started)
}

async fn resolve_target_facts(
    sysroot: &Sysroot,
    resolved_fqbn: &str,
) -> Result<ResolvedTargetFacts, String> {
    let placeholder = std::env::temp_dir().join("CK_DeviceHealth_Properties");
    let resolved = ck_core::builder::direct_engine::resolve_properties(
        &sysroot.root_dir,
        resolved_fqbn,
        &placeholder,
        &placeholder,
        "device_health.ino",
        &[],
    )
    .await
    .map_err(|_| "board property resolution failed".to_string())?;
    Ok(target_facts_from_properties(resolved_fqbn, &resolved.props))
}

fn target_facts_from_properties(
    resolved_fqbn: &str,
    props: &std::collections::HashMap<String, String>,
) -> ResolvedTargetFacts {
    let build_mcu = property_text(props, "build.mcu", 100);
    let configured_flash_raw = property_text(props, "build.flash_size", 80);
    let configured_flash_bytes = configured_flash_raw
        .as_deref()
        .and_then(parse_capacity_bytes);
    let partition_scheme = property_text(props, "build.partitions", 160);
    let resolved_psram_type = property_text(props, "build.psram_type", 100);
    let psram_option = fqbn_option_value(resolved_fqbn, "PSRAM");
    let has_psram_define = props
        .get("build.defines")
        .map(|value| value.contains("BOARD_HAS_PSRAM"))
        .unwrap_or(false);
    let psram_expected_enabled = match psram_option.as_deref().map(normalized_token) {
        Some(value) if matches!(value.as_str(), "disabled" | "disable" | "off" | "none") => {
            Some(false)
        }
        Some(_) => Some(true),
        None if has_psram_define => Some(true),
        None => None,
    };
    let psram_mode = if psram_expected_enabled == Some(false) {
        Some("disabled".to_string())
    } else {
        resolved_psram_type
    };

    ResolvedTargetFacts {
        build_mcu,
        configured_flash_bytes,
        configured_flash_raw,
        partition_scheme,
        psram_mode,
        psram_expected_enabled,
    }
}

fn report_from_probe_outcome(
    request: &InspectDeviceRequest,
    resolved_fqbn: String,
    facts: ResolvedTargetFacts,
    outcome: Esp32DeviceProbeOutcome,
    started: Instant,
) -> DeviceHealthReport {
    match outcome {
        Esp32DeviceProbeOutcome::Success(observation) => {
            report_from_observation(request, resolved_fqbn, facts, observation, started)
        }
        Esp32DeviceProbeOutcome::Failed(reason) => report_for_probe_failure(
            request,
            resolved_fqbn,
            facts,
            started,
            "device-handshake",
            "未能与 ESP32 建立可靠握手",
            sanitized_probe_failure(&reason),
            Some(DeviceHealthAction::ShowBootHelp),
        ),
        Esp32DeviceProbeOutcome::TimedOut => report_for_probe_failure(
            request,
            resolved_fqbn,
            facts,
            started,
            "device-handshake",
            "ESP32 真机握手超时",
            "在安全时限内未收到芯片响应；请检查端口、数据线与 BOOT 操作",
            Some(DeviceHealthAction::ShowBootHelp),
        ),
        Esp32DeviceProbeOutcome::Canceled => report_for_probe_failure(
            request,
            resolved_fqbn,
            facts,
            started,
            "device-handshake",
            "ESP32 真机体检已取消",
            "探测在完成握手前被取消，未写入 Flash",
            None,
        ),
    }
}

fn report_from_observation(
    request: &InspectDeviceRequest,
    resolved_fqbn: String,
    facts: ResolvedTargetFacts,
    observation: Esp32DeviceObservation,
    started: Instant,
) -> DeviceHealthReport {
    let chip = observation
        .chip
        .as_deref()
        .and_then(|value| bounded_text(value, 120));
    let revision = observation
        .revision
        .as_deref()
        .and_then(|value| bounded_text(value, 80));
    let normalized_mac = observation.mac.as_deref().and_then(normalize_mac);
    let mac_suffix = normalized_mac.as_deref().map(mac_suffix);
    let device_id = match (chip.as_deref(), normalized_mac.as_deref()) {
        (Some(chip), Some(mac)) => Some(device_id_for_chip_mac(chip, mac)),
        _ => None,
    };
    let identity_source = if device_id.is_some() {
        DeviceHealthIdentitySource::ChipMac
    } else {
        DeviceHealthIdentitySource::SessionPort
    };
    let flash_bytes = positive_capacity(observation.detected_flash_bytes);
    let psram_bytes = positive_capacity(observation.detected_psram_bytes);

    let checks = vec![
        handshake_success_check(chip.as_deref(), revision.as_deref()),
        chip_match_check(facts.build_mcu.as_deref(), chip.as_deref()),
        flash_match_check(
            facts.configured_flash_bytes,
            facts.configured_flash_raw.as_deref(),
            flash_bytes,
        ),
        psram_match_check(
            facts.psram_expected_enabled,
            facts.psram_mode.as_deref(),
            psram_bytes,
        ),
    ];
    let outcome = outcome_from_checks(&checks);
    let device = DeviceHealthDevice {
        device_id,
        identity_source,
        chip,
        revision,
        mac: normalized_mac,
        mac_suffix,
        port_before: request.port.clone(),
        // This first version does not perform USB topology enumeration. The
        // port is only the same session port observed before and after reset.
        port_after: Some(request.port.clone()),
        usb: None,
    };
    base_report(
        request,
        resolved_fqbn,
        outcome,
        started,
        facts,
        device,
        DeviceHealthMemory {
            flash_bytes,
            psram_bytes,
        },
        checks,
    )
}

fn report_for_probe_failure(
    request: &InspectDeviceRequest,
    resolved_fqbn: String,
    facts: ResolvedTargetFacts,
    started: Instant,
    check_id: &str,
    title: &str,
    evidence: &str,
    action: Option<DeviceHealthAction>,
) -> DeviceHealthReport {
    let checks = vec![
        check(
            check_id,
            DeviceHealthCheckState::Error,
            DeviceHealthCheckCertainty::Certain,
            title,
            bounded_text(evidence, 300),
            action,
        ),
        unknown_check("chip-match", "未能确认芯片型号与编译目标"),
        unknown_check("flash-capacity", "未能确认实体 Flash 容量"),
        unknown_check("psram", "未能确认 PSRAM 状态"),
    ];
    base_report(
        request,
        resolved_fqbn,
        DeviceHealthOutcome::Failed,
        started,
        facts,
        empty_device(&request.port),
        DeviceHealthMemory {
            flash_bytes: None,
            psram_bytes: None,
        },
        checks,
    )
}

fn base_report(
    request: &InspectDeviceRequest,
    resolved_fqbn: String,
    outcome: DeviceHealthOutcome,
    started: Instant,
    facts: ResolvedTargetFacts,
    device: DeviceHealthDevice,
    memory: DeviceHealthMemory,
    checks: Vec<DeviceHealthCheck>,
) -> DeviceHealthReport {
    DeviceHealthReport {
        schema_version: DEVICE_HEALTH_SCHEMA_VERSION,
        request_id: request.request_id,
        outcome,
        observed_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        target: DeviceHealthTarget {
            requested_fqbn: request.fqbn.clone(),
            resolved_fqbn,
            build_mcu: facts.build_mcu,
            configured_flash_bytes: facts.configured_flash_bytes,
            partition_scheme: facts.partition_scheme,
            psram_mode: facts.psram_mode,
        },
        device,
        memory,
        checks,
    }
}

fn empty_device(port: &str) -> DeviceHealthDevice {
    DeviceHealthDevice {
        device_id: None,
        identity_source: DeviceHealthIdentitySource::SessionPort,
        chip: None,
        revision: None,
        mac: None,
        mac_suffix: None,
        port_before: port.to_string(),
        port_after: Some(port.to_string()),
        usb: None,
    }
}

fn handshake_success_check(chip: Option<&str>, revision: Option<&str>) -> DeviceHealthCheck {
    let evidence = match (chip, revision) {
        (Some(chip), Some(revision)) => format!("芯片报告：{chip} · {revision}"),
        (Some(chip), None) => format!("芯片报告：{chip}"),
        (None, _) => "esptool 已响应，但没有明确报告芯片型号".to_string(),
    };
    check(
        "device-handshake",
        DeviceHealthCheckState::Pass,
        DeviceHealthCheckCertainty::Certain,
        "ESP32 真机握手成功",
        Some(evidence),
        None,
    )
}

fn chip_match_check(expected: Option<&str>, observed: Option<&str>) -> DeviceHealthCheck {
    match (
        expected.and_then(chip_family_token),
        observed.and_then(chip_family_token),
    ) {
        (Some(expected_family), Some(observed_family)) if expected_family == observed_family => {
            check(
                "chip-match",
                DeviceHealthCheckState::Pass,
                DeviceHealthCheckCertainty::Certain,
                "芯片型号与编译目标匹配",
                Some(format!(
                    "编译目标 {expected_family} · 真机 {observed_family}"
                )),
                None,
            )
        }
        (Some(expected_family), Some(observed_family)) => check(
            "chip-match",
            DeviceHealthCheckState::Error,
            DeviceHealthCheckCertainty::Certain,
            "芯片型号与编译目标不匹配",
            Some(format!(
                "编译目标 {expected_family} · 真机 {observed_family}"
            )),
            Some(DeviceHealthAction::OpenBoardConfig),
        ),
        _ => unknown_check("chip-match", "芯片型号匹配关系尚不明确"),
    }
}

fn flash_match_check(
    configured: Option<u64>,
    configured_raw: Option<&str>,
    detected: Option<u64>,
) -> DeviceHealthCheck {
    match (configured, detected) {
        (Some(configured), Some(detected)) if configured == detected => check(
            "flash-capacity",
            DeviceHealthCheckState::Pass,
            DeviceHealthCheckCertainty::Certain,
            "实体 Flash 与板卡配置匹配",
            Some(format!("配置与实测均为 {}", format_capacity(detected))),
            None,
        ),
        (Some(configured), Some(detected)) if configured > detected => check(
            "flash-capacity",
            DeviceHealthCheckState::Error,
            DeviceHealthCheckCertainty::Certain,
            "板卡配置的 Flash 大于实体容量",
            Some(format!(
                "配置 {} · 实测 {}；继续烧录可能越界",
                format_capacity(configured),
                format_capacity(detected)
            )),
            Some(DeviceHealthAction::OpenBoardConfig),
        ),
        (Some(configured), Some(detected)) => check(
            "flash-capacity",
            DeviceHealthCheckState::Warning,
            DeviceHealthCheckCertainty::Certain,
            "当前配置只使用了部分实体 Flash",
            Some(format!(
                "配置 {} · 实测 {}",
                format_capacity(configured),
                format_capacity(detected)
            )),
            Some(DeviceHealthAction::OpenBoardConfig),
        ),
        (None, Some(detected)) => check(
            "flash-capacity",
            DeviceHealthCheckState::Unknown,
            DeviceHealthCheckCertainty::Hint,
            "已读取实体 Flash，但配置容量不明确",
            Some(format!(
                "实测 {}{}",
                format_capacity(detected),
                configured_raw
                    .map(|raw| format!(" · build.flash_size={raw} 无法可靠解析"))
                    .unwrap_or_default()
            )),
            Some(DeviceHealthAction::OpenBoardConfig),
        ),
        (Some(configured), None) => check(
            "flash-capacity",
            DeviceHealthCheckState::Unknown,
            DeviceHealthCheckCertainty::Hint,
            "实体 Flash 容量未被真机明确报告",
            Some(format!("当前配置为 {}", format_capacity(configured))),
            None,
        ),
        (None, None) => unknown_check("flash-capacity", "Flash 容量关系尚不明确"),
    }
}

fn psram_match_check(
    expected_enabled: Option<bool>,
    mode: Option<&str>,
    detected: Option<u64>,
) -> DeviceHealthCheck {
    match (expected_enabled, detected) {
        (Some(true), Some(bytes)) => check(
            "psram",
            DeviceHealthCheckState::Pass,
            DeviceHealthCheckCertainty::Certain,
            "已启用的 PSRAM 获得真机报告",
            Some(format!(
                "模式 {} · 实测 {}",
                mode.unwrap_or("已启用"),
                format_capacity(bytes)
            )),
            None,
        ),
        (Some(false), Some(bytes)) => check(
            "psram",
            DeviceHealthCheckState::Warning,
            DeviceHealthCheckCertainty::Certain,
            "真机报告了 PSRAM，但当前配置未启用",
            Some(format!("实测 {} · 配置 disabled", format_capacity(bytes))),
            Some(DeviceHealthAction::OpenBoardConfig),
        ),
        (Some(false), None) => check(
            "psram",
            DeviceHealthCheckState::Pass,
            DeviceHealthCheckCertainty::Certain,
            "当前板卡配置明确未启用 PSRAM",
            Some("未把“未报告容量”推断为硬件不存在".into()),
            None,
        ),
        (Some(true), None) => check(
            "psram",
            DeviceHealthCheckState::Unknown,
            DeviceHealthCheckCertainty::Hint,
            "已配置 PSRAM，但真机未明确报告容量",
            Some(format!(
                "模式 {}；未报告不等于不存在",
                mode.unwrap_or("已启用")
            )),
            None,
        ),
        (None, Some(bytes)) => check(
            "psram",
            DeviceHealthCheckState::Unknown,
            DeviceHealthCheckCertainty::Hint,
            "真机报告了 PSRAM，但配置意图不明确",
            Some(format!("实测 {}", format_capacity(bytes))),
            Some(DeviceHealthAction::OpenBoardConfig),
        ),
        (None, None) => unknown_check("psram", "PSRAM 未被明确报告，保持未知"),
    }
}

fn unknown_check(id: &str, title: &str) -> DeviceHealthCheck {
    check(
        id,
        DeviceHealthCheckState::Unknown,
        DeviceHealthCheckCertainty::Hint,
        title,
        None,
        None,
    )
}

fn check(
    id: &str,
    state: DeviceHealthCheckState,
    certainty: DeviceHealthCheckCertainty,
    title: &str,
    evidence: Option<String>,
    action: Option<DeviceHealthAction>,
) -> DeviceHealthCheck {
    DeviceHealthCheck {
        id: id.to_string(),
        state,
        certainty,
        title: title.to_string(),
        evidence,
        action,
    }
}

fn outcome_from_checks(checks: &[DeviceHealthCheck]) -> DeviceHealthOutcome {
    if checks
        .iter()
        .any(|check| check.state == DeviceHealthCheckState::Error)
    {
        DeviceHealthOutcome::Failed
    } else if checks.iter().any(|check| {
        matches!(
            check.state,
            DeviceHealthCheckState::Warning | DeviceHealthCheckState::Unknown
        )
    }) {
        DeviceHealthOutcome::Partial
    } else {
        DeviceHealthOutcome::Complete
    }
}

fn is_supported_esp32_fqbn(fqbn: &str) -> bool {
    let mut parts = fqbn.trim().split(':');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(package), Some(architecture), Some(board))
            if package.eq_ignore_ascii_case("esp32")
                && architecture.eq_ignore_ascii_case("esp32")
                && !board.trim().is_empty()
    )
}

fn invalid_request_reason(request: &InspectDeviceRequest) -> Option<&'static str> {
    if request.request_id == 0 {
        return Some("requestId 必须为正整数");
    }
    if request.fqbn.is_empty() || request.fqbn.len() > MAX_FQBN_LEN {
        return Some("FQBN 为空或长度异常");
    }
    if request.port.is_empty()
        || request.port.len() > MAX_PORT_LEN
        || request
            .port
            .chars()
            .any(|character| matches!(character, '\0' | '\r' | '\n'))
    {
        return Some("串口名称为空或包含非法字符");
    }
    None
}

fn normalized_request(mut request: InspectDeviceRequest) -> InspectDeviceRequest {
    request.fqbn = request.fqbn.trim().to_string();
    request.port = request.port.trim().to_string();
    request
}

fn property_text(
    props: &std::collections::HashMap<String, String>,
    key: &str,
    max_len: usize,
) -> Option<String> {
    props
        .get(key)
        .and_then(|value| bounded_text(value, max_len))
}

fn bounded_text(value: &str, max_len: usize) -> Option<String> {
    let sanitized = value
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>();
    let trimmed = sanitized.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(max_len).collect())
}

fn fqbn_option_value(fqbn: &str, wanted: &str) -> Option<String> {
    fqbn.splitn(4, ':').nth(3)?.split(',').find_map(|entry| {
        let (key, value) = entry.split_once('=')?;
        key.trim()
            .eq_ignore_ascii_case(wanted)
            .then(|| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn normalized_token(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .collect()
}

fn parse_capacity_bytes(value: &str) -> Option<u64> {
    let compact = value.trim().replace([' ', '_'], "").to_ascii_uppercase();
    if compact.is_empty() {
        return None;
    }
    if let Some(hex) = compact.strip_prefix("0X") {
        return u64::from_str_radix(hex, 16).ok().filter(|value| *value > 0);
    }
    let mut number = compact.as_str();
    let mut multiplier = 1_u64;
    for suffix in ["GIB", "GB", "G", "MIB", "MB", "M", "KIB", "KB", "K"] {
        if let Some(stripped) = compact.strip_suffix(suffix) {
            multiplier = match suffix.chars().next() {
                Some('G') => 1024_u64.pow(3),
                Some('M') => 1024_u64.pow(2),
                Some('K') => 1024_u64,
                _ => 1,
            };
            // The suffix list is longest-first, so this is unambiguous.
            number = stripped;
            break;
        }
    }
    let number = number.parse::<u64>().ok()?;
    number.checked_mul(multiplier).filter(|value| *value > 0)
}

fn positive_capacity(value: Option<u64>) -> Option<u64> {
    value.filter(|value| *value > 0)
}

fn chip_family_token(value: &str) -> Option<String> {
    let normalized = normalized_token(value);
    let start = normalized.find("esp32")?;
    let rest = &normalized[start + "esp32".len()..];
    let mut characters = rest.chars();
    let family_prefix = characters.next();
    if matches!(family_prefix, Some('c' | 'h' | 'p' | 's')) {
        let digits = characters
            .take_while(|character| character.is_ascii_digit())
            .collect::<String>();
        if !digits.is_empty() {
            return Some(format!("esp32{}{digits}", family_prefix.unwrap()));
        }
    }
    Some("esp32".to_string())
}

fn normalize_mac(value: &str) -> Option<String> {
    let digits = value
        .chars()
        .filter(|character| character.is_ascii_hexdigit())
        .map(|character| character.to_ascii_lowercase())
        .collect::<String>();
    if digits.len() != 12 {
        return None;
    }
    Some(
        digits
            .as_bytes()
            .chunks(2)
            .map(|chunk| std::str::from_utf8(chunk).ok())
            .collect::<Option<Vec<_>>>()?
            .join(":"),
    )
}

fn mac_suffix(mac: &str) -> String {
    mac.chars()
        .filter(|character| character.is_ascii_hexdigit())
        .rev()
        .take(6)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>()
        .to_ascii_uppercase()
}

fn device_id_for_chip_mac(chip: &str, normalized_mac: &str) -> String {
    let payload = format!("ck-device-v1|{}|{}", chip.trim(), normalized_mac);
    hex::encode(Sha256::digest(payload.as_bytes()))
}

fn sanitized_probe_failure(reason: &str) -> &'static str {
    let lower = reason.to_ascii_lowercase();
    if lower.contains("access is denied")
        || lower.contains("permission denied")
        || lower.contains("busy")
        || lower.contains("占用")
    {
        "串口被占用或当前进程没有访问权限"
    } else if lower.contains("not found")
        || lower.contains("no such")
        || lower.contains("cannot open")
        || lower.contains("could not open")
    {
        "未找到或无法打开所选串口"
    } else if lower.contains("boot") || lower.contains("connect") || lower.contains("sync") {
        "未进入可握手状态；请检查 BOOT 操作、数据线与供电"
    } else {
        "底层探测未成功；为保护设备隐私，原始串口输出未返回"
    }
}

fn format_capacity(bytes: u64) -> String {
    if bytes >= 1024 * 1024 && bytes % (1024 * 1024) == 0 {
        format!("{} MB", bytes / (1024 * 1024))
    } else if bytes >= 1024 && bytes % 1024 == 0 {
        format!("{} KB", bytes / 1024)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DeviceHealthCheckState, DeviceHealthOutcome, InspectDeviceRequest, ResolvedTargetFacts,
        chip_family_token, device_id_for_chip_mac, parse_capacity_bytes, report_from_probe_outcome,
        sanitized_probe_failure, target_facts_from_properties, try_acquire_serial_operation,
    };
    use ck_core::builder::demo::{Esp32DeviceObservation, Esp32DeviceProbeOutcome};
    use std::time::Instant;

    fn request() -> InspectDeviceRequest {
        InspectDeviceRequest {
            request_id: 7,
            fqbn: "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi"
                .into(),
            port: "COM8".into(),
        }
    }

    fn facts() -> ResolvedTargetFacts {
        ResolvedTargetFacts {
            build_mcu: Some("esp32s3".into()),
            configured_flash_bytes: Some(16 * 1024 * 1024),
            configured_flash_raw: Some("16MB".into()),
            partition_scheme: Some("app3M_fat9M_16MB".into()),
            psram_mode: Some("opi".into()),
            psram_expected_enabled: Some(true),
        }
    }

    fn observation() -> Esp32DeviceObservation {
        Esp32DeviceObservation {
            chip: Some("ESP32-S3".into()),
            revision: Some("v0.2".into()),
            mac: Some("10:20:30:a1:b2:c3".into()),
            detected_flash_bytes: Some(16 * 1024 * 1024),
            detected_psram_bytes: Some(8 * 1024 * 1024),
            frontend_lines: vec!["raw lines are intentionally ignored".into()],
        }
    }

    #[test]
    fn capacity_and_chip_parsers_are_deterministic() {
        assert_eq!(parse_capacity_bytes("16MB"), Some(16 * 1024 * 1024));
        assert_eq!(parse_capacity_bytes("8M"), Some(8 * 1024 * 1024));
        assert_eq!(parse_capacity_bytes("0x400000"), Some(4 * 1024 * 1024));
        assert_eq!(parse_capacity_bytes("4194304"), Some(4 * 1024 * 1024));
        assert_eq!(parse_capacity_bytes("unknown"), None);
        assert_eq!(
            chip_family_token("ESP32-S3 (QFN56)"),
            Some("esp32s3".into())
        );
        assert_eq!(chip_family_token("esp32c5"), Some("esp32c5".into()));
        assert_eq!(chip_family_token("ESP32-C61"), Some("esp32c61".into()));
    }

    #[test]
    fn final_core_properties_drive_target_facts_without_guessing_psram_presence() {
        let props = std::collections::HashMap::from([
            ("build.mcu".to_string(), "esp32s3".to_string()),
            ("build.flash_size".to_string(), "16MB".to_string()),
            (
                "build.partitions".to_string(),
                "app3M_fat9M_16MB".to_string(),
            ),
            ("build.psram_type".to_string(), "qspi".to_string()),
            ("build.defines".to_string(), String::new()),
        ]);
        let disabled = target_facts_from_properties(
            "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=disabled",
            &props,
        );
        assert_eq!(disabled.build_mcu.as_deref(), Some("esp32s3"));
        assert_eq!(disabled.configured_flash_bytes, Some(16 * 1024 * 1024));
        assert_eq!(
            disabled.partition_scheme.as_deref(),
            Some("app3M_fat9M_16MB")
        );
        assert_eq!(disabled.psram_mode.as_deref(), Some("disabled"));
        assert_eq!(disabled.psram_expected_enabled, Some(false));

        let unspecified = target_facts_from_properties(
            "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB",
            &props,
        );
        assert_eq!(unspecified.psram_mode.as_deref(), Some("qspi"));
        assert_eq!(
            unspecified.psram_expected_enabled, None,
            "build.psram_type alone must not be treated as proof that PSRAM is enabled"
        );
    }

    #[test]
    fn request_contract_accepts_the_frontend_camel_case_wrapper_payload() {
        let request: InspectDeviceRequest = serde_json::from_value(serde_json::json!({
            "requestId": 9,
            "fqbn": "esp32:esp32:esp32c5",
            "port": "COM8"
        }))
        .expect("camelCase request");
        assert_eq!(request.request_id, 9);
        assert_eq!(request.fqbn, "esp32:esp32:esp32c5");
        assert_eq!(request.port, "COM8");
        assert!(
            serde_json::from_value::<InspectDeviceRequest>(serde_json::json!({
                "request_id": 9,
                "fqbn": "esp32:esp32:esp32c5",
                "port": "COM8"
            }))
            .is_err(),
            "the Tauri request boundary must stay explicitly camelCase"
        );
    }

    #[test]
    fn process_wide_serial_gate_rejects_a_concurrent_operation() {
        let first = try_acquire_serial_operation().expect("first serial operation");
        assert!(try_acquire_serial_operation().is_err());
        drop(first);
        let second = try_acquire_serial_operation().expect("gate released");
        drop(second);
    }

    #[test]
    fn successful_report_returns_normalized_mac_to_the_local_ui_without_raw_probe_log() {
        let report = report_from_probe_outcome(
            &request(),
            request().fqbn,
            facts(),
            Esp32DeviceProbeOutcome::Success(observation()),
            Instant::now(),
        );
        assert_eq!(report.outcome, DeviceHealthOutcome::Complete);
        assert_eq!(report.device.mac.as_deref(), Some("10:20:30:a1:b2:c3"));
        assert_eq!(report.device.mac_suffix.as_deref(), Some("A1B2C3"));
        assert_eq!(report.device.device_id.as_deref().map(str::len), Some(64));
        assert_eq!(report.device.usb, None);
        assert_eq!(report.checks.len(), 4);
        assert!(
            report
                .checks
                .iter()
                .all(|check| check.state == DeviceHealthCheckState::Pass)
        );

        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("10:20:30:a1:b2:c3"));
        assert!(!json.contains("102030a1b2c3"));
        assert!(!json.contains("raw lines are intentionally ignored"));
        assert!(json.contains("\"identitySource\":\"chip-mac\""));
        assert!(json.contains("\"usb\":null"));
    }

    #[test]
    fn device_id_is_stable_and_contains_no_mac_material() {
        let first = device_id_for_chip_mac("ESP32-S3", "10:20:30:a1:b2:c3");
        let second = device_id_for_chip_mac("ESP32-S3", "10:20:30:a1:b2:c3");
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        assert!(!first.contains("a1b2c3"));
    }

    #[test]
    fn flash_mismatch_is_an_error_and_missing_psram_stays_unknown() {
        let mut observed = observation();
        observed.detected_flash_bytes = Some(8 * 1024 * 1024);
        observed.detected_psram_bytes = None;
        let report = report_from_probe_outcome(
            &request(),
            request().fqbn,
            facts(),
            Esp32DeviceProbeOutcome::Success(observed),
            Instant::now(),
        );
        assert_eq!(report.outcome, DeviceHealthOutcome::Failed);
        assert_eq!(report.memory.psram_bytes, None);
        assert_eq!(report.checks[2].state, DeviceHealthCheckState::Error);
        assert_eq!(report.checks[3].state, DeviceHealthCheckState::Unknown);
    }

    #[test]
    fn chip_mismatch_is_certain_but_absent_hardware_facts_are_not_invented() {
        let mut observed = observation();
        observed.chip = Some("ESP32-C3".into());
        observed.detected_flash_bytes = None;
        observed.detected_psram_bytes = None;
        observed.mac = None;
        let report = report_from_probe_outcome(
            &request(),
            request().fqbn,
            facts(),
            Esp32DeviceProbeOutcome::Success(observed),
            Instant::now(),
        );
        assert_eq!(report.outcome, DeviceHealthOutcome::Failed);
        assert_eq!(report.device.device_id, None);
        assert_eq!(report.memory.flash_bytes, None);
        assert_eq!(report.memory.psram_bytes, None);
        assert_eq!(report.checks[1].state, DeviceHealthCheckState::Error);
        assert_eq!(report.checks[2].state, DeviceHealthCheckState::Unknown);
    }

    #[test]
    fn failure_and_timeout_are_reports_and_failure_evidence_is_privacy_bounded() {
        let failure = report_from_probe_outcome(
            &request(),
            request().fqbn,
            facts(),
            Esp32DeviceProbeOutcome::Failed(
                "Connecting... MAC: 10:20:30:a1:b2:c3 failed to connect".into(),
            ),
            Instant::now(),
        );
        assert_eq!(failure.outcome, DeviceHealthOutcome::Failed);
        let json = serde_json::to_string(&failure).unwrap();
        assert!(!json.contains("10:20:30:a1:b2:c3"));
        assert!(!json.contains("Connecting..."));

        let timeout = report_from_probe_outcome(
            &request(),
            request().fqbn,
            facts(),
            Esp32DeviceProbeOutcome::TimedOut,
            Instant::now(),
        );
        assert_eq!(timeout.outcome, DeviceHealthOutcome::Failed);
        assert_eq!(timeout.checks[0].state, DeviceHealthCheckState::Error);
        assert_eq!(timeout.checks[1].state, DeviceHealthCheckState::Unknown);
        assert_eq!(
            sanitized_probe_failure("Access is denied: MAC aa:bb:cc:dd:ee:ff"),
            "串口被占用或当前进程没有访问权限"
        );
    }
}
