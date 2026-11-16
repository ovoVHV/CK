import type { CompileEnvironmentSnapshot } from './compile_doctor';
import type { CompileResourceMetric, CompileResourceSnapshot } from './compile_resources';
import type { DeviceHealthReport } from './device_health';
import type { ProjectCheckpoint } from './project_checkpoints';

/**
 * Pure domain contract for CK's "last known good" feature.
 *
 * This module intentionally has no Tauri, filesystem, Blockly, upload, or UI
 * dependency.  In particular it never writes firmware.  Firmware and complete
 * restore plans always route back through CK's existing gated upload flow.
 */

export const LAST_KNOWN_GOOD_SCHEMA_ID = 'ck.last-known-good';
export const LAST_KNOWN_GOOD_SCHEMA_VERSION = 1 as const;
export const LAST_KNOWN_GOOD_UPLOAD_GATE = 'existing-ck-gated-upload-v1' as const;

export type RestoreKind = 'project' | 'firmware' | 'complete';
export type EvidenceState = 'reported' | 'not-reported';
export type ValidationSeverity = 'error' | 'warning';

export interface ReportedEvidence<T> {
    state: 'reported';
    value: T;
}

export interface NotReportedEvidence {
    state: 'not-reported';
}

export type ExplicitEvidence<T> = ReportedEvidence<T> | NotReportedEvidence;

export interface LastKnownGoodContent {
    format: 'blockly-json' | 'arduino-cpp';
    content: string;
    sha256: string;
}

export interface LastKnownGoodProject {
    path: string;
    name: string;
    workspace: LastKnownGoodContent & { format: 'blockly-json' };
    generatedSource: LastKnownGoodContent & { format: 'arduino-cpp' };
    blockCount: number;
}

export type LastKnownGoodCkLock = {
    state: 'captured';
    schemaVersion: number;
    content: string;
    sha256: string;
} | {
    state: 'not-applicable';
    reason: string;
};

export interface LastKnownGoodCoreIdentity {
    package: string;
    version: string;
}

export interface LastKnownGoodOptimizationIdentity {
    /** CK compile profile, for example quick-fast or release. */
    profile: string;
    /** Effective optimization token, for example -O1 or -Os. */
    level: string;
    /** Effective compiler flags from the verified compilation database. */
    compilerFlags: string[];
    debugLevel: string;
    lto: boolean;
    /** Compiler/evidence contract that produced this build. */
    contract: string;
}

export type LastKnownGoodPartition = {
    state: 'captured';
    relativePath: string;
    sha256: string;
} | {
    state: 'not-applicable';
    reason: string;
};

export interface LastKnownGoodFirmwareSegment {
    role: string;
    relativePath: string;
    /** Canonical lowercase hexadecimal address, or null for addressless formats such as AVR HEX. */
    address: string | null;
    sizeBytes: number;
    sha256: string;
}

export interface LastKnownGoodFirmwareSet {
    /** Must be true: a partial artifact list can never be used for restore. */
    complete: true;
    manifestSchemaVersion: number;
    segments: LastKnownGoodFirmwareSegment[];
}

export interface LastKnownGoodBuildIdentity {
    core: LastKnownGoodCoreIdentity;
    cliVersion: string;
    toolchainKey: string;
    /** Canonical package:architecture:board[:all menu options] identity. */
    canonicalFqbn: string;
    /** Explicit proof that all menu options were resolved, including an intentionally empty set. */
    fqbnOptionsComplete: true;
    optimization: LastKnownGoodOptimizationIdentity;
    partition: LastKnownGoodPartition;
    buildSignature: string;
    firmware: LastKnownGoodFirmwareSet;
}

export interface LastKnownGoodHardwareEvidence {
    observedAt: string;
    source: 'device-health' | 'uploader-log';
    /** Stable privacy-bounded device hash when available; never a full MAC. */
    deviceIdSha256: string | null;
    chip: ExplicitEvidence<string>;
    flashBytes: ExplicitEvidence<number>;
    /** not-reported is different from a reported zero/absent device. */
    psramBytes: ExplicitEvidence<number>;
}

export interface LastKnownGoodResourceMetric {
    state: EvidenceState;
    usedBytes: number | null;
    totalBytes: number | null;
}

export interface LastKnownGoodResources {
    flash: LastKnownGoodResourceMetric;
    ram: LastKnownGoodResourceMetric;
    warningCount: number;
    measuredAt: string;
}

export interface LastKnownGoodQualification {
    uploadedAt: string;
    usableConfirmedAt: string;
    evidence: 'user-confirmed' | 'runtime-verified';
}

export interface LastKnownGoodSnapshot {
    schema: typeof LAST_KNOWN_GOOD_SCHEMA_ID;
    schemaVersion: typeof LAST_KNOWN_GOOD_SCHEMA_VERSION;
    recordId: string;
    createdAt: string;
    project: LastKnownGoodProject;
    ckLock: LastKnownGoodCkLock;
    build: LastKnownGoodBuildIdentity;
    hardware: LastKnownGoodHardwareEvidence;
    resources: LastKnownGoodResources;
    qualification: LastKnownGoodQualification;
}

export interface LastKnownGoodValidationIssue {
    severity: ValidationSeverity;
    code: string;
    path: string;
    message: string;
}

export interface LastKnownGoodValidationResult {
    valid: boolean;
    snapshot: LastKnownGoodSnapshot | null;
    migratedFromVersion: number | null;
    issues: LastKnownGoodValidationIssue[];
}

/** Frontend mirror of the evidence already emitted by the upload artifact manifest. */
export interface LastKnownGoodUploadManifestInput {
    schemaVersion: number;
    canonicalFqbn: string;
    buildSignature: string;
    partitionDefinition: {
        relativePath: string;
        sha256: string;
    } | null;
    artifacts: Array<{
        role: string;
        relativePath: string;
        address: string | number | null;
        sizeBytes: number;
        sha256: string;
    }>;
}

export interface LastKnownGoodCaptureInput {
    recordId: string;
    createdAt?: string;
    checkpoint: Pick<ProjectCheckpoint,
        'projectPath' | 'projectName' | 'workspaceJson' | 'code' | 'blockCount'>;
    workspaceSha256: string;
    sourceSha256: string;
    ckLock: LastKnownGoodCkLock;
    compileEnvironment: CompileEnvironmentSnapshot;
    optimization: LastKnownGoodOptimizationIdentity;
    uploadManifest: LastKnownGoodUploadManifestInput;
    deviceHealth: DeviceHealthReport;
    resources: CompileResourceSnapshot;
    warningCount: number;
    uploadedAt: string;
    usableConfirmedAt: string;
    qualificationEvidence: LastKnownGoodQualification['evidence'];
}

export interface LastKnownGoodComparableState {
    project?: {
        path: string;
        name: string;
        workspaceSha256: string;
        sourceSha256: string;
        blockCount: number;
    };
    ckLock?: LastKnownGoodCkLock;
    build?: Omit<LastKnownGoodBuildIdentity, 'firmware'>;
    artifacts?: LastKnownGoodFirmwareSet;
    hardware?: LastKnownGoodHardwareEvidence;
    resources?: LastKnownGoodResources;
}

export type LastKnownGoodDiffCategory =
    | 'project'
    | 'ck-lock'
    | 'build'
    | 'firmware'
    | 'hardware'
    | 'resources';

export interface LastKnownGoodDiffItem {
    category: LastKnownGoodDiffCategory;
    field: string;
    severity: 'info' | 'warning' | 'blocker';
    summary: string;
    before: string;
    after: string;
}

