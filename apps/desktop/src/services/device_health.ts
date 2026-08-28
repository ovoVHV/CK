export type DeviceHealthOutcome = 'complete' | 'partial' | 'failed' | 'unsupported';
export type DeviceHealthCheckState = 'pass' | 'warning' | 'error' | 'unknown';
export type DeviceHealthCheckCertainty = 'certain' | 'hint';
export type DeviceHealthIdentitySource = 'chip-mac' | 'usb-serial' | 'session-port';
export type DeviceHealthAction = 'rescan_ports' | 'show_boot_help' | 'open_board_config';

export interface DeviceHealthCheck {
    id: string;
    state: DeviceHealthCheckState;
    certainty: DeviceHealthCheckCertainty;
    title: string;
    evidence?: string;
    action?: DeviceHealthAction;
}

export interface DeviceHealthTarget {
    requestedFqbn: string;
    resolvedFqbn: string;
    buildMcu: string | null;
    configuredFlashBytes: number | null;
    partitionScheme: string | null;
    psramMode: string | null;
}

export interface DeviceHealthUsbIdentity {
    vid: number;
    pid: number;
    serialId: string | null;
}

export interface DeviceHealthDevice {
    deviceId: string | null;
    identitySource: DeviceHealthIdentitySource;
    chip: string | null;
    revision: string | null;
    /** Full address is kept only in the current local device-health session. */
    mac: string | null;
    macSuffix: string | null;
    portBefore: string;
    portAfter: string | null;
    usb: DeviceHealthUsbIdentity | null;
}

export interface DeviceHealthReport {
    schemaVersion: 1;
    requestId: number;
    outcome: DeviceHealthOutcome;
    observedAt: string;
    durationMs: number;
    target: DeviceHealthTarget;
    device: DeviceHealthDevice;
    memory: {
        flashBytes: number | null;
        psramBytes: number | null;
    };
    checks: DeviceHealthCheck[];
}

export interface DeviceHealthRequestIdentity {
    requestId: number;
    fqbn: string;
    port: string;
}

export interface DeviceHealthPublication {
    target: DeviceHealthRequestIdentity;
    report: DeviceHealthReport;
}

export type DeviceHealthDisplayStatus = 'healthy' | 'attention' | 'problem' | 'unsupported';

export interface DeviceHealthPresentation {
    status: DeviceHealthDisplayStatus;
    title: string;
    explanation: string;
    chipLabel: string;
    identityLabel: string;
    flashLabel: string;
    psramLabel: string;
    portLabel: string;
    targetLabel: string;
    orderedChecks: DeviceHealthCheck[];
}

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : null
);

const pick = (record: UnknownRecord | null, ...keys: string[]): unknown => {
    if (!record) return undefined;
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
    }
    return undefined;
};

const boundedString = (value: unknown, maxLength = 500): string | null => {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text) return null;
    return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
};

const redactFullMacAddresses = (value: string): string => value
    .replace(
        /(^|[^0-9a-f])((?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2})(?![0-9a-f])/gi,
        '$1[已隐藏完整 MAC]',
    )
    .replace(
        /(^|[^0-9a-f])([0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})(?![0-9a-f])/gi,
        '$1[已隐藏完整 MAC]',
    )
    .replace(
        /\b(?:base\s+)?mac(?:\s+address)?\s*[:=]\s*[0-9a-f]{12}\b/gi,
        'MAC: [已隐藏完整 MAC]',
    );

const boundedPrivacyString = (value: unknown, maxLength = 500): string | null => {
    const text = boundedString(value, maxLength);
    return text ? redactFullMacAddresses(text) : null;
};

const normalizedMacSuffix = (value: unknown): string | null => {
    const text = boundedString(value, 20);
    return text && /^[0-9a-f]{6}$/i.test(text) ? text.toUpperCase() : null;
};

const normalizedMac = (value: unknown): string | null => {
    const text = boundedString(value, 32);
    if (!text) return null;
    const digits = text.replace(/[:.\-]/g, '');
    if (!/^[0-9a-f]{12}$/i.test(digits)) return null;
    return digits
        .match(/.{2}/g)!
        .map(part => part.toUpperCase())
        .join(':');
};

const normalizedDeviceId = (value: unknown): string | null => {
    const text = boundedString(value, 128);
    return text && /^[0-9a-f]{64}$/i.test(text) ? text.toLowerCase() : null;
};

const nonNegativeNumber = (value: unknown): number | null => {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
};

const positiveInteger = (value: unknown): number | null => {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
};

const enumValue = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (
    typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback
);

const parsePayload = (value: unknown): UnknownRecord | null => {
    if (typeof value !== 'string') return asRecord(value);
    try {
        return asRecord(JSON.parse(value));
    } catch {
        return null;
    }
};

