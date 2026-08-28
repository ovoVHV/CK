import { sha256Hex } from './compile_source_map';
import { normalizeProjectIdentityPath } from './project_identity';

export type ResourceBudgetLevel = 'normal' | 'warning' | 'critical';

export interface CompileResourceMetric {
    usedBytes: number;
    totalBytes: number;
    freeBytes: number;
    percent: number;
    reportedPercent: number | null;
    level: ResourceBudgetLevel;
    /** False when the toolchain proves used bytes but exposes no trustworthy capacity. */
    capacityKnown: boolean;
}

export interface CompileResourceUsage {
    flash: CompileResourceMetric | null;
    ram: CompileResourceMetric | null;
    uploaderMemory: UploaderMemoryDetection | null;
}

export interface LinkerMapResourceGroup {
    id: string;
    label: string;
    kind: 'library' | 'generated-code' | 'core' | 'platform-library' | 'other';
    programBytes: number;
    ramBytes: number;
}

export interface LinkerMapResourceSummary {
    schemaVersion: 1;
    fqbn: string;
    classifierId: string;
    recordedAt: string;
    mapFileName: string;
    mapSha256: string;
    mapBytes: number;
    programOutputBytes: number;
    ramOutputBytes: number;
    accountedProgramBytes: number;
    accountedRamBytes: number;
    groups: LinkerMapResourceGroup[];
}

export interface CompileResourceMetricReport extends CompileResourceMetric {
    deltaBytes: number | null;
    deltaPercentagePoints: number | null;
    baselineCapacityChanged: boolean;
}

export interface CompileResourceReport {
    /** Backend-resolved identity when available; otherwise the requested effective FQBN. */
    fqbn: string;
    flash: CompileResourceMetricReport | null;
    ram: CompileResourceMetricReport | null;
    uploaderMemory: UploaderMemoryDetection | null;
    linkerMapSummary: LinkerMapResourceSummary | null;
    baselineLinkerMapSummary: LinkerMapResourceSummary | null;
    recordedAt: string;
}

export interface UploaderMemoryDetection {
    /** Physical SPI flash reported by the uploader while connected to a board. */
    flashBytes: number | null;
    /** Physical PSRAM reported by the uploader. This is not Arduino's static RAM budget. */
    psramBytes: number | null;
    source: 'uploader-log';
    /** Time when esptool actually reported this physical-board measurement. */
    measuredAt: string;
}

export interface CompileMemoryConfiguration {
    /** Explicit FQBN option only. A module name such as N16R8 is never guessed. */
    flashSizeOption: string | null;
    /** Usually a bus/mode such as qspi/opi, not a PSRAM capacity. */
    psramOption: string | null;
    partitionSchemeOption: string | null;
}

export type FlashConfigurationMatch = 'unknown' | 'match' | 'configured-larger' | 'configured-smaller';

export interface MemoryConfigurationAssessment {
    flash: FlashConfigurationMatch;
    psramDisabledButPresent: boolean;
}

export interface CompileResourceSnapshot {
    schemaVersion: 2;
    /** Exact project-path + requested-FQBN identity; never a 32-bit cache key. */
    projectIdentitySha256: string;
    /** Backend-resolved board identity used for the successful build. */
    fqbn: string;
    /** Frontend board/alias identity used to find this snapshot again. */
    requestedFqbn: string;
    capturedAt: string;
    flash: CompileResourceMetric | null;
    ram: CompileResourceMetric | null;
    uploaderMemory: UploaderMemoryDetection | null;
    linkerMapSummary: LinkerMapResourceSummary | null;
}

/**
 * Identifies the UI target that started a compile/upload. Async build results
 * may still be persisted after a configuration switch, but must not replace
 * the resource panel for a different project or board configuration.
 */
export interface CompileResourceTargetIdentity {
    projectPath: string;
    requestedFqbn: string;
    sessionId: number;
    codeFingerprint: string;
    runId: string;
}

export const isSameCompileResourceTarget = (
    started: CompileResourceTargetIdentity,
    current: CompileResourceTargetIdentity,
): boolean => (
    started.sessionId === current.sessionId
    && started.projectPath === current.projectPath
    && started.requestedFqbn === current.requestedFqbn
    && started.codeFingerprint === current.codeFingerprint
    && started.runId === current.runId
);

interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