export interface LastKnownGoodDiffReport {
    identical: boolean;
    summary: string;
    changes: LastKnownGoodDiffItem[];
    lines: string[];
}

export interface LastKnownGoodRestoreContext {
    current: LastKnownGoodComparableState;
    /** Freshly inspected candidate files, not merely the archived JSON list. */
    stagedArtifacts: LastKnownGoodFirmwareSet | null;
    /** Whether CK's normal gated upload entry point is available. */
    existingUploadGateAvailable: boolean;
    /** Whether the current project can be protected before it is replaced. */
    canCreateSafetyCheckpoint: boolean;
}

export interface LastKnownGoodRestoreStep {
    id: string;
    title: string;
    description: string;
    required: boolean;
    blocked: boolean;
}

export interface LastKnownGoodRestorePlan {
    kind: RestoreKind;
    canProceed: boolean;
    blockers: string[];
    warnings: string[];
    steps: LastKnownGoodRestoreStep[];
    diff: LastKnownGoodDiffReport;
    uploadPolicy: {
        required: boolean;
        gate: typeof LAST_KNOWN_GOOD_UPLOAD_GATE;
        requireArtifactManifestValidation: boolean;
        requireCanonicalFqbnMatch: boolean;
        requireBuildSignatureMatch: boolean;
        allowDirectArtifactWrite: false;
    };
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
        if (Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined) {
            return record[key];
        }
    }
    return undefined;
};

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const isIsoTime = (value: unknown): value is string => typeof value === 'string'
    && value.trim().length > 0
    && Number.isFinite(Date.parse(value));
const isNonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

const issue = (
    issues: LastKnownGoodValidationIssue[],
    severity: ValidationSeverity,
    code: string,
    path: string,
    message: string,
) => issues.push({ severity, code, path, message });

const requireText = (
    record: UnknownRecord | null,
    key: string,
    path: string,
    issues: LastKnownGoodValidationIssue[],
    maxLength = 2_000_000,
): string => {
    const value = text(record?.[key]);
    if (!value || value.length > maxLength) {
        issue(issues, 'error', 'invalid-text', `${path}.${key}`, `${path}.${key} 必须是非空且长度受限的字符串`);
    }
    return value;
};

const safeRelativePath = (value: unknown): string | null => {
    const normalized = text(value).replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) return null;
    const parts = normalized.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) return null;
    return normalized;
};

const canonicalAddress = (value: unknown): string | null => {
    if (value == null || value === '') return null;
    if (typeof value === 'number') {
        return isNonNegativeInteger(value) ? `0x${value.toString(16)}` : null;
    }
    const raw = text(value).toLowerCase();
    if (!/^(?:0x)?[0-9a-f]+$/.test(raw)) return null;
    const parsed = Number.parseInt(raw.replace(/^0x/, ''), 16);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? `0x${parsed.toString(16)}` : null;
};

const isCanonicalFqbn = (value: unknown): value is string => {
    if (typeof value !== 'string' || value.trim() !== value || /\s/.test(value)) return false;
    const parts = value.split(':');
    if (parts.length < 3 || parts.slice(0, 3).some(part => !part || part.includes('='))) return false;
    if (parts.length === 3) return true;
    const optionText = parts.slice(3).join(':');
    if (!optionText) return false;
    const keys = new Set<string>();
    return optionText.split(',').every(token => {
        const match = token.match(/^([A-Za-z0-9][A-Za-z0-9_.-]{0,127})=([A-Za-z0-9][A-Za-z0-9_.-]{0,255})$/);
        if (!match) return false;
        const key = match[1].toLowerCase();
        if (keys.has(key)) return false;
        keys.add(key);
        return true;
    });
};

const parseJsonObject = (value: string): boolean => {
    try {
        return asRecord(JSON.parse(value)) !== null;
    } catch {
        return false;
    }
};

const evidenceValue = <T>(
    raw: unknown,
    path: string,
    issues: LastKnownGoodValidationIssue[],
    validator: (value: unknown) => value is T,
): ExplicitEvidence<T> | null => {
    const record = asRecord(raw);
    if (!record || (record.state !== 'reported' && record.state !== 'not-reported')) {
        issue(issues, 'error', 'invalid-evidence-state', path, `${path} 必须明确标记 reported 或 not-reported`);
        return null;
    }
    if (record.state === 'not-reported') return { state: 'not-reported' };
    if (!validator(record.value)) {
        issue(issues, 'error', 'invalid-evidence-value', `${path}.value`, `${path} 的明确报告值无效`);
        return null;
    }
    return { state: 'reported', value: record.value as T };
};

const validateContent = (
    raw: unknown,
    path: string,
    expectedFormat: LastKnownGoodContent['format'],
    issues: LastKnownGoodValidationIssue[],
) => {
    const record = asRecord(raw);
    if (!record) {
        issue(issues, 'error', 'missing-content', path, `${path} 缺失`);
        return;
    }
    if (record.format !== expectedFormat) {
        issue(issues, 'error', 'invalid-content-format', `${path}.format`, `${path} 的格式必须为 ${expectedFormat}`);
    }
    const content = typeof record.content === 'string' ? record.content : '';
    if (!content) issue(issues, 'error', 'missing-content-data', `${path}.content`, `${path} 没有可恢复内容`);
    if (!isSha256(record.sha256)) issue(issues, 'error', 'invalid-sha256', `${path}.sha256`, `${path} 缺少有效 SHA-256`);
};

const validateCkLock = (
    raw: unknown,
    path: string,
    issues: LastKnownGoodValidationIssue[],
) => {
    const record = asRecord(raw);
    if (!record || (record.state !== 'captured' && record.state !== 'not-applicable')) {
        issue(issues, 'error', 'invalid-ck-lock-state', path, 'ck.lock 必须明确标记 captured 或 not-applicable');
        return;
    }
    if (record.state === 'not-applicable') {
        if (!text(record.reason)) issue(issues, 'error', 'missing-not-applicable-reason', `${path}.reason`, 'ck.lock 不适用时必须说明原因');
        return;
    }
    if (!isPositiveInteger(record.schemaVersion)) issue(issues, 'error', 'invalid-schema-version', `${path}.schemaVersion`, 'ck.lock schemaVersion 无效');
    const content = typeof record.content === 'string' ? record.content : '';
    if (!content || !parseJsonObject(content)) issue(issues, 'error', 'invalid-ck-lock-json', `${path}.content`, 'ck.lock 内容必须是有效 JSON 对象');
    if (!isSha256(record.sha256)) issue(issues, 'error', 'invalid-sha256', `${path}.sha256`, 'ck.lock 缺少有效 SHA-256');
};

const validatePartition = (
    raw: unknown,
    fqbn: string,
    path: string,
    issues: LastKnownGoodValidationIssue[],
) => {
    const record = asRecord(raw);
    if (!record || (record.state !== 'captured' && record.state !== 'not-applicable')) {
        issue(issues, 'error', 'invalid-partition-state', path, '分区证据必须明确标记 captured 或 not-applicable');
        return;
    }
    if (record.state === 'captured') {
        if (!safeRelativePath(record.relativePath)) issue(issues, 'error', 'unsafe-relative-path', `${path}.relativePath`, '分区定义必须使用安全相对路径');
        if (!isSha256(record.sha256)) issue(issues, 'error', 'invalid-sha256', `${path}.sha256`, '分区定义缺少有效 SHA-256');
        return;
    }
    if (!text(record.reason)) issue(issues, 'error', 'missing-not-applicable-reason', `${path}.reason`, '分区不适用时必须说明原因');
    if (/^esp32:/i.test(fqbn)) {
        issue(issues, 'error', 'esp32-partition-required', path, 'ESP32 固件恢复必须保存所选分区定义及 SHA-256');
    }
};