const normalizeCheck = (value: unknown, index: number): DeviceHealthCheck | null => {
    const record = asRecord(value);
    if (!record) return null;
    const title = boundedPrivacyString(pick(record, 'title'), 240);
    if (!title) return null;
    const id = boundedString(pick(record, 'id'), 100) || `check-${index + 1}`;
    const rawState = pick(record, 'state');
    const stateAlias = rawState === 'ok' ? 'pass' : rawState === 'warn' ? 'warning' : rawState;
    const state = enumValue(
        stateAlias,
        ['pass', 'warning', 'error', 'unknown'] as const,
        'unknown',
    );
    const certainty = enumValue(
        pick(record, 'certainty'),
        ['certain', 'hint'] as const,
        state === 'unknown' ? 'hint' : 'certain',
    );
    const rawAction = pick(record, 'action');
    const action = typeof rawAction === 'string' && (
        ['rescan_ports', 'show_boot_help', 'open_board_config'] as const
    ).includes(rawAction as DeviceHealthAction)
        ? rawAction as DeviceHealthAction
        : undefined;
    return {
        id,
        state,
        certainty,
        title,
        evidence: boundedPrivacyString(pick(record, 'evidence')) || undefined,
        action,
    };
};

/** ESP32-only P0 gate. It deliberately does not infer support from a board name. */
export const isEsp32DeviceHealthTarget = (fqbn: string): boolean => (
    /^esp32:esp32:[^:]+(?::|$)/i.test(String(fqbn || '').trim())
);

export const isSameDeviceHealthTarget = (
    started: DeviceHealthRequestIdentity,
    current: DeviceHealthRequestIdentity,
): boolean => (
    started.requestId === current.requestId
    && started.port.trim() === current.port.trim()
    && started.fqbn.trim() === current.fqbn.trim()
);

/**
 * Accepts both direct Tauri objects and JSON strings, plus Rust snake_case and
 * frontend camelCase names. Missing facts remain unknown; the frontend never
 * invents a passing hardware observation.
 */
export const normalizeDeviceHealthReport = (
    value: unknown,
    fallback: DeviceHealthRequestIdentity,
): DeviceHealthReport | null => {
    const root = parsePayload(value);
    if (!root) return null;
    const targetRecord = asRecord(pick(root, 'target'));
    const deviceRecord = asRecord(pick(root, 'device'));
    const memoryRecord = asRecord(pick(root, 'memory'));
    const usbRecord = asRecord(pick(deviceRecord, 'usb'));
    const schemaVersion = positiveInteger(pick(root, 'schemaVersion', 'schema_version'));
    const requestId = positiveInteger(pick(root, 'requestId', 'request_id'));
    const requestedFqbn = boundedString(
        pick(targetRecord, 'requestedFqbn', 'requested_fqbn'),
        500,
    );
    const resolvedFqbn = boundedString(
        pick(targetRecord, 'resolvedFqbn', 'resolved_fqbn'),
        500,
    ) || requestedFqbn || '';
    const portBefore = boundedString(
        pick(deviceRecord, 'portBefore', 'port_before'),
        160,
    );
    if (
        schemaVersion !== 1
        || !requestId
        || !requestedFqbn
        || !portBefore
        || requestId !== fallback.requestId
        || requestedFqbn.trim() !== fallback.fqbn.trim()
        || portBefore.trim() !== fallback.port.trim()
    ) return null;

    const checksValue = pick(root, 'checks');
    const checks = Array.isArray(checksValue)
        ? checksValue.map(normalizeCheck).filter((item): item is DeviceHealthCheck => item !== null)
        : [];
    if (checks.length === 0) return null;
    const observedAtRaw = boundedString(pick(root, 'observedAt', 'observed_at'), 80);
    const observedAt = observedAtRaw && Number.isFinite(Date.parse(observedAtRaw))
        ? observedAtRaw
        : new Date().toISOString();
    const usbVid = positiveInteger(pick(usbRecord, 'vid'));
    const usbPid = positiveInteger(pick(usbRecord, 'pid'));

    return {
        schemaVersion,
        requestId,
        outcome: enumValue(
            pick(root, 'outcome'),
            ['complete', 'partial', 'failed', 'unsupported'] as const,
            checks.some(check => check.state === 'error') ? 'failed' : 'partial',
        ),
        observedAt,
        durationMs: nonNegativeNumber(pick(root, 'durationMs', 'duration_ms')) || 0,
        target: {
            requestedFqbn,
            resolvedFqbn,
            buildMcu: boundedString(pick(targetRecord, 'buildMcu', 'build_mcu'), 100),
            configuredFlashBytes: positiveInteger(pick(targetRecord, 'configuredFlashBytes', 'configured_flash_bytes')),
            partitionScheme: boundedString(pick(targetRecord, 'partitionScheme', 'partition_scheme'), 160),
            psramMode: boundedString(pick(targetRecord, 'psramMode', 'psram_mode'), 100),
        },
        device: {
            deviceId: normalizedDeviceId(pick(deviceRecord, 'deviceId', 'device_id')),
            identitySource: enumValue(
                pick(deviceRecord, 'identitySource', 'identity_source'),
                ['chip-mac', 'usb-serial', 'session-port'] as const,
                'session-port',
            ),
            chip: boundedString(pick(deviceRecord, 'chip'), 120),
            revision: boundedString(pick(deviceRecord, 'revision'), 80),
            mac: normalizedMac(pick(deviceRecord, 'mac')),
            macSuffix: normalizedMacSuffix(pick(deviceRecord, 'macSuffix', 'mac_suffix')),
            portBefore,
            portAfter: boundedString(pick(deviceRecord, 'portAfter', 'port_after'), 160),
            usb: usbVid && usbPid
                ? {
                    vid: usbVid,
                    pid: usbPid,
                    serialId: boundedString(pick(usbRecord, 'serialId', 'serial_id'), 200),
                }
                : null,
        },
        memory: {
            flashBytes: positiveInteger(pick(memoryRecord, 'flashBytes', 'flash_bytes')),
            psramBytes: positiveInteger(pick(memoryRecord, 'psramBytes', 'psram_bytes')),
        },
        checks,
    };
};

