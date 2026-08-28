import { invoke } from '@tauri-apps/api/core';
import type { ProjectAcceptanceReport } from './project_acceptance_report';

export type ProjectSubmissionSourceScope =
    | 'no_source'
    | 'editable_project'
    | 'generated_source'
    | 'editable_and_generated';

export interface ProjectSubmissionExportRequest {
    outputPath: string;
    sourceScope: ProjectSubmissionSourceScope;
    sourceDisclosureAcknowledged: boolean;
    report: ProjectAcceptanceReport;
    workspaceJson?: string;
    generatedSource?: string;
    ckLock?: string;
    includeBuildEvidence: boolean;
}

export interface ProjectSubmissionSummary {
    projectName: string;
    blockCount: number;
    workspaceSha256: string;
    generatedCodeSha256: string;
    boardName: string;
    boardId: string;
    boardPackageId: string;
    fqbn: string;
    coreId: string;
    coreVersion: string | null;
    compileState: 'passed' | 'failed' | 'not-run' | 'unverified-target';
    compileRecordedAt: string | null;
    flashUsedBytes: number | null;
    flashTotalBytes: number | null;
    ramUsedBytes: number | null;
    ramTotalBytes: number | null;
    dependencyLockAvailable: boolean;
    dependencyLockSha256: string | null;
    dependencyCount: number;
    dependenciesAllVersioned: boolean;
    hardwareState: 'verified' | 'partial' | 'failed' | 'not-checked' | 'unsupported';
    hardwareChip: string | null;
    hardwareFlashBytes: number | null;
    hardwarePsramBytes: number | null;
    checkpointCount: number;
    healthSummary: string;
    healthPassCount: number;
    healthWarningCount: number;
    healthErrorCount: number;
    healthInfoCount: number;
}

export interface ProjectSubmissionGeneratedBy {
    product: string;
    version: string;
    component: string;
}

export interface ProjectSubmissionExportResult {
    outputPath: string;
    packageFileName: string;
    packageSha256: string;
    schemaVersion: number;
    includedFiles: number;
    sourceScope: ProjectSubmissionSourceScope;
    hasDependencyLock: boolean;
    hasBuildEvidence: boolean;
    summary: ProjectSubmissionSummary;
    integrityVerified: true;
    publisherIdentityVerified: false;
    authenticityMessage: string;
    networkUsed: false;
    uploadPerformed: false;
}

export interface ProjectSubmissionInspection {
    valid: true;
    schemaVersion: number;
    format: 'ck-project-package';
    kind: 'project-submission';
    generatedBy: ProjectSubmissionGeneratedBy;
    generatedAt: string;
    packageFileName: string;
    packageSha256: string;
    includedFiles: number;
    sourceScope: ProjectSubmissionSourceScope;
    sourceDisclosureAcknowledged: boolean;
    hasDependencyLock: boolean;
    hasBuildEvidence: boolean;
    summary: ProjectSubmissionSummary;
    integrityVerified: true;
    publisherIdentityVerified: false;
    authenticityMessage: string;
    networkUsed: false;
    uploadPerformed: false;
}

const sourceScopes: readonly ProjectSubmissionSourceScope[] = [
    'no_source',
    'editable_project',
    'generated_source',
    'editable_and_generated',
];

const asRecord = (value: unknown, field: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`project.ckpkg 返回字段 ${field} 必须是对象`);
    }
    return value as Record<string, unknown>;
};

const requiredString = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`project.ckpkg 返回字段 ${field} 无效`);
    }
    return value;
};

const packageFileName = (value: unknown): string => {
    const name = requiredString(value, 'packageFileName');
    if (!/^[^\\/:\0]+\.ckpkg$/i.test(name)) {
        throw new Error('project.ckpkg 返回字段 packageFileName 无效');
    }
    return name;
};

const sha256 = (value: unknown, field: string): string => {
    const hash = requiredString(value, field);
    if (!/^[0-9a-f]{64}$/.test(hash)) {
        throw new Error(`project.ckpkg 返回字段 ${field} 不是小写 SHA-256`);
    }
    return hash;
};

const optionalString = (value: unknown, field: string): string | null => {
    if (value == null) return null;
    return requiredString(value, field);
};

const nonNegativeInteger = (value: unknown, field: string): number => {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new Error(`project.ckpkg 返回字段 ${field} 必须是非负整数`);
    }
    return Number(value);
};

const optionalInteger = (value: unknown, field: string): number | null => {
    if (value == null) return null;
    return nonNegativeInteger(value, field);
};

const exactBoolean = <T extends boolean>(value: unknown, expected: T, field: string): T => {
    if (value !== expected) {
        throw new Error(`project.ckpkg 返回字段 ${field} 必须是 ${String(expected)}`);
    }
    return expected;
};

const oneOf = <T extends string>(value: unknown, values: readonly T[], field: string): T => {
    if (typeof value !== 'string' || !values.includes(value as T)) {
        throw new Error(`project.ckpkg 返回字段 ${field} 无效`);
    }
    return value as T;
};