const validateFirmware = (
    raw: unknown,
    fqbn: string,
    path: string,
    issues: LastKnownGoodValidationIssue[],
) => {
    const record = asRecord(raw);
    if (!record) {
        issue(issues, 'error', 'missing-firmware-set', path, '缺少完整固件段清单');
        return;
    }
    if (record.complete !== true) issue(issues, 'error', 'partial-firmware-set', `${path}.complete`, '不完整的固件段清单禁止用于恢复');
    if (!isPositiveInteger(record.manifestSchemaVersion)) issue(issues, 'error', 'invalid-schema-version', `${path}.manifestSchemaVersion`, '上传产物清单版本无效');
    if (!Array.isArray(record.segments) || record.segments.length === 0) {
        issue(issues, 'error', 'missing-firmware-segments', `${path}.segments`, '固件恢复至少需要一个烧录段');
        return;
    }
    const addresses = new Set<string>();
    const paths = new Set<string>();
    record.segments.forEach((rawSegment, index) => {
        const segmentPath = `${path}.segments[${index}]`;
        const segment = asRecord(rawSegment);
        if (!segment) {
            issue(issues, 'error', 'invalid-firmware-segment', segmentPath, '烧录段必须是对象');
            return;
        }
        if (!text(segment.role)) issue(issues, 'error', 'missing-segment-role', `${segmentPath}.role`, '烧录段缺少角色');
        const relativePath = safeRelativePath(segment.relativePath);
        if (!relativePath) issue(issues, 'error', 'unsafe-relative-path', `${segmentPath}.relativePath`, '烧录段必须使用安全相对路径');
        else if (paths.has(relativePath.toLowerCase())) issue(issues, 'error', 'duplicate-segment-path', `${segmentPath}.relativePath`, '烧录段路径重复');
        else paths.add(relativePath.toLowerCase());
        const address = canonicalAddress(segment.address);
        if (/^esp32:/i.test(fqbn) && address == null) {
            issue(issues, 'error', 'segment-address-required', `${segmentPath}.address`, 'ESP32 的每个烧录段都必须记录地址');
        }
        if (address != null) {
            if (addresses.has(address)) issue(issues, 'error', 'duplicate-segment-address', `${segmentPath}.address`, `烧录地址 ${address} 重复`);
            addresses.add(address);
        } else if (segment.address != null) {
            issue(issues, 'error', 'invalid-segment-address', `${segmentPath}.address`, '烧录地址格式无效');
        }
        if (!isPositiveInteger(segment.sizeBytes)) issue(issues, 'error', 'invalid-segment-size', `${segmentPath}.sizeBytes`, '烧录段大小必须大于 0');
        if (!isSha256(segment.sha256)) issue(issues, 'error', 'invalid-sha256', `${segmentPath}.sha256`, '烧录段缺少有效 SHA-256');
    });
};

const validateResourceMetric = (
    raw: unknown,
    path: string,
    issues: LastKnownGoodValidationIssue[],
) => {
    const metric = asRecord(raw);
    if (!metric || (metric.state !== 'reported' && metric.state !== 'not-reported')) {
        issue(issues, 'error', 'invalid-resource-state', path, `${path} 必须明确标记 reported 或 not-reported`);
        return;
    }
    if (metric.state === 'not-reported') {
        if (metric.usedBytes != null || metric.totalBytes != null) {
            issue(issues, 'error', 'invented-resource-value', path, '未报告的资源统计不能携带猜测数值');
        }
        return;
    }
    const usedValid = isNonNegativeInteger(metric.usedBytes);
    const totalKnown = metric.totalBytes != null;
    const totalValid = !totalKnown || isPositiveInteger(metric.totalBytes);
    const fitsKnownCapacity = !totalKnown || Number(metric.usedBytes) <= Number(metric.totalBytes);
    if (!usedValid || !totalValid || !fitsKnownCapacity) {
        issue(issues, 'error', 'invalid-resource-metric', path, `${path} 的已用量/上限无效`);
    }
};