export const createFailedDeviceHealthReport = (
    target: DeviceHealthRequestIdentity,
    error: unknown,
): DeviceHealthReport => ({
    schemaVersion: 1,
    requestId: target.requestId,
    outcome: 'failed',
    observedAt: new Date().toISOString(),
    durationMs: 0,
    target: {
        requestedFqbn: target.fqbn,
        resolvedFqbn: target.fqbn,
        buildMcu: null,
        configuredFlashBytes: null,
        partitionScheme: null,
        psramMode: null,
    },
    device: {
        deviceId: null,
        identitySource: 'session-port',
        chip: null,
        revision: null,
        mac: null,
        macSuffix: null,
        portBefore: target.port,
        portAfter: null,
        usb: null,
    },
    memory: { flashBytes: null, psramBytes: null },
    checks: [{
        id: 'device-probe-failed',
        state: 'error',
        certainty: 'certain',
        title: '未能完成真机握手',
        evidence: boundedPrivacyString(error instanceof Error ? error.message : String(error || '未知错误')) || undefined,
        action: 'show_boot_help',
    }],
});

export const formatDeviceCapacity = (bytes: number | null): string => {
    if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '未明确报告';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 100 * 1024 ? 0 : 1)} KB`;
    const mib = bytes / (1024 * 1024);
    return `${mib.toFixed(Number.isInteger(mib) ? 0 : mib >= 10 ? 1 : 2)} MB`;
};

const checkRank: Record<DeviceHealthCheckState, number> = {
    error: 0,
    warning: 1,
    unknown: 2,
    pass: 3,
};

export const deriveDeviceHealthPresentation = (
    report: DeviceHealthReport,
): DeviceHealthPresentation => {
    const hasError = report.checks.some(check => check.state === 'error');
    const hasWarning = report.checks.some(check => check.state === 'warning');
    const hasUnknown = report.checks.some(check => check.state === 'unknown');
    const status: DeviceHealthDisplayStatus = report.outcome === 'unsupported'
        ? 'unsupported'
        : report.outcome === 'failed' || hasError
            ? 'problem'
            : report.outcome === 'partial' || hasWarning || hasUnknown || report.checks.length === 0
                ? 'attention'
                : 'healthy';
    const title = status === 'healthy'
        ? '真机体检通过'
        : status === 'attention'
            ? '真机体检完成，有提示'
            : status === 'unsupported'
                ? '当前目标暂不支持真机体检'
                : '真机体检未通过';
    const explanation = status === 'healthy'
        ? '开发板握手和已明确报告的硬件配置检查通过。'
        : status === 'attention'
            ? '已完成真机握手；请核对下方提示。未报告的硬件不会被推断为不存在。'
            : status === 'unsupported'
                ? 'P0 版本只检查解析到 esp32:esp32:* 的目标。'
                : '未完成可靠握手，或发现必须先修正的确定问题。';
    const chipLabel = report.device.chip
        ? `${report.device.chip}${report.device.revision ? ` · ${report.device.revision}` : ''}`
        : '未明确报告';
    const identityLabel = report.device.mac
        ? `MAC ${report.device.mac}`
        : report.device.macSuffix
            ? `MAC 尾号 ${report.device.macSuffix.toUpperCase()}`
        : report.device.identitySource === 'usb-serial'
            ? 'USB 序列身份'
            : report.device.identitySource === 'session-port'
                ? '仅本次端口会话'
                : '芯片身份已绑定';
    const targetParts = [
        report.target.buildMcu,
        report.target.configuredFlashBytes
            ? `配置 Flash ${formatDeviceCapacity(report.target.configuredFlashBytes)}`
            : null,
        report.target.partitionScheme ? `分区 ${report.target.partitionScheme}` : null,
        report.target.psramMode ? `PSRAM ${report.target.psramMode}` : null,
    ].filter(Boolean);

    return {
        status,
        title,
        explanation,
        chipLabel,
        identityLabel,
        flashLabel: formatDeviceCapacity(report.memory.flashBytes),
        psramLabel: formatDeviceCapacity(report.memory.psramBytes),
        portLabel: report.device.portAfter || report.device.portBefore,
        targetLabel: targetParts.join(' · ') || report.target.resolvedFqbn,
        orderedChecks: report.checks
            .map((check, index) => ({ check, index }))
            .sort((left, right) => checkRank[left.check.state] - checkRank[right.check.state] || left.index - right.index)
            .map(item => item.check),
    };
};