const FLASH_PATTERN = /Sketch\s+uses\s+([\d,._\s]+)\s+bytes\s+\(([\d.]+)%\)[^\r\n]*?Maximum\s+is\s+([\d,._\s]+)\s+bytes/gi;
const RAM_PATTERN = /Global\s+variables\s+use\s+([\d,._\s]+)\s+bytes\s+\(([\d.]+)%\)[^\r\n]*?Maximum\s+is\s+([\d,._\s]+)\s+bytes/gi;
const FLASH_USED_ONLY_PATTERN = /Sketch\s+uses\s+([\d,._\s]+)\s+bytes\s+of\s+program\s+storage\s+space\./gi;
const RAM_USED_ONLY_PATTERN = /Global\s+variables\s+use\s+([\d,._\s]+)\s+bytes\s+of\s+dynamic\s+memory\./gi;
const ESP8266_RAM_USED_PATTERN = /^\.\s*Variables and constants in RAM.*?used\s+(\d+)\s*\//gim;
const ESP8266_SEGMENT_PATTERNS = [
    /^[^\r\n]*\bIROM\s+(\d+)\s+code in flash\s*$/gim,
    /^[^\r\n]*\bIRAM\s+(\d+)\s+code in IRAM\s*$/gim,
    /^[^\r\n]*\bDATA\s+(\d+)\s+initialized variables\s*$/gim,
    /^[^\r\n]*\bRODATA\s+(\d+)\s+constants\s*$/gim,
];
const LINKER_MAP_SUMMARY_PATTERN = /^\s*\[CK_LINKER_MAP_SUMMARY\]\s+(.+)\s*$/gim;
// These are deliberately whole-line esptool summaries. Do not loosen them to
// substring matches: verbose compile/config text can also mention FlashSize.
const UPLOADER_FLASH_PATTERN = /^\s*(?:Detected\s+flash\s+size|Flash\s+size)\s*:\s*([\d.]+)\s*(GiB|GB|Gbit|MiB|MB|Mbit|KiB|KB|Kbit)\s*(?:\([^\r\n]*\))?\s*$/gim;
const UPLOADER_PSRAM_PATTERN = /^\s*(?:Features\s*:[^\r\n]*?\bEmbedded\s+PSRAM|Embedded\s+PSRAM|Detected\s+PSRAM\s+size\s*:)\s*([\d.]+)\s*(GiB|GB|Gbit|MiB|MB|Mbit|KiB|KB|Kbit)\s*(?:\([^\r\n]*\))?\s*$/gim;

const parseByteCount = (value: string): number | null => {
    const normalized = value.replace(/[^\d]/g, '');
    if (!normalized) return null;
    const number = Number(normalized);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
};

const parseCapacity = (value: string, rawUnit: string): number | null => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unit = rawUnit.toLowerCase();
    const multiplier = unit === 'gib' || unit === 'gb'
        ? 1024 ** 3
        : unit === 'gbit'
            ? (1024 ** 3) / 8
        : unit === 'mib' || unit === 'mb' || unit === 'm'
                ? 1024 ** 2
                : unit === 'mbit'
                    ? (1024 ** 2) / 8
                    : unit === 'kib' || unit === 'kb'
                        ? 1024
                        : unit === 'kbit'
                            ? 1024 / 8
                            : Number.NaN;
    const bytes = Math.round(amount * multiplier);
    return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
};

const parseLastCapacity = (log: string, pattern: RegExp): number | null => {
    pattern.lastIndex = 0;
    let last: number | null = null;
    for (const match of log.matchAll(pattern)) {
        const parsed = parseCapacity(match[1], match[2]);
        if (parsed != null) last = parsed;
    }
    return last;
};

/**
 * Reads facts printed by esptool while it is connected to a physical board.
 * Callers must opt into this only for an upload log. Compile-time FQBN labels
 * and module suffixes (for example N16R8) are deliberately not treated as a
 * hardware measurement.
 */
const validMeasurementTimestamp = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const timestamp = value.trim();
    if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return null;
    return timestamp;
};