const validateV1 = (root: UnknownRecord, migratedFromVersion: number | null): LastKnownGoodValidationResult => {
    const issues: LastKnownGoodValidationIssue[] = [];
    if (root.schema !== LAST_KNOWN_GOOD_SCHEMA_ID) issue(issues, 'error', 'invalid-schema-id', 'schema', `schema 必须为 ${LAST_KNOWN_GOOD_SCHEMA_ID}`);
    if (root.schemaVersion !== LAST_KNOWN_GOOD_SCHEMA_VERSION) issue(issues, 'error', 'unsupported-schema-version', 'schemaVersion', `仅支持版本 ${LAST_KNOWN_GOOD_SCHEMA_VERSION}`);
    requireText(root, 'recordId', '$', issues, 200);
    if (!isIsoTime(root.createdAt)) issue(issues, 'error', 'invalid-time', 'createdAt', 'createdAt 必须是有效时间');

    const project = asRecord(root.project);
    if (!project) issue(issues, 'error', 'missing-project', 'project', '缺少工程快照');
    else {
        requireText(project, 'path', 'project', issues, 4_096);
        requireText(project, 'name', 'project', issues, 512);
        validateContent(project.workspace, 'project.workspace', 'blockly-json', issues);
        validateContent(project.generatedSource, 'project.generatedSource', 'arduino-cpp', issues);
        if (!isNonNegativeInteger(project.blockCount)) issue(issues, 'error', 'invalid-block-count', 'project.blockCount', '积木数量必须是非负整数');
    }
    validateCkLock(root.ckLock, 'ckLock', issues);

    const build = asRecord(root.build);
    let fqbn = '';
    if (!build) issue(issues, 'error', 'missing-build', 'build', '缺少构建身份');
    else {
        const core = asRecord(build.core);
        if (!core) issue(issues, 'error', 'missing-core', 'build.core', '缺少实际 Core 身份');
        else {
            requireText(core, 'package', 'build.core', issues, 200);
            requireText(core, 'version', 'build.core', issues, 128);
        }
        requireText(build, 'cliVersion', 'build', issues, 256);
        requireText(build, 'toolchainKey', 'build', issues, 512);
        fqbn = text(build.canonicalFqbn);
        if (!isCanonicalFqbn(fqbn)) issue(issues, 'error', 'invalid-canonical-fqbn', 'build.canonicalFqbn', '必须保存有效的完整 canonical FQBN');
        if (build.fqbnOptionsComplete !== true) issue(issues, 'error', 'incomplete-fqbn-options', 'build.fqbnOptionsComplete', '必须明确确认 FQBN 菜单选项集合完整');
        const optimization = asRecord(build.optimization);
        if (!optimization) issue(issues, 'error', 'missing-optimization', 'build.optimization', '缺少实际优化参数');
        else {
            requireText(optimization, 'profile', 'build.optimization', issues, 128);
            const level = requireText(optimization, 'level', 'build.optimization', issues, 32);
            if (!/^-O(?:0|1|2|3|s|g|fast)$/i.test(level)) issue(issues, 'error', 'invalid-optimization-level', 'build.optimization.level', '优化级别必须是明确的 -O* 标记');
            if (!Array.isArray(optimization.compilerFlags) || optimization.compilerFlags.length === 0 || optimization.compilerFlags.some(flag => !text(flag))) {
                issue(issues, 'error', 'missing-compiler-flags', 'build.optimization.compilerFlags', '必须保存经编译数据库验证的实际编译参数');
            }
            requireText(optimization, 'debugLevel', 'build.optimization', issues, 64);
            if (typeof optimization.lto !== 'boolean') issue(issues, 'error', 'invalid-lto-state', 'build.optimization.lto', '必须明确记录 LTO 是否启用');
            requireText(optimization, 'contract', 'build.optimization', issues, 512);
        }
        validatePartition(build.partition, fqbn, 'build.partition', issues);
        requireText(build, 'buildSignature', 'build', issues, 512);
        validateFirmware(build.firmware, fqbn, 'build.firmware', issues);
    }

    const hardware = asRecord(root.hardware);
    if (!hardware) issue(issues, 'error', 'missing-hardware', 'hardware', '缺少真机证据');
    else {
        if (!isIsoTime(hardware.observedAt)) issue(issues, 'error', 'invalid-time', 'hardware.observedAt', '真机证据时间无效');
        if (hardware.source !== 'device-health' && hardware.source !== 'uploader-log') issue(issues, 'error', 'invalid-hardware-source', 'hardware.source', '真机证据来源无效');
        if (hardware.deviceIdSha256 != null && !isSha256(hardware.deviceIdSha256)) issue(issues, 'error', 'invalid-device-id', 'hardware.deviceIdSha256', '设备身份只能保存隐私安全的 SHA-256');
        const chip = evidenceValue(hardware.chip, 'hardware.chip', issues, (value): value is string => Boolean(text(value)));
        const flash = evidenceValue(hardware.flashBytes, 'hardware.flashBytes', issues, isPositiveInteger);
        evidenceValue(hardware.psramBytes, 'hardware.psramBytes', issues, isPositiveInteger);
        if (chip?.state === 'not-reported') issue(issues, 'warning', 'chip-not-reported', 'hardware.chip', '未明确报告芯片型号，固件恢复计划会阻止继续');
        if (flash?.state === 'not-reported') issue(issues, 'warning', 'flash-not-reported', 'hardware.flashBytes', '未明确报告实体 Flash，固件恢复计划会阻止继续');
    }

    const resources = asRecord(root.resources);
    if (!resources) issue(issues, 'error', 'missing-resources', 'resources', '缺少资源与警告统计');
    else {
        validateResourceMetric(resources.flash, 'resources.flash', issues);
        validateResourceMetric(resources.ram, 'resources.ram', issues);
        if (!isNonNegativeInteger(resources.warningCount)) issue(issues, 'error', 'invalid-warning-count', 'resources.warningCount', 'warningCount 必须是非负整数');
        if (!isIsoTime(resources.measuredAt)) issue(issues, 'error', 'invalid-time', 'resources.measuredAt', '资源统计时间无效');
    }

    const qualification = asRecord(root.qualification);
    if (!qualification) issue(issues, 'error', 'missing-qualification', 'qualification', '缺少可用性确认');
    else {
        if (!isIsoTime(qualification.uploadedAt)) issue(issues, 'error', 'invalid-time', 'qualification.uploadedAt', '上传成功时间无效');
        if (!isIsoTime(qualification.usableConfirmedAt)) issue(issues, 'error', 'invalid-time', 'qualification.usableConfirmedAt', '可用确认时间无效');
        if (qualification.evidence !== 'user-confirmed' && qualification.evidence !== 'runtime-verified') issue(issues, 'error', 'invalid-qualification-evidence', 'qualification.evidence', '必须由用户确认或受控运行测试确认可用');
        if (isIsoTime(qualification.uploadedAt) && isIsoTime(qualification.usableConfirmedAt)
            && Date.parse(qualification.usableConfirmedAt) < Date.parse(qualification.uploadedAt)) {
            issue(issues, 'error', 'qualification-before-upload', 'qualification.usableConfirmedAt', '可用确认不能早于上传成功');
        }
    }

    const valid = !issues.some(item => item.severity === 'error');
    return {
        valid,
        snapshot: valid ? JSON.parse(JSON.stringify(root)) as LastKnownGoodSnapshot : null,
        migratedFromVersion,
        issues,
    };
};

const legacyMetric = (value: unknown): LastKnownGoodResourceMetric => {
    const record = asRecord(value);
    const usedBytes = Number(pick(record, 'usedBytes', 'used_bytes'));
    const totalBytes = Number(pick(record, 'totalBytes', 'total_bytes'));
    return isNonNegativeInteger(usedBytes) && isPositiveInteger(totalBytes)
        ? { state: 'reported', usedBytes, totalBytes }
        : { state: 'not-reported', usedBytes: null, totalBytes: null };
};

const legacyHardwareEvidence = (raw: unknown, fallbackTime: string): LastKnownGoodHardwareEvidence => {
    const hardware = asRecord(raw);
    const chip = text(pick(hardware, 'chip', 'chip_model'));
    const flashBytes = Number(pick(hardware, 'flashBytes', 'flash_bytes'));
    const psramPresent = hardware ? Object.prototype.hasOwnProperty.call(hardware, 'psramBytes')
        || Object.prototype.hasOwnProperty.call(hardware, 'psram_bytes') : false;
    const psramBytes = Number(pick(hardware, 'psramBytes', 'psram_bytes'));
    const observedAt = text(pick(hardware, 'observedAt', 'observed_at')) || fallbackTime;
    return {
        observedAt,
        source: 'device-health',
        deviceIdSha256: isSha256(pick(hardware, 'deviceIdSha256', 'device_id_sha256'))
            ? String(pick(hardware, 'deviceIdSha256', 'device_id_sha256')).toLowerCase()
            : null,
        chip: chip ? { state: 'reported', value: chip } : { state: 'not-reported' },
        flashBytes: isPositiveInteger(flashBytes) ? { state: 'reported', value: flashBytes } : { state: 'not-reported' },
        psramBytes: psramPresent && isPositiveInteger(psramBytes)
            ? { state: 'reported', value: psramBytes }
            : { state: 'not-reported' },
    };
};

