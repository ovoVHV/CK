import { invoke } from '@tauri-apps/api/core';
import { projectHealthCapabilities } from './project_health_capabilities';

export type DiagnosticContentLevel =
    | 'full_project'
    | 'generated_source_only'
    | 'no_source';

export type DiagnosticItemRole =
    | 'project'
    | 'generated_source'
    | 'source_map'
    | 'compile_log'
    | 'upload_log'
    | 'serial_log'
    | 'artifact_manifest'
    | 'board_manifest'
    | 'environment'
    | 'other';

export interface DiagnosticPrivacyOptions {
    redactWifi: boolean;
    redactUsername: boolean;
    redactPaths: boolean;
    redactSerialContent: boolean;
}

export interface DiagnosticContext {
    boardName?: string | null;
    boardId?: string | null;
    corePackage?: string | null;
    coreVersion?: string | null;
    fqbn?: string | null;
    flashUsedBytes?: number | null;
    flashTotalBytes?: number | null;
    flashConfiguration?: string | null;
    coreMissing?: boolean;
    failureStage?: string | null;
}

export interface DiagnosticBundleItem {
    /** Stable ID used by the archive manifest and warning list. */
    id: string;
    role: DiagnosticItemRole;
    /** Relative path below the archive's protected files/ directory. */
    archivePath: string;
    /** Local source path. Mutually exclusive with content. */
    path?: string | null;
    /** Inline UTF-8 content. Mutually exclusive with path. */
    content?: string | null;
    required?: boolean;
}

export interface DiagnosticBundleExportData {
    context: DiagnosticContext;
    items: DiagnosticBundleItem[];
}

export type DiagnosticEvidenceSource =
    | { path: string; content?: never }
    | { content: string; path?: never };

/**
 * Evidence already owned by Workspace and CK's local services. Values may be
 * either a local file/directory or an inline UTF-8 snapshot. Omitted values
 * remain explicit `missing` records in the ZIP manifest instead of being
 * silently invented by the frontend.
 */
export interface StandardDiagnosticEvidence {
    project?: DiagnosticEvidenceSource;
    generatedSource?: DiagnosticEvidenceSource;
    sourceMap?: DiagnosticEvidenceSource;
    support?: DiagnosticEvidenceSource;
    boardReport?: DiagnosticEvidenceSource;
    buildManifest?: DiagnosticEvidenceSource;
    uploadManifest?: DiagnosticEvidenceSource;
    ckLock?: DiagnosticEvidenceSource;
    compileLog?: DiagnosticEvidenceSource;
    uploadLog?: DiagnosticEvidenceSource;
    packageQualityReports?: DiagnosticEvidenceSource;
    projectChangeSummary?: DiagnosticEvidenceSource;
    serialDevice?: DiagnosticEvidenceSource;
    serialLog?: DiagnosticEvidenceSource;
}

export interface DiagnosticBundleExportRequest extends DiagnosticBundleExportData {
    outputPath: string;
    contentLevel: DiagnosticContentLevel;
    privacy: DiagnosticPrivacyOptions;
}

export interface DiagnosticSummaryZh {
    title: string;
    contentLevel: string;
    board: string;
    core: string;
    fqbn: string;
    flash: string;
    missingCore: boolean;
    failureStage: string;
    sourceIncluded: boolean;
}

export interface DiagnosticBundleExportResult {
    outputPath: string;
    includedFiles: number;
    missingItems: number;
    omittedItems: number;
    warnings: string[];
    summary: DiagnosticSummaryZh;
}

export interface DiagnosticBundleInspection {
    valid: boolean;
    schemaVersion: number;
    includedFiles: number;
    missingItems: number;
    warnings: string[];
    summary: DiagnosticSummaryZh;
    networkUsed: boolean;
    uploadPerformed: boolean;
}

export type DiagnosticCoreAvailabilityState =
    | 'ready'
    | 'missing'
    | 'version_difference'
    | 'recorded_missing'
    | 'unknown';

export interface DiagnosticCoreAvailability {
    state: DiagnosticCoreAvailabilityState;
    packageName: string | null;
    requiredVersion: string | null;
    installedVersion: string | null;
    label: string;
}

export const DEFAULT_DIAGNOSTIC_PRIVACY: Readonly<DiagnosticPrivacyOptions> = Object.freeze({
    redactWifi: true,
    redactUsername: true,
    redactPaths: true,
    redactSerialContent: true,
});

export const DIAGNOSTIC_CONTENT_LEVEL_LABELS: Readonly<Record<DiagnosticContentLevel, string>> = {
    full_project: '包含完整工程',
    generated_source_only: '仅包含生成源码',
    no_source: '不包含源码',
};

interface StandardDiagnosticItemDefinition {
    key: keyof StandardDiagnosticEvidence;
    id: string;
    role: DiagnosticItemRole;
    archivePath: string;
    required: boolean;
}