const normalizeSourceScope = (value: unknown): ProjectSubmissionSourceScope => (
    oneOf(value, sourceScopes, 'sourceScope')
);

export const normalizeProjectSubmissionSummary = (value: unknown): ProjectSubmissionSummary => {
    const record = asRecord(value, 'summary');
    const compileState = oneOf(
        record.compileState,
        ['passed', 'failed', 'not-run', 'unverified-target'] as const,
        'summary.compileState',
    );
    const hardwareState = oneOf(
        record.hardwareState,
        ['verified', 'partial', 'failed', 'not-checked', 'unsupported'] as const,
        'summary.hardwareState',
    );
    return {
        projectName: requiredString(record.projectName, 'summary.projectName'),
        blockCount: nonNegativeInteger(record.blockCount, 'summary.blockCount'),
        workspaceSha256: requiredString(record.workspaceSha256, 'summary.workspaceSha256'),
        generatedCodeSha256: requiredString(record.generatedCodeSha256, 'summary.generatedCodeSha256'),
        boardName: requiredString(record.boardName, 'summary.boardName'),
        boardId: requiredString(record.boardId, 'summary.boardId'),
        boardPackageId: requiredString(record.boardPackageId, 'summary.boardPackageId'),
        fqbn: requiredString(record.fqbn, 'summary.fqbn'),
        coreId: requiredString(record.coreId, 'summary.coreId'),
        coreVersion: optionalString(record.coreVersion, 'summary.coreVersion'),
        compileState,
        compileRecordedAt: optionalString(record.compileRecordedAt, 'summary.compileRecordedAt'),
        flashUsedBytes: optionalInteger(record.flashUsedBytes, 'summary.flashUsedBytes'),
        flashTotalBytes: optionalInteger(record.flashTotalBytes, 'summary.flashTotalBytes'),
        ramUsedBytes: optionalInteger(record.ramUsedBytes, 'summary.ramUsedBytes'),
        ramTotalBytes: optionalInteger(record.ramTotalBytes, 'summary.ramTotalBytes'),
        dependencyLockAvailable: typeof record.dependencyLockAvailable === 'boolean'
            ? record.dependencyLockAvailable
            : (() => { throw new Error('project.ckpkg 返回字段 summary.dependencyLockAvailable 无效'); })(),
        dependencyLockSha256: optionalString(record.dependencyLockSha256, 'summary.dependencyLockSha256'),
        dependencyCount: nonNegativeInteger(record.dependencyCount, 'summary.dependencyCount'),
        dependenciesAllVersioned: typeof record.dependenciesAllVersioned === 'boolean'
            ? record.dependenciesAllVersioned
            : (() => { throw new Error('project.ckpkg 返回字段 summary.dependenciesAllVersioned 无效'); })(),
        hardwareState,
        hardwareChip: optionalString(record.hardwareChip, 'summary.hardwareChip'),
        hardwareFlashBytes: optionalInteger(record.hardwareFlashBytes, 'summary.hardwareFlashBytes'),
        hardwarePsramBytes: optionalInteger(record.hardwarePsramBytes, 'summary.hardwarePsramBytes'),
        checkpointCount: nonNegativeInteger(record.checkpointCount, 'summary.checkpointCount'),
        healthSummary: requiredString(record.healthSummary, 'summary.healthSummary'),
        healthPassCount: nonNegativeInteger(record.healthPassCount, 'summary.healthPassCount'),
        healthWarningCount: nonNegativeInteger(record.healthWarningCount, 'summary.healthWarningCount'),
        healthErrorCount: nonNegativeInteger(record.healthErrorCount, 'summary.healthErrorCount'),
        healthInfoCount: nonNegativeInteger(record.healthInfoCount, 'summary.healthInfoCount'),
    };
};

const normalizeGeneratedBy = (value: unknown): ProjectSubmissionGeneratedBy => {
    const record = asRecord(value, 'generatedBy');
    return {
        product: requiredString(record.product, 'generatedBy.product'),
        version: requiredString(record.version, 'generatedBy.version'),
        component: requiredString(record.component, 'generatedBy.component'),
    };
};