const migrateLegacyV0 = (legacy: UnknownRecord): UnknownRecord => {
    const createdAt = text(pick(legacy, 'createdAt', 'created_at')) || new Date(0).toISOString();
    const ckLockJson = text(pick(legacy, 'ckLockJson', 'ck_lock_json'));
    const optimizationRaw = asRecord(pick(legacy, 'optimization'));
    const artifactsRaw = pick(legacy, 'artifacts', 'segments');
    const artifacts = Array.isArray(artifactsRaw) ? artifactsRaw.map((raw, index) => {
        const item = asRecord(raw);
        return {
            role: text(pick(item, 'role')) || `segment-${index + 1}`,
            relativePath: text(pick(item, 'relativePath', 'relative_path', 'path')),
            address: canonicalAddress(pick(item, 'address')),
            sizeBytes: Number(pick(item, 'sizeBytes', 'size_bytes')),
            sha256: text(pick(item, 'sha256')),
        };
    }) : [];
    const partitionPath = text(pick(legacy, 'partitionPath', 'partition_path'));
    const partitionSha = text(pick(legacy, 'partitionSha256', 'partition_sha256'));
    const resources = asRecord(pick(legacy, 'resources'));
    const compilerFlags = pick(optimizationRaw, 'compilerFlags', 'compiler_flags');
    return {
        schema: LAST_KNOWN_GOOD_SCHEMA_ID,
        schemaVersion: LAST_KNOWN_GOOD_SCHEMA_VERSION,
        recordId: text(pick(legacy, 'recordId', 'record_id', 'id')),
        createdAt,
        project: {
            path: text(pick(legacy, 'projectPath', 'project_path')),
            name: text(pick(legacy, 'projectName', 'project_name')),
            workspace: {
                format: 'blockly-json',
                content: typeof pick(legacy, 'workspaceJson', 'workspace_json') === 'string' ? pick(legacy, 'workspaceJson', 'workspace_json') : '',
                sha256: text(pick(legacy, 'workspaceSha256', 'workspace_sha256')),
            },
            generatedSource: {
                format: 'arduino-cpp',
                content: typeof pick(legacy, 'code', 'generatedSource', 'generated_source') === 'string' ? pick(legacy, 'code', 'generatedSource', 'generated_source') : '',
                sha256: text(pick(legacy, 'sourceSha256', 'source_sha256')),
            },
            blockCount: Number(pick(legacy, 'blockCount', 'block_count')),
        },
        ckLock: ckLockJson
            ? {
                state: 'captured',
                schemaVersion: Number(pick(legacy, 'ckLockSchemaVersion', 'ck_lock_schema_version')),
                content: ckLockJson,
                sha256: text(pick(legacy, 'ckLockSha256', 'ck_lock_sha256')),
            }
            : { state: 'not-applicable', reason: '旧记录明确未包含 ck.lock' },
        build: {
            core: {
                package: text(pick(legacy, 'coreId', 'core_id')),
                version: text(pick(legacy, 'coreVersion', 'core_version')),
            },
            cliVersion: text(pick(legacy, 'cliVersion', 'cli_version')),
            toolchainKey: text(pick(legacy, 'toolchainKey', 'toolchain_key')),
            canonicalFqbn: text(pick(legacy, 'canonicalFqbn', 'canonical_fqbn', 'fqbn')),
            fqbnOptionsComplete: pick(legacy, 'fqbnOptionsComplete', 'fqbn_options_complete') === true,
            optimization: {
                profile: text(pick(optimizationRaw, 'profile')),
                level: text(pick(optimizationRaw, 'level')),
                compilerFlags: Array.isArray(compilerFlags) ? compilerFlags.map(String) : [],
                debugLevel: text(pick(optimizationRaw, 'debugLevel', 'debug_level')),
                lto: pick(optimizationRaw, 'lto') === true,
                contract: text(pick(optimizationRaw, 'contract')),
            },
            partition: partitionPath && partitionSha
                ? { state: 'captured', relativePath: partitionPath, sha256: partitionSha }
                : { state: 'not-applicable', reason: '旧记录明确没有分区定义' },
            buildSignature: text(pick(legacy, 'buildSignature', 'build_signature')),
            firmware: {
                complete: pick(legacy, 'artifactSetComplete', 'artifact_set_complete') === true,
                manifestSchemaVersion: Number(pick(legacy, 'manifestSchemaVersion', 'manifest_schema_version')),
                segments: artifacts,
            },
        },
        hardware: legacyHardwareEvidence(pick(legacy, 'hardware'), createdAt),
        resources: {
            flash: legacyMetric(pick(resources, 'flash')),
            ram: legacyMetric(pick(resources, 'ram')),
            warningCount: Number(pick(resources, 'warningCount', 'warning_count')),
            measuredAt: text(pick(resources, 'measuredAt', 'measured_at')) || createdAt,
        },
        qualification: {
            uploadedAt: text(pick(legacy, 'uploadedAt', 'uploaded_at')),
            usableConfirmedAt: text(pick(legacy, 'usableConfirmedAt', 'usable_confirmed_at', 'confirmedAt', 'confirmed_at')),
            evidence: pick(legacy, 'qualificationEvidence', 'qualification_evidence') === 'runtime-verified'
                ? 'runtime-verified'
                : 'user-confirmed',
        },
    };
};

const parseUnknown = (value: unknown): UnknownRecord | null => {
    if (typeof value !== 'string') return asRecord(value);
    try {
        return asRecord(JSON.parse(value));
    } catch {
        return null;
    }
};

/** Parse, migrate v0, and validate without mutating the input. */
export const validateLastKnownGoodSnapshot = (value: unknown): LastKnownGoodValidationResult => {
    const parsed = parseUnknown(value);
    if (!parsed) {
        return {
            valid: false,
            snapshot: null,
            migratedFromVersion: null,
            issues: [{ severity: 'error', code: 'invalid-json', path: '$', message: '上一个可用版本不是有效 JSON 对象' }],
        };
    }
    const rawVersion = Number(pick(parsed, 'schemaVersion', 'schema_version', 'version'));
    if (rawVersion === LAST_KNOWN_GOOD_SCHEMA_VERSION && parsed.schema === LAST_KNOWN_GOOD_SCHEMA_ID) {
        return validateV1(parsed, null);
    }
    if (rawVersion === 0 || (!Number.isFinite(rawVersion) && (
        Object.prototype.hasOwnProperty.call(parsed, 'workspaceJson')
        || Object.prototype.hasOwnProperty.call(parsed, 'workspace_json')
    ))) {
        return validateV1(migrateLegacyV0(parsed), 0);
    }
    return {
        valid: false,
        snapshot: null,
        migratedFromVersion: Number.isFinite(rawVersion) ? rawVersion : null,
        issues: [{
            severity: 'error',
            code: 'unsupported-schema-version',
            path: 'schemaVersion',
            message: `不支持的上一个可用版本格式：${Number.isFinite(rawVersion) ? rawVersion : '未声明'}`,
        }],
    };
};

export const migrateLastKnownGoodSnapshot = validateLastKnownGoodSnapshot;

const stableValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stableValue);
    const record = asRecord(value);
    if (!record) return value;
    return Object.keys(record).sort().reduce<UnknownRecord>((result, key) => {
        result[key] = stableValue(record[key]);
        return result;
    }, {});
};

/** Deterministic key ordering for hashing/atomic storage by a future persistence layer. */
export const serializeLastKnownGoodSnapshot = (snapshot: LastKnownGoodSnapshot): string => {
    const checked = validateLastKnownGoodSnapshot(snapshot);
    if (!checked.valid || !checked.snapshot) {
        const reason = checked.issues.filter(item => item.severity === 'error').map(item => item.message).join('；');
        throw new Error(`上一个可用版本无法序列化：${reason}`);
    }
    return `${JSON.stringify(stableValue(checked.snapshot), null, 2)}\n`;
};

export const createLastKnownGoodSnapshot = (
    input: Omit<LastKnownGoodSnapshot, 'schema' | 'schemaVersion'>,
): LastKnownGoodSnapshot => {
    const candidate: LastKnownGoodSnapshot = {
        schema: LAST_KNOWN_GOOD_SCHEMA_ID,
        schemaVersion: LAST_KNOWN_GOOD_SCHEMA_VERSION,
        ...input,
    };
    const checked = validateLastKnownGoodSnapshot(candidate);
    if (!checked.valid || !checked.snapshot) {
        const reason = checked.issues.filter(item => item.severity === 'error').map(item => `${item.path}: ${item.message}`).join('；');
        throw new Error(`无法建立上一个可用版本：${reason}`);
    }
    return checked.snapshot;
};