const STANDARD_DIAGNOSTIC_ITEMS: readonly StandardDiagnosticItemDefinition[] = [
    { key: 'support', id: 'support', role: 'environment', archivePath: 'support.json', required: true },
    { key: 'boardReport', id: 'board-report', role: 'board_manifest', archivePath: 'board-report.json', required: true },
    { key: 'buildManifest', id: 'build-manifest', role: 'artifact_manifest', archivePath: 'build-manifest.json', required: false },
    { key: 'uploadManifest', id: 'upload-manifest', role: 'artifact_manifest', archivePath: 'upload-manifest.json', required: false },
    { key: 'ckLock', id: 'ck-lock', role: 'environment', archivePath: 'ck.lock', required: false },
    { key: 'compileLog', id: 'compile-log', role: 'compile_log', archivePath: 'compile.log', required: false },
    { key: 'uploadLog', id: 'upload-log', role: 'upload_log', archivePath: 'upload.log', required: false },
    { key: 'packageQualityReports', id: 'package-quality-reports', role: 'environment', archivePath: 'package-quality-reports/index.json', required: false },
    { key: 'projectChangeSummary', id: 'project-change-summary', role: 'other', archivePath: 'project-change-summary.json', required: false },
    { key: 'serialDevice', id: 'serial-device', role: 'board_manifest', archivePath: 'serial-device.json', required: false },
    { key: 'serialLog', id: 'serial-log', role: 'serial_log', archivePath: 'serial.log', required: false },
    { key: 'project', id: 'project', role: 'project', archivePath: 'project', required: false },
    { key: 'generatedSource', id: 'generated-source', role: 'generated_source', archivePath: 'generated-source/main.ino', required: false },
    { key: 'sourceMap', id: 'compile-source-map', role: 'source_map', archivePath: 'ck-sourcemap.json', required: false },
] as const;

export const createStandardDiagnosticBundleItems = (
    evidence: StandardDiagnosticEvidence,
    fqbn?: string,
): DiagnosticBundleItem[] => STANDARD_DIAGNOSTIC_ITEMS.filter(definition => {
    if (fqbn === undefined || projectHealthCapabilities(fqbn).lastWorkingVersion) return true;
    // Unsupported recovery does not constitute missing evidence in a diagnostic ZIP.
    return !['uploadManifest', 'ckLock', 'projectChangeSummary'].includes(definition.key);
}).map(definition => {
    const source = evidence[definition.key];
    return {
        id: definition.id,
        role: definition.role,
        archivePath: definition.archivePath,
        required: definition.required,
        ...(source ? { ...source } : {}),
    };
});

const parseDiagnosticCoreLabel = (core: string): {
    packageName: string | null;
    requiredVersion: string | null;
} => {
    const value = String(core || '').trim();
    const missingMatch = /^缺失[（(](.+?)[）)]$/.exec(value);
    if (missingMatch) return { packageName: missingMatch[1].trim() || null, requiredVersion: null };
    const separator = value.lastIndexOf('@');
    if (separator > 0 && separator < value.length - 1) {
        return {
            packageName: value.slice(0, separator).trim() || null,
            requiredVersion: value.slice(separator + 1).trim() || null,
        };
    }
    return { packageName: null, requiredVersion: null };
};

/**
 * Compares the imported requirement with this computer only when the owner
 * supplies its installed Core map. Without that map, recorded export-time
 * evidence is labelled as such and is never misrepresented as a local check.
 */
export const deriveDiagnosticCoreAvailability = (
    summary: Pick<DiagnosticSummaryZh, 'core' | 'missingCore'>,
    currentCoreVersions?: Readonly<Record<string, string>>,
): DiagnosticCoreAvailability => {
    const { packageName, requiredVersion } = parseDiagnosticCoreLabel(summary.core);
    if (!currentCoreVersions) {
        return {
            state: summary.missingCore ? 'recorded_missing' : 'unknown',
            packageName,
            requiredVersion,
            installedVersion: null,
            label: summary.missingCore ? '诊断记录报告 Core 缺失' : '尚未检查当前电脑的 Core',
        };
    }
    if (!packageName) {
        return {
            state: 'unknown',
            packageName: null,
            requiredVersion,
            installedVersion: null,
            label: '诊断包未提供可比较的 Core 包名',
        };
    }
    const installedVersion = String(currentCoreVersions[packageName] || '').trim() || null;
    if (!installedVersion) {
        return {
            state: 'missing',
            packageName,
            requiredVersion,
            installedVersion: null,
            label: `当前电脑缺少 ${packageName}`,
        };
    }
    if (requiredVersion && installedVersion !== requiredVersion) {
        return {
            state: 'version_difference',
            packageName,
            requiredVersion,
            installedVersion,
            label: `当前电脑为 ${installedVersion}，诊断包使用 ${requiredVersion}`,
        };
    }
    return {
        state: 'ready',
        packageName,
        requiredVersion,
        installedVersion,
        label: `当前电脑已安装 ${packageName}@${installedVersion}`,
    };
};