const normalizeShared = (record: Record<string, unknown>) => {
    const integrityVerified = exactBoolean(record.integrityVerified, true, 'integrityVerified');
    const publisherIdentityVerified = exactBoolean(
        record.publisherIdentityVerified,
        false,
        'publisherIdentityVerified',
    );
    const networkUsed = exactBoolean(record.networkUsed, false, 'networkUsed');
    const uploadPerformed = exactBoolean(record.uploadPerformed, false, 'uploadPerformed');
    const includedFiles = nonNegativeInteger(record.includedFiles, 'includedFiles');
    if (includedFiles < 2 || includedFiles > 6) {
        throw new Error('project.ckpkg 返回字段 includedFiles 超出安全范围');
    }
    const sourceScope = normalizeSourceScope(record.sourceScope);
    const hasDependencyLock = typeof record.hasDependencyLock === 'boolean'
        ? record.hasDependencyLock
        : (() => { throw new Error('project.ckpkg 返回字段 hasDependencyLock 无效'); })();
    const hasBuildEvidence = typeof record.hasBuildEvidence === 'boolean'
        ? record.hasBuildEvidence
        : (() => { throw new Error('project.ckpkg 返回字段 hasBuildEvidence 无效'); })();
    const sourceFileCount = sourceScope === 'editable_and_generated'
        ? 2
        : sourceScope === 'no_source' ? 0 : 1;
    if (includedFiles !== 2 + sourceFileCount + Number(hasDependencyLock) + Number(hasBuildEvidence)) {
        throw new Error('project.ckpkg 返回的 includedFiles 与源码范围和实际载荷标志不一致');
    }
    return {
        packageFileName: packageFileName(record.packageFileName),
        packageSha256: sha256(record.packageSha256, 'packageSha256'),
        schemaVersion: nonNegativeInteger(record.schemaVersion, 'schemaVersion'),
        includedFiles,
        sourceScope,
        hasDependencyLock,
        hasBuildEvidence,
        summary: normalizeProjectSubmissionSummary(record.summary),
        integrityVerified,
        publisherIdentityVerified,
        authenticityMessage: requiredString(record.authenticityMessage, 'authenticityMessage'),
        networkUsed,
        uploadPerformed,
    };
};

export const normalizeProjectSubmissionInspection = (
    value: unknown,
): ProjectSubmissionInspection => {
    const record = asRecord(value, 'inspection');
    exactBoolean(record.valid, true, 'valid');
    const shared = normalizeShared(record);
    if (shared.schemaVersion !== 1) throw new Error('不支持的 project.ckpkg schemaVersion');
    if (record.format !== 'ck-project-package' || record.kind !== 'project-submission') {
        throw new Error('project.ckpkg 的 format 或 kind 无效');
    }
    const generatedAt = requiredString(record.generatedAt, 'generatedAt');
    if (!Number.isFinite(Date.parse(generatedAt))) {
        throw new Error('project.ckpkg 的 generatedAt 无效');
    }
    const sourceDisclosureAcknowledged = typeof record.sourceDisclosureAcknowledged === 'boolean'
        ? record.sourceDisclosureAcknowledged
        : (() => { throw new Error('project.ckpkg 的 sourceDisclosureAcknowledged 无效'); })();
    if ((shared.sourceScope === 'no_source') === sourceDisclosureAcknowledged) {
        throw new Error('project.ckpkg 的源码范围与披露确认不一致');
    }
    if (shared.hasDependencyLock && !shared.summary.dependencyLockAvailable) {
        throw new Error('project.ckpkg 附加了依赖锁，但摘要声明依赖锁不可用');
    }
    return {
        valid: true,
        ...shared,
        schemaVersion: 1,
        format: 'ck-project-package',
        kind: 'project-submission',
        generatedBy: normalizeGeneratedBy(record.generatedBy),
        generatedAt,
        sourceDisclosureAcknowledged,
    };
};

const normalizeProjectSubmissionExportResult = (
    value: unknown,
): ProjectSubmissionExportResult => {
    const record = asRecord(value, 'exportResult');
    const shared = normalizeShared(record);
    if (shared.schemaVersion !== 1) throw new Error('导出返回了未知的 project.ckpkg schemaVersion');
    return {
        outputPath: requiredString(record.outputPath, 'outputPath'),
        ...shared,
        schemaVersion: 1,
    };
};

export const ensureProjectSubmissionPath = (value: string): string => {
    const trimmed = String(value || '').trim();
    if (!trimmed) throw new Error('请选择 project.ckpkg 保存位置');
    if (/\.zip$/i.test(trimmed)) {
        throw new Error('项目提交包不是普通 ZIP 改后缀，请使用 .ckpkg');
    }
    return /\.ckpkg$/i.test(trimmed) ? trimmed : `${trimmed}.ckpkg`;
};

export const exportProjectSubmission = async (
    request: ProjectSubmissionExportRequest,
): Promise<ProjectSubmissionExportResult> => {
    if (request.sourceScope !== 'no_source' && !request.sourceDisclosureAcknowledged) {
        throw new Error('包含源码前必须明确确认敏感信息风险');
    }
    const outputPath = ensureProjectSubmissionPath(request.outputPath);
    const result = await invoke<unknown>('export_project_submission', {
        request: { ...request, outputPath },
    });
    return normalizeProjectSubmissionExportResult(result);
};

export const inspectProjectSubmission = async (
    path: string,
): Promise<ProjectSubmissionInspection> => {
    const normalized = String(path || '').trim();
    if (!/\.ckpkg$/i.test(normalized)) throw new Error('请选择 .ckpkg 项目提交包');
    const result = await invoke<unknown>('inspect_project_submission', { path: normalized });
    return normalizeProjectSubmissionInspection(result);
};