const metricFromCompile = (metric: CompileResourceMetric | null): LastKnownGoodResourceMetric => metric
    ? { state: 'reported', usedBytes: metric.usedBytes, totalBytes: metric.capacityKnown !== false ? metric.totalBytes : null }
    : { state: 'not-reported', usedBytes: null, totalBytes: null };

const reportedText = (value: string | null): ExplicitEvidence<string> => value
    ? { state: 'reported', value }
    : { state: 'not-reported' };
const reportedBytes = (value: number | null): ExplicitEvidence<number> => isPositiveInteger(value)
    ? { state: 'reported', value }
    : { state: 'not-reported' };

/**
 * Adapter from the current checkpoint/build/upload/hardware/resource evidence.
 * Hashes are supplied by the trusted producing layer; this pure service only
 * validates and binds them into one immutable identity.
 */
export const captureLastKnownGoodFromExistingEvidence = (
    input: LastKnownGoodCaptureInput,
): LastKnownGoodSnapshot => {
    const environment = input.compileEnvironment;
    const manifest = input.uploadManifest;
    if (environment.fqbn !== manifest.canonicalFqbn) {
        throw new Error(`构建 FQBN 与上传产物清单不一致：${environment.fqbn} / ${manifest.canonicalFqbn}`);
    }
    if (environment.buildSignature !== manifest.buildSignature) {
        throw new Error('构建签名与上传产物清单不一致');
    }
    if (input.resources.fqbn !== manifest.canonicalFqbn) {
        throw new Error(`资源统计来自其他构建目标：${input.resources.fqbn}`);
    }
    if (input.deviceHealth.target.resolvedFqbn !== manifest.canonicalFqbn) {
        throw new Error(`真机体检来自其他构建目标：${input.deviceHealth.target.resolvedFqbn}`);
    }
    const partition = manifest.partitionDefinition
        ? {
            state: 'captured' as const,
            relativePath: manifest.partitionDefinition.relativePath,
            sha256: manifest.partitionDefinition.sha256,
        }
        : { state: 'not-applicable' as const, reason: '该构建目标没有分区定义' };
    const hardwareObservedAt = input.deviceHealth.observedAt;
    return createLastKnownGoodSnapshot({
        recordId: input.recordId,
        createdAt: input.createdAt || new Date().toISOString(),
        project: {
            path: input.checkpoint.projectPath,
            name: input.checkpoint.projectName,
            workspace: {
                format: 'blockly-json',
                content: input.checkpoint.workspaceJson,
                sha256: input.workspaceSha256,
            },
            generatedSource: {
                format: 'arduino-cpp',
                content: input.checkpoint.code,
                sha256: input.sourceSha256,
            },
            blockCount: input.checkpoint.blockCount,
        },
        ckLock: input.ckLock,
        build: {
            core: { package: environment.coreId, version: environment.coreVersion },
            cliVersion: environment.cliVersion,
            toolchainKey: environment.toolchainKey,
            canonicalFqbn: manifest.canonicalFqbn,
            fqbnOptionsComplete: true,
            optimization: input.optimization,
            partition,
            buildSignature: manifest.buildSignature,
            firmware: {
                complete: true,
                manifestSchemaVersion: manifest.schemaVersion,
                segments: manifest.artifacts.map(artifact => ({
                    role: artifact.role,
                    relativePath: artifact.relativePath,
                    address: canonicalAddress(artifact.address),
                    sizeBytes: artifact.sizeBytes,
                    sha256: artifact.sha256,
                })),
            },
        },
        hardware: {
            observedAt: hardwareObservedAt,
            source: 'device-health',
            deviceIdSha256: input.deviceHealth.device.deviceId,
            chip: reportedText(input.deviceHealth.device.chip),
            flashBytes: reportedBytes(input.deviceHealth.memory.flashBytes),
            psramBytes: reportedBytes(input.deviceHealth.memory.psramBytes),
        },
        resources: {
            flash: metricFromCompile(input.resources.flash),
            ram: metricFromCompile(input.resources.ram),
            warningCount: input.warningCount,
            measuredAt: input.resources.capturedAt,
        },
        qualification: {
            uploadedAt: input.uploadedAt,
            usableConfirmedAt: input.usableConfirmedAt,
            evidence: input.qualificationEvidence,
        },
    });
};

export const comparableStateFromLastKnownGood = (
    snapshot: LastKnownGoodSnapshot,
): LastKnownGoodComparableState => ({
    project: {
        path: snapshot.project.path,
        name: snapshot.project.name,
        workspaceSha256: snapshot.project.workspace.sha256,
        sourceSha256: snapshot.project.generatedSource.sha256,
        blockCount: snapshot.project.blockCount,
    },
    ckLock: JSON.parse(JSON.stringify(snapshot.ckLock)),
    build: JSON.parse(JSON.stringify({ ...snapshot.build, firmware: undefined })),
    artifacts: JSON.parse(JSON.stringify(snapshot.build.firmware)),
    hardware: JSON.parse(JSON.stringify(snapshot.hardware)),
    resources: JSON.parse(JSON.stringify(snapshot.resources)),
});