export const isNativeDiagnosticBundleAvailable = (): boolean => (
    typeof window !== 'undefined'
    && Boolean(
        (window as any).__TAURI_IPC__
        || (window as any).__TAURI_INTERNALS__
        || (window as any).__TAURI__,
    )
);

const asRecord = (value: unknown): Record<string, unknown> | null => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
);

const requiredString = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`诊断包返回缺少有效字段：${field}`);
    }
    return value;
};

const nonNegativeInteger = (value: unknown, field: string): number => {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new Error(`诊断包返回的计数字段无效：${field}`);
    }
    return Number(value);
};

const stringArray = (value: unknown, field: string): string[] => {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new Error(`诊断包返回的列表字段无效：${field}`);
    }
    return [...value];
};

const booleanValue = (value: unknown, field: string): boolean => {
    if (typeof value !== 'boolean') {
        throw new Error(`诊断包返回的布尔字段无效：${field}`);
    }
    return value;
};

export const normalizeDiagnosticSummary = (value: unknown): DiagnosticSummaryZh => {
    const record = asRecord(value);
    if (!record) throw new Error('诊断包返回的中文摘要无效');
    return {
        title: requiredString(record.title, 'summary.title'),
        contentLevel: requiredString(record.contentLevel, 'summary.contentLevel'),
        board: requiredString(record.board, 'summary.board'),
        core: requiredString(record.core, 'summary.core'),
        fqbn: requiredString(record.fqbn, 'summary.fqbn'),
        flash: requiredString(record.flash, 'summary.flash'),
        missingCore: booleanValue(record.missingCore, 'summary.missingCore'),
        failureStage: requiredString(record.failureStage, 'summary.failureStage'),
        sourceIncluded: booleanValue(record.sourceIncluded, 'summary.sourceIncluded'),
    };
};

export const normalizeDiagnosticBundleInspection = (
    value: unknown,
): DiagnosticBundleInspection => {
    const record = asRecord(value);
    if (!record) throw new Error('诊断包检查结果无效');
    const valid = booleanValue(record.valid, 'valid');
    const networkUsed = booleanValue(record.networkUsed, 'networkUsed');
    const uploadPerformed = booleanValue(record.uploadPerformed, 'uploadPerformed');
    if (!valid) throw new Error('诊断包未通过本地完整性检查');
    if (networkUsed || uploadPerformed) {
        throw new Error('该文件声明使用了网络或自动上传，已拒绝作为本地诊断包打开');
    }
    return {
        valid,
        schemaVersion: nonNegativeInteger(record.schemaVersion, 'schemaVersion'),
        includedFiles: nonNegativeInteger(record.includedFiles, 'includedFiles'),
        missingItems: nonNegativeInteger(record.missingItems, 'missingItems'),
        warnings: stringArray(record.warnings, 'warnings'),
        summary: normalizeDiagnosticSummary(record.summary),
        networkUsed,
        uploadPerformed,
    };
};

const normalizeDiagnosticBundleExportResult = (
    value: unknown,
): DiagnosticBundleExportResult => {
    const record = asRecord(value);
    if (!record) throw new Error('诊断包导出结果无效');
    return {
        outputPath: requiredString(record.outputPath, 'outputPath'),
        includedFiles: nonNegativeInteger(record.includedFiles, 'includedFiles'),
        missingItems: nonNegativeInteger(record.missingItems, 'missingItems'),
        omittedItems: nonNegativeInteger(record.omittedItems, 'omittedItems'),
        warnings: stringArray(record.warnings, 'warnings'),
        summary: normalizeDiagnosticSummary(record.summary),
    };
};

export const ensureDiagnosticBundleZipPath = (path: string): string => {
    const trimmed = String(path || '').trim();
    if (!trimmed) throw new Error('请选择诊断包保存位置');
    return /\.zip$/i.test(trimmed) ? trimmed : `${trimmed}.zip`;
};

export const createDiagnosticBundleFileName = (now = new Date()): string => {
    const stamp = Number.isFinite(now.getTime())
        ? now.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
        : 'unknown-time';
    return `CK-诊断包_${stamp}.zip`;
};

export const exportDiagnosticBundle = async (
    request: DiagnosticBundleExportRequest,
): Promise<DiagnosticBundleExportResult> => {
    const normalized: DiagnosticBundleExportRequest = {
        ...request,
        outputPath: ensureDiagnosticBundleZipPath(request.outputPath),
        privacy: { ...request.privacy },
        context: { ...request.context },
        items: request.items.map(item => ({ ...item })),
    };
    const result = await invoke<unknown>('export_diagnostic_bundle', { request: normalized });
    return normalizeDiagnosticBundleExportResult(result);
};

export const inspectDiagnosticBundle = async (
    path: string,
): Promise<DiagnosticBundleInspection> => {
    const normalizedPath = String(path || '').trim();
    if (!normalizedPath) throw new Error('请选择要打开的诊断包');
    const result = await invoke<unknown>('inspect_diagnostic_bundle', { path: normalizedPath });
    return normalizeDiagnosticBundleInspection(result);
};