export const parseUploaderMemoryDetection = (
    rawLog: string,
    measuredAt = new Date().toISOString(),
): UploaderMemoryDetection | null => {
    const log = String(rawLog || '').replace(/\u001b\[[0-9;]*m/g, '');
    const flashBytes = parseLastCapacity(log, UPLOADER_FLASH_PATTERN);
    const psramBytes = parseLastCapacity(log, UPLOADER_PSRAM_PATTERN);
    const safeMeasuredAt = validMeasurementTimestamp(measuredAt) || new Date().toISOString();
    return flashBytes || psramBytes
        ? { flashBytes, psramBytes, source: 'uploader-log', measuredAt: safeMeasuredAt }
        : null;
};

/** Extracts only explicit memory-related FQBN options without inferring hardware. */
export const parseCompileMemoryConfiguration = (fqbn: string): CompileMemoryConfiguration => {
    const parts = String(fqbn || '').trim().split(':');
    const optionText = parts.length > 3 ? parts.slice(3).join(':') : '';
    const options = new Map<string, string>();
    for (const token of optionText.split(',')) {
        const equals = token.indexOf('=');
        if (equals <= 0) continue;
        const key = token.slice(0, equals).trim().toLowerCase();
        const value = token.slice(equals + 1).trim();
        if (key && value) options.set(key, value);
    }
    return {
        flashSizeOption: options.get('flashsize') || null,
        psramOption: options.get('psram') || null,
        partitionSchemeOption: options.get('partitionscheme') || null,
    };
};

const hasStandardFqbnShape = (fqbn: string): boolean => {
    const parts = String(fqbn || '').trim().split(':');
    return parts.length >= 3
        && parts.slice(0, 3).every(part => Boolean(part.trim()) && !part.includes('='));
};

/**
 * Selects the identity whose memory options can be interpreted reliably.
 *
 * A custom board is persisted by its user-facing alias (for example
 * `my-s3-board:FlashSize=16M`), while the backend report carries the resolved
 * standard FQBN. The alias remains useful for UI traceability, but its option
 * suffix is not in Arduino's package:architecture:board:options position and
 * therefore must not hide the resolved identity during capacity checks.
 * Standard display FQBNs are kept because they also include core defaults that
 * are intentionally absent from the compile/cache identity.
 */
export const selectCompileMemoryConfigurationFqbn = (
    displayFqbn: string,
    resolvedFqbn: string,
): string => {
    const display = String(displayFqbn || '').trim();
    const resolved = String(resolvedFqbn || '').trim();
    if (hasStandardFqbnShape(display)) return display;
    if (hasStandardFqbnShape(resolved)) return resolved;
    return display || resolved;
};

const parseExplicitFlashSize = (value: string | null): number | null => {
    if (!value) return null;
    const match = value.trim().match(/^([\d.]+)\s*(M|MB|MiB)$/i);
    return match ? parseCapacity(match[1], match[2]) : null;
};

/** Deterministic checks only; unknown values deliberately produce no warning. */
export const assessMemoryConfiguration = (
    configuration: CompileMemoryConfiguration,
    observed: UploaderMemoryDetection | null,
): MemoryConfigurationAssessment => {
    const configuredFlash = parseExplicitFlashSize(configuration.flashSizeOption);
    const observedFlash = observed?.flashBytes ?? null;
    const flash: FlashConfigurationMatch = configuredFlash == null || observedFlash == null
        ? 'unknown'
        : configuredFlash === observedFlash
            ? 'match'
            : configuredFlash > observedFlash
                ? 'configured-larger'
                : 'configured-smaller';
    return {
        flash,
        psramDisabledButPresent: configuration.psramOption?.toLowerCase() === 'disabled'
            && (observed?.psramBytes ?? 0) > 0,
    };
};

/** Last backend-reported target wins after a fallback/retry. */
export const parseResolvedCompileFqbn = (rawLog: string): string | null => {
    const log = String(rawLog || '').replace(/\u001b\[[0-9;]*m/g, '');
    const pattern = /^\s*\[(?:INFO|信息)\]\s*(?:Target Board|目标 FQBN)\s*:\s*([^\s]+)\s*$/gim;
    let last: string | null = null;
    for (const match of log.matchAll(pattern)) last = match[1].trim();
    return last;
};

const nonNegativeSafeInteger = (value: unknown): number | null => (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
);

const LINKER_MAP_GROUP_KINDS = new Set<LinkerMapResourceGroup['kind']>([
    'library', 'generated-code', 'core', 'platform-library', 'other',
]);

export const normalizeLinkerMapResourceSummary = (
    value: unknown,
    expectedFqbn = '',
): LinkerMapResourceSummary | null => {
    if (!value || typeof value !== 'object') return null;
    const summary = value as Partial<LinkerMapResourceSummary>;
    const fqbn = typeof summary.fqbn === 'string' ? summary.fqbn.trim() : '';
    const classifierId = typeof summary.classifierId === 'string' ? summary.classifierId.trim() : '';
    const recordedAt = typeof summary.recordedAt === 'string' ? summary.recordedAt.trim() : '';
    const mapFileName = typeof summary.mapFileName === 'string' ? summary.mapFileName.trim() : '';
    const mapSha256 = typeof summary.mapSha256 === 'string' ? summary.mapSha256.trim().toLowerCase() : '';
    if (summary.schemaVersion !== 1
        || !fqbn
        || !/^[a-z0-9][a-z0-9._-]{7,127}$/i.test(classifierId)
        || (expectedFqbn.trim() && fqbn !== expectedFqbn.trim())
        || !Number.isFinite(Date.parse(recordedAt))
        || !/^[-A-Za-z0-9_.]{1,240}\.map$/i.test(mapFileName)
        || !/^[0-9a-f]{64}$/.test(mapSha256)
        || !Array.isArray(summary.groups)
        || summary.groups.length > 512) return null;

    const groups: LinkerMapResourceGroup[] = [];
    const ids = new Set<string>();
    for (const raw of summary.groups) {
        if (!raw || typeof raw !== 'object') return null;
        const group = raw as Partial<LinkerMapResourceGroup>;
        const id = typeof group.id === 'string' ? group.id.trim() : '';
        const label = typeof group.label === 'string' ? group.label.trim() : '';
        const kind = typeof group.kind === 'string' && LINKER_MAP_GROUP_KINDS.has(group.kind as LinkerMapResourceGroup['kind'])
            ? group.kind as LinkerMapResourceGroup['kind']
            : null;
        const programBytes = nonNegativeSafeInteger(group.programBytes);
        const ramBytes = nonNegativeSafeInteger(group.ramBytes);
        if (!id || id.length > 160 || ids.has(id) || !label || label.length > 240
            || !kind || programBytes == null || ramBytes == null) return null;
        ids.add(id);
        groups.push({ id, label, kind, programBytes, ramBytes });
    }

    const mapBytes = nonNegativeSafeInteger(summary.mapBytes);
    const programOutputBytes = nonNegativeSafeInteger(summary.programOutputBytes);
    const ramOutputBytes = nonNegativeSafeInteger(summary.ramOutputBytes);
    const accountedProgramBytes = nonNegativeSafeInteger(summary.accountedProgramBytes);
    const accountedRamBytes = nonNegativeSafeInteger(summary.accountedRamBytes);
    if (!mapBytes || programOutputBytes == null || ramOutputBytes == null
        || accountedProgramBytes == null || accountedRamBytes == null
        || accountedProgramBytes > programOutputBytes
        || accountedRamBytes > ramOutputBytes
        || groups.reduce((sum, group) => sum + group.programBytes, 0) !== accountedProgramBytes
        || groups.reduce((sum, group) => sum + group.ramBytes, 0) !== accountedRamBytes) return null;
    return {
        schemaVersion: 1,
        fqbn,
        classifierId,
        recordedAt,
        mapFileName,
        mapSha256,
        mapBytes,
        programOutputBytes,
        ramOutputBytes,
        accountedProgramBytes,
        accountedRamBytes,
        groups,
    };
};

export const parseLinkerMapResourceSummary = (
    rawLog: string,
    expectedFqbn = '',
): LinkerMapResourceSummary | null => {
    LINKER_MAP_SUMMARY_PATTERN.lastIndex = 0;
    let last: LinkerMapResourceSummary | null = null;
    for (const match of String(rawLog || '').matchAll(LINKER_MAP_SUMMARY_PATTERN)) {
        try {
            const normalized = normalizeLinkerMapResourceSummary(JSON.parse(match[1]), expectedFqbn);
            if (normalized) last = normalized;
        } catch {
            // A malformed line is not evidence. Keep scanning for a later valid
            // upload fallback result, matching the resource-summary policy.
        }
    }
    return last;
};

export const resourceBudgetLevel = (percent: number): ResourceBudgetLevel => {
    if (percent >= 90) return 'critical';
    if (percent >= 80) return 'warning';
    return 'normal';
};

const createMetric = (
    usedBytes: number,
    totalBytes: number,
    reportedPercent: number | null,
): CompileResourceMetric | null => {
    if (!Number.isSafeInteger(usedBytes) || usedBytes < 0) return null;
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) return null;
    const percent = (usedBytes / totalBytes) * 100;
    return {
        usedBytes,
        totalBytes,
        freeBytes: Math.max(0, totalBytes - usedBytes),
        percent,
        reportedPercent: Number.isFinite(reportedPercent) ? reportedPercent : null,
        level: resourceBudgetLevel(percent),
        capacityKnown: true,
    };
};

const createUsedOnlyMetric = (usedBytes: number): CompileResourceMetric | null => {
    if (!Number.isSafeInteger(usedBytes) || usedBytes < 0) return null;
    return {
        usedBytes,
        totalBytes: 0,
        freeBytes: 0,
        percent: 0,
        reportedPercent: null,
        level: 'normal',
        capacityKnown: false,
    };
};

const parseLastUsedOnlyMetric = (log: string, pattern: RegExp): CompileResourceMetric | null => {
    pattern.lastIndex = 0;
    let lastMetric: CompileResourceMetric | null = null;
    for (const match of log.matchAll(pattern)) {
        const usedBytes = parseByteCount(match[1]);
        if (usedBytes == null) continue;
        lastMetric = createUsedOnlyMetric(usedBytes);
    }
    return lastMetric;
};

const parseEsp8266ProgramUsedMetric = (log: string): CompileResourceMetric | null => {
    let total = 0;
    for (const pattern of ESP8266_SEGMENT_PATTERNS) {
        pattern.lastIndex = 0;
        const matches = [...log.matchAll(pattern)];
        const usedBytes = matches.length > 0 ? parseByteCount(matches[matches.length - 1][1]) : null;
        if (usedBytes == null || !Number.isSafeInteger(total + usedBytes)) return null;
        total += usedBytes;
    }
    return createUsedOnlyMetric(total);
};

const parseLastMetric = (log: string, pattern: RegExp): CompileResourceMetric | null => {
    pattern.lastIndex = 0;
    let lastMetric: CompileResourceMetric | null = null;
    for (const match of log.matchAll(pattern)) {
        const usedBytes = parseByteCount(match[1]);
        const totalBytes = parseByteCount(match[3]);
        if (usedBytes == null || totalBytes == null) continue;
        const metric = createMetric(usedBytes, totalBytes, Number(match[2]));
        if (metric) lastMetric = metric;
    }
    return lastMetric;
};

/**
 * Parses Arduino CLI's stable memory summary. The final occurrence wins because
 * an upload can contain a failed/fallback build followed by the successful one.
 */
export const parseCompileResourceUsage = (
    rawLog: string,
    options: { includeUploaderMemory?: boolean; uploaderMeasuredAt?: string } = {},
): CompileResourceUsage | null => {
    const log = String(rawLog || '').replace(/\u001b\[[0-9;]*m/g, '');
    const flash = parseLastMetric(log, FLASH_PATTERN)
        || parseLastUsedOnlyMetric(log, FLASH_USED_ONLY_PATTERN)
        || parseEsp8266ProgramUsedMetric(log);
    const ram = parseLastMetric(log, RAM_PATTERN)
        || parseLastUsedOnlyMetric(log, RAM_USED_ONLY_PATTERN)
        || parseLastUsedOnlyMetric(log, ESP8266_RAM_USED_PATTERN);
    const uploaderMemory = options.includeUploaderMemory
        ? parseUploaderMemoryDetection(log, options.uploaderMeasuredAt)
        : null;
    return flash || ram || uploaderMemory ? { flash, ram, uploaderMemory } : null;
};

const metricReport = (
    current: CompileResourceMetric | null,
    previous: CompileResourceMetric | null | undefined,
): CompileResourceMetricReport | null => {
    if (!current) return null;
    // A core update, custom partitions.csv edit, or other resolved board change
    // can alter the denominator without changing the textual FQBN. Comparing
    // percentages across two different capacities would be misleading.
    const baselineCapacityChanged = Boolean(previous && (
        previous.capacityKnown !== current.capacityKnown
        || (previous.capacityKnown && current.capacityKnown && previous.totalBytes !== current.totalBytes)
    ));
    const comparablePrevious = baselineCapacityChanged ? null : previous;
    return {
        ...current,
        deltaBytes: comparablePrevious ? current.usedBytes - comparablePrevious.usedBytes : null,
        deltaPercentagePoints: comparablePrevious && current.capacityKnown && comparablePrevious.capacityKnown
            ? current.percent - comparablePrevious.percent
            : null,
        baselineCapacityChanged,
    };
};

export const createCompileResourceReport = (
    usage: CompileResourceUsage,
    previous?: CompileResourceSnapshot | null,
    recordedAt = new Date().toISOString(),
    fqbn = previous?.fqbn || '',
    linkerMapSummary: LinkerMapResourceSummary | null = null,
): CompileResourceReport => ({
    fqbn,
    flash: metricReport(usage.flash, previous?.flash),
    ram: metricReport(usage.ram, previous?.ram),
    // A compile-only result has no uploader measurement. When the caller has
    // supplied a snapshot for the same requested and backend-resolved target,
    // retain its physical-board measurement and its original measuredAt.
    uploaderMemory: usage.uploaderMemory || previous?.uploaderMemory || null,
    linkerMapSummary,
    baselineLinkerMapSummary: previous?.linkerMapSummary || null,
    recordedAt,
});

export const createCompileResourceSnapshot = (
    fqbn: string,
    usage: CompileResourceUsage,
    capturedAt = new Date().toISOString(),
    requestedFqbn = fqbn,
    linkerMapSummary: LinkerMapResourceSummary | null = null,
): CompileResourceSnapshot => ({
    schemaVersion: 2,
    projectIdentitySha256: '',
    fqbn,
    requestedFqbn,
    capturedAt,
    flash: usage.flash,
    ram: usage.ram,
    uploaderMemory: usage.uploaderMemory,
    linkerMapSummary,
});

export const compileResourceSnapshotToReport = (
    snapshot: CompileResourceSnapshot | null,
): CompileResourceReport | null => snapshot
    ? createCompileResourceReport(
        { flash: snapshot.flash, ram: snapshot.ram, uploaderMemory: snapshot.uploaderMemory },
        null,
        snapshot.capturedAt,
        snapshot.fqbn,
        snapshot.linkerMapSummary,
    )
    : null;

const snapshotStorageKey = (projectPath: string, fqbn: string): string => {
    const normalized = `${normalizeProjectIdentityPath(projectPath)}|${fqbn.trim()}`;
    return `ck.compile.resources.v2.${sha256Hex(normalized)}`;
};

const snapshotProjectIdentity = (projectPath: string, fqbn: string): string => {
    const normalized = `${normalizeProjectIdentityPath(projectPath)}|${fqbn.trim()}`;
    return sha256Hex(normalized);
};

const defaultStorage = (): StorageLike | null => {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
};

const metricFromSnapshot = (value: unknown): CompileResourceMetric | null => {
    if (!value || typeof value !== 'object') return null;
    const metric = value as Partial<CompileResourceMetric>;
    const usedBytes = typeof metric.usedBytes === 'number' ? metric.usedBytes : Number.NaN;
    const totalBytes = typeof metric.totalBytes === 'number' ? metric.totalBytes : Number.NaN;
    return metric.capacityKnown === false && totalBytes === 0
        ? createUsedOnlyMetric(usedBytes)
        : createMetric(
            usedBytes,
            totalBytes,
            typeof metric.reportedPercent === 'number' ? metric.reportedPercent : null,
        );
};

const uploaderMemoryFromSnapshot = (
    value: unknown,
    legacyCapturedAt: unknown,
): UploaderMemoryDetection | null => {
    if (!value || typeof value !== 'object') return null;
    const detection = value as Partial<UploaderMemoryDetection>;
    if (detection.source !== 'uploader-log') return null;
    const validCapacity = (capacity: unknown): number | null => (
        typeof capacity === 'number' && Number.isSafeInteger(capacity) && capacity > 0
            ? capacity
            : null
    );
    const flashBytes = validCapacity(detection.flashBytes);
    const psramBytes = validCapacity(detection.psramBytes);
    const hasMeasuredAt = Object.prototype.hasOwnProperty.call(detection, 'measuredAt');
    // v1 snapshots written before measuredAt used capturedAt as the upload
    // measurement time. Only migrate that value when measuredAt is absent;
    // a present-but-invalid timestamp is treated as corruption, not repaired.
    const measuredAt = hasMeasuredAt
        ? validMeasurementTimestamp(detection.measuredAt)
        : validMeasurementTimestamp(legacyCapturedAt);
    return (flashBytes || psramBytes) && measuredAt
        ? { flashBytes, psramBytes, source: 'uploader-log', measuredAt }
        : null;
};

export const loadCompileResourceSnapshot = (
    projectPath: string,
    fqbn: string,
    storage: StorageLike | null = defaultStorage(),
): CompileResourceSnapshot | null => {
    if (!projectPath || !fqbn || !storage) return null;
    try {
        const raw = storage.getItem(snapshotStorageKey(projectPath, fqbn));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<CompileResourceSnapshot>;
        const requestedFqbn = typeof parsed.requestedFqbn === 'string'
            ? parsed.requestedFqbn
            : parsed.fqbn;
        const expectedIdentity = snapshotProjectIdentity(projectPath, fqbn);
        if (parsed.schemaVersion !== 2
            || parsed.projectIdentitySha256 !== expectedIdentity
            || !parsed.fqbn
            || requestedFqbn !== fqbn) return null;
        // Only persisted source measurements are trusted. Derived fields may be
        // stale, missing (older v1 snapshots), or manually corrupted, so always
        // rebuild free bytes, exact percentage, and warning level on load.
        const flash = metricFromSnapshot(parsed.flash);
        const ram = metricFromSnapshot(parsed.ram);
        const uploaderMemory = uploaderMemoryFromSnapshot(parsed.uploaderMemory, parsed.capturedAt);
        const linkerMapSummary = normalizeLinkerMapResourceSummary(parsed.linkerMapSummary, parsed.fqbn);
        if (!flash && !ram && !uploaderMemory) return null;
        return {
            schemaVersion: 2,
            projectIdentitySha256: expectedIdentity,
            fqbn: parsed.fqbn,
            requestedFqbn,
            capturedAt: typeof parsed.capturedAt === 'string' ? parsed.capturedAt : '',
            flash,
            ram,
            uploaderMemory,
            linkerMapSummary,
        };
    } catch {
        return null;
    }
};

export const saveCompileResourceSnapshot = (
    projectPath: string,
    snapshot: CompileResourceSnapshot,
    storage: StorageLike | null = defaultStorage(),
): boolean => {
    if (!projectPath || !snapshot.fqbn || !storage) return false;
    try {
        storage.setItem(
            snapshotStorageKey(projectPath, snapshot.requestedFqbn || snapshot.fqbn),
            JSON.stringify({
                ...snapshot,
                schemaVersion: 2,
                projectIdentitySha256: snapshotProjectIdentity(
                    projectPath,
                    snapshot.requestedFqbn || snapshot.fqbn,
                ),
            }),
        );
        return true;
    } catch {
        return false;
    }
};

export const formatResourceBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes)) return '—';
    const absolute = Math.abs(bytes);
    if (absolute < 1024) return `${Math.round(absolute)} B`;
    if (absolute < 1024 * 1024) {
        const value = absolute / 1024;
        return `${value.toFixed(value >= 100 ? 0 : 1)} KB`;
    }
    const value = absolute / (1024 * 1024);
    return `${value.toFixed(value >= 10 ? 1 : 2)} MB`;
};

export const formatResourceDelta = (
    deltaBytes: number | null,
    deltaPercentagePoints: number | null,
    baselineCapacityChanged = false,
): string => {
    if (baselineCapacityChanged) return '容量配置已变化，已重建基线';
    if (deltaBytes == null || deltaPercentagePoints == null) return '暂无对比基线';
    if (deltaBytes === 0 && Math.abs(deltaPercentagePoints) < 0.05) return '较上次无变化';
    const sign = deltaBytes > 0 ? '+' : deltaBytes < 0 ? '−' : '';
    const percentSign = deltaPercentagePoints > 0 ? '+' : deltaPercentagePoints < 0 ? '−' : '';
    return `较上次 ${sign}${formatResourceBytes(deltaBytes)}（${percentSign}${Math.abs(deltaPercentagePoints).toFixed(1)}%）`;
};