const shortHash = (value: string | null | undefined): string => value ? `${value.slice(0, 8)}…` : '未记录';
const formatBytes = (value: number | null): string => {
    if (value == null || !Number.isFinite(value)) return '未报告';
    if (Math.abs(value) < 1024) return `${value} B`;
    if (Math.abs(value) < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / 1024 / 1024).toFixed(2)} MiB`;
};
const evidenceLabel = <T>(value: ExplicitEvidence<T> | undefined, formatter: (item: T) => string): string => (
    !value || value.state === 'not-reported' ? '未明确报告' : formatter(value.value)
);
const stableEqual = (left: unknown, right: unknown): boolean => JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));

const artifactSummary = (set: LastKnownGoodFirmwareSet | undefined): string => {
    if (!set) return '未提供';
    return `${set.segments.length} 段 / ${set.segments.reduce((total, item) => total + item.sizeBytes, 0)} B`;
};

const optimizationSummary = (value: LastKnownGoodOptimizationIdentity | undefined): string => value
    ? `${value.profile} · ${value.level} · ${value.debugLevel} · LTO ${value.lto ? '开' : '关'} · ${value.contract}`
    : '未提供';

const resourceSummary = (value: LastKnownGoodResourceMetric | undefined): string => (
    !value || value.state === 'not-reported'
        ? '未报告'
        : value.totalBytes == null
            ? `${formatBytes(value.usedBytes)} / 上限未知`
            : `${formatBytes(value.usedBytes)} / ${formatBytes(value.totalBytes)}`
);

/** Chinese, privacy-bounded comparison. Project/source contents are never echoed. */
export const createLastKnownGoodDiffReport = (
    snapshot: LastKnownGoodSnapshot,
    current: LastKnownGoodComparableState,
): LastKnownGoodDiffReport => {
    const changes: LastKnownGoodDiffItem[] = [];
    const add = (
        category: LastKnownGoodDiffCategory,
        field: string,
        severity: LastKnownGoodDiffItem['severity'],
        summary: string,
        before: string,
        after: string,
    ) => changes.push({ category, field, severity, summary, before, after });
    const project = current.project;
    if (!project || project.path !== snapshot.project.path) add('project', 'project-path', 'info', '工程位置已变化', snapshot.project.path, project?.path || '未提供');
    if (!project || project.name !== snapshot.project.name) add('project', 'project-name', 'info', '工程名称已变化', snapshot.project.name, project?.name || '未提供');
    if (!project || project.workspaceSha256 !== snapshot.project.workspace.sha256) add('project', 'workspace', 'warning', '积木工程内容已变化', shortHash(snapshot.project.workspace.sha256), shortHash(project?.workspaceSha256));
    if (!project || project.sourceSha256 !== snapshot.project.generatedSource.sha256) add('project', 'source', 'warning', '生成源码已变化', shortHash(snapshot.project.generatedSource.sha256), shortHash(project?.sourceSha256));
    if (!project || project.blockCount !== snapshot.project.blockCount) add('project', 'block-count', 'info', '积木数量已变化', `${snapshot.project.blockCount}`, project ? `${project.blockCount}` : '未提供');

    if (!current.ckLock || !stableEqual(current.ckLock, snapshot.ckLock)) {
        const before = snapshot.ckLock.state === 'captured' ? shortHash(snapshot.ckLock.sha256) : `不适用：${snapshot.ckLock.reason}`;
        const after = current.ckLock?.state === 'captured' ? shortHash(current.ckLock.sha256)
            : current.ckLock?.state === 'not-applicable' ? `不适用：${current.ckLock.reason}` : '未提供';
        add('ck-lock', 'ck-lock', 'blocker', 'ck.lock 身份已变化', before, after);
    }

    const build = current.build;
    if (!build || !stableEqual(build.core, snapshot.build.core)) add('build', 'core', 'blocker', 'Core 身份已变化', `${snapshot.build.core.package}@${snapshot.build.core.version}`, build ? `${build.core.package}@${build.core.version}` : '未提供');
    if (!build || build.cliVersion !== snapshot.build.cliVersion) add('build', 'cli-version', 'blocker', 'Arduino CLI 版本已变化', snapshot.build.cliVersion, build?.cliVersion || '未提供');
    if (!build || build.toolchainKey !== snapshot.build.toolchainKey) add('build', 'toolchain', 'blocker', '工具链身份已变化', shortHash(snapshot.build.toolchainKey), shortHash(build?.toolchainKey));
    if (!build || build.canonicalFqbn !== snapshot.build.canonicalFqbn || build.fqbnOptionsComplete !== true) add('build', 'fqbn', 'blocker', '完整 FQBN 或菜单完整性已变化', snapshot.build.canonicalFqbn, build?.canonicalFqbn || '未提供');
    if (!build || !stableEqual(build.optimization, snapshot.build.optimization)) add('build', 'optimization', 'blocker', '实际优化参数已变化', optimizationSummary(snapshot.build.optimization), optimizationSummary(build?.optimization));
    if (!build || !stableEqual(build.partition, snapshot.build.partition)) {
        const partitionLabel = (value: LastKnownGoodPartition | undefined) => value?.state === 'captured'
            ? `${value.relativePath} · ${shortHash(value.sha256)}`
            : value?.state === 'not-applicable' ? `不适用：${value.reason}` : '未提供';
        add('build', 'partition', 'blocker', '分区定义已变化', partitionLabel(snapshot.build.partition), partitionLabel(build?.partition));
    }
    if (!build || build.buildSignature !== snapshot.build.buildSignature) add('build', 'build-signature', 'blocker', '构建签名已变化', shortHash(snapshot.build.buildSignature), shortHash(build?.buildSignature));

    if (!current.artifacts || !stableEqual(current.artifacts, snapshot.build.firmware)) {
        add('firmware', 'artifact-set', 'blocker', '完整烧录段集合已变化', artifactSummary(snapshot.build.firmware), artifactSummary(current.artifacts));
        const expected = new Map(snapshot.build.firmware.segments.map(segment => [`${segment.role}@${segment.address ?? '-'}`, segment]));
        const actual = new Map((current.artifacts?.segments || []).map(segment => [`${segment.role}@${segment.address ?? '-'}`, segment]));
        for (const [key, segment] of expected) {
            const next = actual.get(key);
            if (!next) add('firmware', `segment:${key}`, 'blocker', `烧录段 ${key} 缺失`, shortHash(segment.sha256), '缺失');
            else if (next.sha256 !== segment.sha256 || next.sizeBytes !== segment.sizeBytes || next.relativePath !== segment.relativePath) {
                add('firmware', `segment:${key}`, 'blocker', `烧录段 ${key} 内容已变化`, `${segment.relativePath} · ${segment.sizeBytes} B · ${shortHash(segment.sha256)}`, `${next.relativePath} · ${next.sizeBytes} B · ${shortHash(next.sha256)}`);
            }
        }
        for (const [key, segment] of actual) {
            if (!expected.has(key)) add('firmware', `segment:${key}`, 'blocker', `出现额外烧录段 ${key}`, '不存在', `${segment.relativePath} · ${shortHash(segment.sha256)}`);
        }
    }

    const hardware = current.hardware;
    if (!hardware || !stableEqual(hardware.chip, snapshot.hardware.chip)) add('hardware', 'chip', 'blocker', '真机芯片证据已变化', evidenceLabel(snapshot.hardware.chip, String), evidenceLabel(hardware?.chip, String));
    if (!hardware || !stableEqual(hardware.flashBytes, snapshot.hardware.flashBytes)) add('hardware', 'flash', 'blocker', '实体 Flash 证据已变化', evidenceLabel(snapshot.hardware.flashBytes, formatBytes), evidenceLabel(hardware?.flashBytes, formatBytes));
    if (!hardware || !stableEqual(hardware.psramBytes, snapshot.hardware.psramBytes)) add('hardware', 'psram', 'blocker', '明确 PSRAM 证据已变化', evidenceLabel(snapshot.hardware.psramBytes, formatBytes), evidenceLabel(hardware?.psramBytes, formatBytes));

    const resources = current.resources;
    if (!resources || !stableEqual(resources.flash, snapshot.resources.flash)) add('resources', 'flash-usage', 'warning', '程序空间统计已变化', resourceSummary(snapshot.resources.flash), resourceSummary(resources?.flash));
    if (!resources || !stableEqual(resources.ram, snapshot.resources.ram)) add('resources', 'ram-usage', 'warning', '内部 RAM 统计已变化', resourceSummary(snapshot.resources.ram), resourceSummary(resources?.ram));
    if (!resources || resources.warningCount !== snapshot.resources.warningCount) add('resources', 'warning-count', 'warning', '编译警告数量已变化', `${snapshot.resources.warningCount}`, resources ? `${resources.warningCount}` : '未提供');

    const blockerCount = changes.filter(item => item.severity === 'blocker').length;
    const summary = changes.length === 0
        ? '当前状态与上一个可用版本一致。'
        : `发现 ${changes.length} 项变化，其中 ${blockerCount} 项影响固件恢复安全。`;
    return {
        identical: changes.length === 0,
        summary,
        changes,
        lines: [summary, ...changes.map(item => `- ${item.summary}：${item.before} → ${item.after}`)],
    };
};

const firmwareIdentityBlockers = (
    snapshot: LastKnownGoodSnapshot,
    context: LastKnownGoodRestoreContext,
): string[] => {
    const blockers: string[] = [];
    const current = context.current;
    if (!context.existingUploadGateAvailable) blockers.push('现有 CK 上传门禁不可用，禁止直接写入固件文件');
    if (!current.build) blockers.push('尚未读取当前 Core、工具链、完整 FQBN、优化参数与构建签名');
    if (!current.ckLock) blockers.push('尚未读取当前 ck.lock 状态');
    if (!context.stagedArtifacts) blockers.push('尚未重新读取并校验全部待恢复烧录段');
    if (!current.hardware) blockers.push('尚未重新执行真机体检');

    if (current.build) {
        if (!stableEqual(current.build.core, snapshot.build.core)) blockers.push('当前 Core 包或版本与上一个可用版本不一致');
        if (current.build.cliVersion !== snapshot.build.cliVersion) blockers.push('当前 Arduino CLI 版本与上一个可用版本不一致');
        if (current.build.toolchainKey !== snapshot.build.toolchainKey) blockers.push('当前工具链身份与上一个可用版本不一致');
        if (current.build.canonicalFqbn !== snapshot.build.canonicalFqbn || current.build.fqbnOptionsComplete !== true) blockers.push('当前完整 FQBN 或菜单选项完整性不一致');
        if (!stableEqual(current.build.optimization, snapshot.build.optimization)) blockers.push('当前实际优化参数与上一个可用版本不一致');
        if (!stableEqual(current.build.partition, snapshot.build.partition)) blockers.push('当前分区定义或分区 SHA-256 不一致');
        if (current.build.buildSignature !== snapshot.build.buildSignature) blockers.push('当前构建签名与上一个可用版本不一致');
    }
    if (current.ckLock && !stableEqual(current.ckLock, snapshot.ckLock)) blockers.push('当前 ck.lock 与上一个可用版本不一致');
    if (context.stagedArtifacts && !stableEqual(context.stagedArtifacts, snapshot.build.firmware)) blockers.push('重新校验的烧录段地址、大小或 SHA-256 不一致');

    const savedChip = snapshot.hardware.chip;
    const savedFlash = snapshot.hardware.flashBytes;
    if (savedChip.state !== 'reported') blockers.push('上一个可用版本没有明确芯片型号，无法证明恢复目标安全');
    if (savedFlash.state !== 'reported') blockers.push('上一个可用版本没有明确实体 Flash，无法证明恢复目标安全');
    if (current.hardware) {
        if (current.hardware.chip.state !== 'reported') blockers.push('当前真机未明确报告芯片型号');
        else if (savedChip.state === 'reported' && current.hardware.chip.value !== savedChip.value) blockers.push('当前真机芯片型号与上一个可用版本不一致');
        if (current.hardware.flashBytes.state !== 'reported') blockers.push('当前真机未明确报告实体 Flash');
        else if (savedFlash.state === 'reported' && current.hardware.flashBytes.value !== savedFlash.value) blockers.push('当前真机实体 Flash 与上一个可用版本不一致');
        if (snapshot.hardware.psramBytes.state === 'reported') {
            if (current.hardware.psramBytes.state !== 'reported') blockers.push('当前真机未明确报告上一个可用版本所需的 PSRAM');
            else if (current.hardware.psramBytes.value !== snapshot.hardware.psramBytes.value) blockers.push('当前真机明确报告的 PSRAM 与上一个可用版本不一致');
        }
    }
    return [...new Set(blockers)];
};

/**
 * Computes a plan only.  It cannot execute or bypass uploads.
 * Firmware/complete plans always include and require existing-upload-gate.
 */
export const calculateLastKnownGoodRestorePlan = (
    snapshotInput: unknown,
    context: LastKnownGoodRestoreContext,
    kind: RestoreKind,
): LastKnownGoodRestorePlan => {
    const checked = validateLastKnownGoodSnapshot(snapshotInput);
    const snapshot = checked.snapshot;
    const uploadRequired = kind === 'firmware' || kind === 'complete';
    const blockers = checked.issues.filter(item => item.severity === 'error').map(item => item.message);
    const warnings = checked.issues.filter(item => item.severity === 'warning').map(item => item.message);
    const emptyDiff: LastKnownGoodDiffReport = {
        identical: false,
        summary: '上一个可用版本无效，无法比较。',
        changes: [],
        lines: ['上一个可用版本无效，无法比较。'],
    };
    const diff = snapshot ? createLastKnownGoodDiffReport(snapshot, {
        ...context.current,
        artifacts: context.stagedArtifacts || context.current.artifacts,
    }) : emptyDiff;

    if ((kind === 'project' || kind === 'complete') && !context.canCreateSafetyCheckpoint) {
        blockers.push('无法为当前工程创建恢复前保护检查点，禁止覆盖现有工程');
    }
    if (uploadRequired && snapshot) blockers.push(...firmwareIdentityBlockers(snapshot, context));
    if (snapshot?.hardware.psramBytes.state === 'not-reported') {
        warnings.push('上一个可用版本未明确报告 PSRAM；不会据此推断设备没有 PSRAM');
    }

    const uniqueBlockers = [...new Set(blockers)];
    const uniqueWarnings = [...new Set(warnings)];
    const gateBlocked = uploadRequired && (!context.existingUploadGateAvailable || uniqueBlockers.length > 0);
    const steps: LastKnownGoodRestoreStep[] = [
        {
            id: 'validate-snapshot',
            title: '验证上一个可用版本',
            description: '校验 schema、工程内容哈希、ck.lock、构建身份、分区和全部固件段证据。',
            required: true,
            blocked: !checked.valid,
        },
    ];
    if (kind === 'project' || kind === 'complete') {
        steps.push({
            id: 'create-safety-checkpoint',
            title: '保护当前工程',
            description: '先调用现有工程检查点能力保存当前完整积木与源码，再允许替换。',
            required: true,
            blocked: !context.canCreateSafetyCheckpoint,
        });
        steps.push({
            id: 'restore-project-content',
            title: '恢复工程、积木与源码',
            description: '恢复保存的 Blockly JSON 与同一时刻生成源码；恢复后仍需按正常工程流程保存。',
            required: true,
            blocked: uniqueBlockers.length > 0,
        });
    }
    if (uploadRequired) {
        steps.push(
            {
                id: 'revalidate-hardware',
                title: '重新核对真机',
                description: '通过现有真机体检重新确认芯片、实体 Flash 与明确报告的 PSRAM，不从型号名称猜测。',
                required: true,
                blocked: !context.current.hardware || uniqueBlockers.length > 0,
            },
            {
                id: 'revalidate-artifact-set',
                title: '重新校验完整固件包',
                description: '重新读取全部烧录段，逐段核对角色、地址、大小和 SHA-256，并核对分区定义。',
                required: true,
                blocked: !context.stagedArtifacts || uniqueBlockers.length > 0,
            },
            {
                id: 'existing-upload-gate',
                title: '重新通过现有上传门禁',
                description: '必须回到 CK 现有 gated upload 流程，重新验证 .ck-upload-artifacts.json、完整 FQBN、构建签名、分区和所有烧录段；禁止直接调用烧录工具或写 Flash。',
                required: true,
                blocked: gateBlocked,
            },
            {
                id: 'verify-upload-outcome',
                title: '确认上传结果',
                description: '只有现有上传流程明确成功后才完成恢复；失败不得把该版本重新标记为可用。',
                required: true,
                blocked: gateBlocked,
            },
        );
    }

    return {
        kind,
        canProceed: uniqueBlockers.length === 0,
        blockers: uniqueBlockers,
        warnings: uniqueWarnings,
        steps,
        diff,
        uploadPolicy: {
            required: uploadRequired,
            gate: LAST_KNOWN_GOOD_UPLOAD_GATE,
            requireArtifactManifestValidation: uploadRequired,
            requireCanonicalFqbnMatch: uploadRequired,
            requireBuildSignatureMatch: uploadRequired,
            allowDirectArtifactWrite: false,
        },
    };
};
