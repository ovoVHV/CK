import { invoke } from '@tauri-apps/api/core';
import type { CompileResourceReport, LinkerMapResourceSummary } from './compile_resources';
import type { DeviceHealthReport } from './device_health';

export interface LastWorkingDependency {
    name: string;
    version: string | null;
    sourcePath: string;
    snapshotPath: string;
    contentSha256: string;
    fileCount: number;
    totalBytes: number;
}

export interface DependencyRestoreReport {
    coreVersion: string;
    restored: string[];
    alreadyMatching: string[];
    backupRoot: string | null;
}

export interface LockedRebuildReport {
    status: 'passed';
    fqbn: string;
    lockSha256: string;
    dependencyCount: number;
    buildPath: string;
    compileProfile: string;
    optimization: string;
    log: string;
    elapsedMs: number;
    artifactGate: string;
    globalLibrariesUsed: false;
}

export interface LastWorkingFirmwareArtifact {
    path: string;
    role: string;
    flashAddress: string | null;
    size: number;
    sha256: string;
}

export interface LastWorkingVersion {
    schemaVersion: number;
    id: string;
    createdAt: string;
    verifiedAt: string;
    project: {
        originalPath: string;
        name: string;
        workspaceJson: string;
        workspaceSha256: string;
        generatedCode: string;
        generatedCodeSha256: string;
        board: string;
        boardPackageId?: string;
        boardOptionsJson: string;
        blockCount: number;
    };
    lock: {
        path: string;
        content: string;
        sha256: string;
        dependencies: LastWorkingDependency[];
    };
    environment: {
        fqbn: string;
        coreId: string;
        coreVersion: string | null;
        arduinoCliVersion: string;
        toolchainKey: string;
        buildSignature: string;
        compileProfile: string;
        optimization: string;
    };
    firmware: {
        buildDirectory: string;
        manifestPath: string;
        manifestSha256: string;
        partition: { path: string; sha256: string } | null;
        artifacts: LastWorkingFirmwareArtifact[];
    };
    device: {
        chip: string | null;
        revision: string | null;
        flashBytes: number | null;
        psramBytes: number | null;
    };
    resources: {
        flashUsedBytes: number | null;
        flashMaxBytes: number | null;
        ramUsedBytes: number | null;
        ramMaxBytes: number | null;
        warningCount: number;
        linkerMap?: LinkerMapResourceSummary | null;
    };
    logs: {
        compilePath: string;
        uploadPath: string;
    };
}

export interface CurrentWorkingVersionState {
    workspaceJson: string;
    generatedCode: string;
    blockCount: number;
    fqbn: string;
    boardPackageId?: string;
    coreId: string;
    coreVersion: string;
    boardOptions: Record<string, unknown>;
    optimization?: string;
    arduinoCliVersion?: string;
    toolchainKey?: string;
    buildSignature?: string;
    buildEvidenceRecordedAt?: string;
    dependencies?: Array<{ name: string; version?: string | null }>;
    /**
     * Board-scoped installed library inventory. Unlike `dependencies`, this
     * does not claim every entry is currently used; it is only used to check
     * whether a library locked by the last working version is still present
     * at the same version.
     */
    dependencyInventory?: Array<{ name: string; version?: string | null }>;
    deviceHealth?: DeviceHealthReport | null;
    resources?: CompileResourceReport | null;
}

/**
 * Stable identity for a last-working-version diff section.
 *
 * These values may be used for grouping/filtering and therefore must never be
 * translated. Presentation labels belong to the consuming UI.
 */
export const LAST_WORKING_DIFF_GROUPS = [
    'workspace',
    'environment',
    'dependencies',
    'device',
    'resources',
] as const;

export type LastWorkingDiffGroup = typeof LAST_WORKING_DIFF_GROUPS[number];

export type LastWorkingDiffCode =
    | 'blocksChanged'
    | 'blocksAdded'
    | 'blocksRemoved'
    | 'workspaceSerializationChanged'
    | 'generatedCodeChanged'
    | 'coreChanged'
    | 'fqbnChanged'
    | 'boardOptionChanged'
    | 'boardPackageChanged'
    | 'optimizationChanged'
    | 'cliChanged'
    | 'toolchainChanged'
    | 'buildSignatureChanged'
    | 'toolchainEvidenceMissing'
    | 'partitionEvidenceSaved'
    | 'dependencyMissing'
    | 'dependencyVersionChanged'
    | 'dependencyAdded'
    | 'dependencyResolutionPending'
    | 'deviceChipChanged'
    | 'flashChanged'
    | 'psramChanged'
    | 'deviceCheckMissing'
    | 'programSpaceChanged'
    | 'ramChanged';

export interface LastWorkingDiffItem {
    code: LastWorkingDiffCode;
    group: LastWorkingDiffGroup;
    severity: 'info' | 'warning' | 'important';
    params: Record<string, string | number>;
    /** Legacy zh-CN fallback; presentation code is authoritative for UI. */
    title: string;
    before: string;
    after: string;
}

export interface LastWorkingDiffReport {
    identical: boolean;
    summaryCode: 'identical' | 'changed' | 'changedImportant';
    summaryParams: { changes: number; important: number };
    /** Legacy zh-CN fallback; presentation code is authoritative for UI. */
    summary: string;
    items: LastWorkingDiffItem[];
}

const isNative = (): boolean => typeof window !== 'undefined' && Boolean(
    (window as any).__TAURI_IPC__
    || (window as any).__TAURI_INTERNALS__
    || (window as any).__TAURI__,
);

export const getLastWorkingVersion = async (
    projectPath: string,
): Promise<LastWorkingVersion | null> => {
    if (!projectPath.trim() || !isNative()) return null;
    return invoke<LastWorkingVersion | null>('get_last_working_version', { projectPath });
};

export const deleteLastWorkingVersion = async (projectPath: string): Promise<void> => {
    if (!projectPath.trim() || !isNative()) return;
    await invoke('delete_last_working_version', { projectPath });
};

export const restoreLastWorkingFirmware = async (
    projectPath: string,
    port: string,
): Promise<string> => invoke<string>('restore_last_working_firmware', {
    projectPath,
    port,
});

export const restoreLastWorkingDependencies = async (
    projectPath: string,
    currentCoreVersion: string,
): Promise<DependencyRestoreReport> => invoke<DependencyRestoreReport>(
    'restore_last_working_dependencies',
    { projectPath, currentCoreVersion },
);

export const rebuildLastWorkingVersionLocked = async (
    projectPath: string,
): Promise<LockedRebuildReport> => {
    const raw = await invoke<string>('rebuild_last_working_version_locked', { projectPath });
    const report = JSON.parse(raw) as LockedRebuildReport;
    if (report.status !== 'passed' || report.globalLibrariesUsed !== false) {
        throw new Error('锁定依赖复编译没有返回可信的隔离证据');
    }
    return report;
};

const sha256 = async (value: string): Promise<string> => {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
};

const shortHash = (value: string): string => `${value.slice(0, 10)}…`;

const bytesLabel = (value: number | null | undefined): string => {
    if (value == null || !Number.isFinite(value)) return '未明确报告';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / 1024 / 1024).toFixed(2)} MiB`;
};

const stableValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]));
};

const stableText = (value: unknown): string => JSON.stringify(stableValue(value));

interface BlocklyBlockIdentity {
    id: string;
    type: string;
    signature: string;
}

const collectBlocklyBlocks = (workspaceJson: string): Map<string, BlocklyBlockIdentity> => {
    const output = new Map<string, BlocklyBlockIdentity>();
    let root: unknown;
    try {
        root = JSON.parse(workspaceJson);
    } catch {
        return output;
    }
    const visit = (value: unknown) => {
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (!value || typeof value !== 'object') return;
        const record = value as Record<string, unknown>;
        if (typeof record.id === 'string' && typeof record.type === 'string') {
            const semantic = Object.fromEntries(Object.entries(record)
                .filter(([key]) => !['x', 'y', 'id', 'next'].includes(key)));
            output.set(record.id, {
                id: record.id,
                type: record.type,
                signature: stableText(semantic),
            });
        }
        Object.values(record).forEach(visit);
    };
    visit(root);
    return output;
};

const blockTypeSummary = (blocks: BlocklyBlockIdentity[]): string => {
    const types = [...new Set(blocks.map(block => block.type))];
    const shown = types.slice(0, 3).map(type => `“${type}”`).join('、');
    return shown + (types.length > 3 ? ` 等 ${types.length} 类` : '');
};

const fqbnOptions = (fqbn: string): Record<string, string> => {
    const optionText = fqbn.split(':').slice(3).join(':');
    if (!optionText) return {};
    return Object.fromEntries(optionText.split(',').flatMap(token => {
        const split = token.indexOf('=');
        return split > 0 ? [[token.slice(0, split), token.slice(split + 1)]] : [];
    }));
};

const deviceEvidence = (report: DeviceHealthReport | null | undefined) => ({
    chip: report?.device?.chip || null,
    flashBytes: report?.memory?.flashBytes ?? null,
    psramBytes: report?.memory?.psramBytes ?? null,
});

export const compareWithLastWorkingVersion = async (
    version: LastWorkingVersion,
    current: CurrentWorkingVersionState,
): Promise<LastWorkingDiffReport> => {
    const items: LastWorkingDiffItem[] = [];
    const add = (
        code: LastWorkingDiffCode,
        group: LastWorkingDiffGroup,
        severity: LastWorkingDiffItem['severity'],
        title: string,
        before: string,
        after: string,
        params: Record<string, string | number> = {},
    ) => items.push({ code, group, severity, params, title, before, after });

    const [workspaceHash, sourceHash] = await Promise.all([
        sha256(current.workspaceJson),
        sha256(current.generatedCode),
    ]);
    if (workspaceHash !== version.project.workspaceSha256) {
        const previous = collectBlocklyBlocks(version.project.workspaceJson);
        const next = collectBlocklyBlocks(current.workspaceJson);
        const added = [...next.values()].filter(block => !previous.has(block.id));
        const removed = [...previous.values()].filter(block => !next.has(block.id));
        const changed = [...next.values()].filter(block => (
            previous.has(block.id) && previous.get(block.id)?.signature !== block.signature
        ));
        if (changed.length) add('blocksChanged', 'workspace', 'warning', `修改了 ${changed.length} 个积木`, `${version.project.blockCount} 个积木`, `${current.blockCount} 个积木`, { count: changed.length });
        if (added.length) add('blocksAdded', 'workspace', 'warning', `新增了 ${added.length} 个积木`, '无', blockTypeSummary(added), { count: added.length });
        if (removed.length) add('blocksRemoved', 'workspace', 'warning', `删除了 ${removed.length} 个积木`, blockTypeSummary(removed), '无', { count: removed.length });
        if (!added.length && !removed.length && !changed.length) {
            add('workspaceSerializationChanged', 'workspace', 'warning', '积木工程序列化内容已变化', shortHash(version.project.workspaceSha256), shortHash(workspaceHash));
        }
    }
    if (sourceHash !== version.project.generatedCodeSha256) {
        add('generatedCodeChanged', 'workspace', 'warning', '生成源码已变化', shortHash(version.project.generatedCodeSha256), shortHash(sourceHash));
    }

    if (current.coreId !== version.environment.coreId || current.coreVersion !== (version.environment.coreVersion || '')) {
        add(
            'coreChanged',
            'environment',
            'important',
            'Core 发生变化',
            `${version.environment.coreId}@${version.environment.coreVersion || '未识别'}`,
            `${current.coreId}@${current.coreVersion || '未安装/未识别'}`,
        );
    }
    if (current.fqbn !== version.environment.fqbn) {
        add('fqbnChanged', 'environment', 'important', '完整 FQBN 发生变化', version.environment.fqbn, current.fqbn);
        const beforeOptions = fqbnOptions(version.environment.fqbn);
        const afterOptions = { ...fqbnOptions(current.fqbn), ...Object.fromEntries(
            Object.entries(current.boardOptions).map(([key, value]) => [key, String(value)]),
        ) };
        const keys = [...new Set([...Object.keys(beforeOptions), ...Object.keys(afterOptions)])].sort();
        keys.forEach(key => {
            if ((beforeOptions[key] || '') !== (afterOptions[key] || '')) {
                add('boardOptionChanged', 'environment', 'warning', `${key} 配置发生变化`, beforeOptions[key] || '默认/未设置', afterOptions[key] || '默认/未设置', { option: key });
            }
        });
    }
    const currentBoardPackageId = current.boardPackageId
        || current.fqbn.split(':').slice(0, 3).join(':');
    const baselineBoardPackageId = version.project.boardPackageId || version.project.board;
    if (currentBoardPackageId !== baselineBoardPackageId) {
        add(
            'boardPackageChanged',
            'environment',
            'important',
            '板卡包发生变化',
            baselineBoardPackageId,
            currentBoardPackageId,
        );
    }
    const baselineVerifiedAt = Date.parse(version.verifiedAt);
    const currentBuildEvidenceAt = Date.parse(current.buildEvidenceRecordedAt || '');
    const buildEvidenceComparable = !current.buildEvidenceRecordedAt || (
        Number.isFinite(baselineVerifiedAt)
        && Number.isFinite(currentBuildEvidenceAt)
        && currentBuildEvidenceAt >= baselineVerifiedAt
    );
    if (buildEvidenceComparable && current.optimization && current.optimization !== version.environment.optimization) {
        add('optimizationChanged', 'environment', 'warning', '编译优化发生变化', version.environment.optimization, current.optimization);
    }
    if (buildEvidenceComparable && current.arduinoCliVersion && current.arduinoCliVersion !== version.environment.arduinoCliVersion) {
        add(
            'cliChanged',
            'environment',
            'warning',
            'Arduino CLI 发生变化',
            version.environment.arduinoCliVersion,
            current.arduinoCliVersion,
        );
    }
    if (buildEvidenceComparable && current.toolchainKey && current.toolchainKey !== version.environment.toolchainKey) {
        add(
            'toolchainChanged',
            'environment',
            'important',
            '编译工具链身份发生变化',
            shortHash(version.environment.toolchainKey),
            shortHash(current.toolchainKey),
        );
    }
    if (buildEvidenceComparable && current.buildSignature && current.buildSignature !== version.environment.buildSignature) {
        add(
            'buildSignatureChanged',
            'environment',
            'warning',
            '构建签名发生变化',
            shortHash(version.environment.buildSignature),
            shortHash(current.buildSignature),
        );
    }
    if (!buildEvidenceComparable || (!current.arduinoCliVersion && !current.toolchainKey && !current.buildSignature)) {
        add(
            'toolchainEvidenceMissing',
            'environment',
            'info',
            '当前尚无可比较的工具链证据',
            `${version.environment.arduinoCliVersion} · ${shortHash(version.environment.toolchainKey)}`,
            !buildEvidenceComparable
                ? '现有证据早于可用版本，请在当前完整配置下重新编译一次'
                : '请先在当前完整配置下成功编译一次',
        );
    }
    if (version.firmware.partition) {
        add(
            'partitionEvidenceSaved',
            'environment',
            'info',
            '可用版本保存了分区证据',
            `${version.firmware.partition.path} · ${shortHash(version.firmware.partition.sha256)}`,
            '恢复固件前会重新校验',
        );
    }

    if (current.dependencies) {
        const before = new Map(version.lock.dependencies.map(item => [item.name.toLowerCase(), item]));
        const after = new Map(current.dependencies.map(item => [item.name.toLowerCase(), item]));
        for (const [key, dependency] of before) {
            const now = after.get(key);
            if (!now) add('dependencyMissing', 'dependencies', 'important', `缺少依赖 ${dependency.name}`, dependency.version || '未标版本', '未安装/未识别', { name: dependency.name });
            else if ((now.version || '') !== (dependency.version || '')) {
                add('dependencyVersionChanged', 'dependencies', 'warning', `${dependency.name} 版本发生变化`, dependency.version || '未标版本', now.version || '未标版本', { name: dependency.name });
            }
        }
        for (const [key, dependency] of after) {
            if (!before.has(key)) add('dependencyAdded', 'dependencies', 'info', `新增依赖 ${dependency.name}`, '无', dependency.version || '未标版本', { name: dependency.name });
        }
    } else if (current.dependencyInventory) {
        const inventory = new Map(current.dependencyInventory.map(item => [item.name.toLowerCase(), item]));
        for (const dependency of version.lock.dependencies) {
            const installed = inventory.get(dependency.name.toLowerCase());
            if (!installed) {
                add('dependencyMissing', 'dependencies', 'important', `当前环境缺少 ${dependency.name}`, dependency.version || '未标版本', '未安装/未识别', { name: dependency.name });
            } else if ((installed.version || '') !== (dependency.version || '')) {
                add('dependencyVersionChanged', 'dependencies', 'warning', `${dependency.name} 版本发生变化`, dependency.version || '未标版本', installed.version || '未标版本', { name: dependency.name });
            }
        }
    } else if (version.lock.dependencies.length > 0) {
        add('dependencyResolutionPending', 'dependencies', 'info', `可用版本锁定了 ${version.lock.dependencies.length} 个外部库`, version.lock.dependencies.map(item => `${item.name}${item.version ? `@${item.version}` : ''}`).join('、'), '当前尚未重新解析依赖', { count: version.lock.dependencies.length });
    }

    if (current.deviceHealth) {
        const hardware = deviceEvidence(current.deviceHealth);
        if (hardware.chip !== version.device.chip) {
            add('deviceChipChanged', 'device', 'important', '真机芯片证据发生变化', version.device.chip || '未明确报告', hardware.chip || '当前体检未明确报告');
        }
        if (hardware.flashBytes !== version.device.flashBytes) {
            add('flashChanged', 'device', 'important', '实体 Flash 证据发生变化', bytesLabel(version.device.flashBytes), bytesLabel(hardware.flashBytes));
        }
        if (hardware.psramBytes !== version.device.psramBytes) {
            add('psramChanged', 'device', 'warning', '明确 PSRAM 证据发生变化', bytesLabel(version.device.psramBytes), bytesLabel(hardware.psramBytes));
        }
    } else {
        add(
            'deviceCheckMissing',
            'device',
            'info',
            '当前端口尚未完成真机体检',
            `${version.device.chip || '芯片未明确'} · Flash ${bytesLabel(version.device.flashBytes)}`,
            '恢复固件前仍会重新执行芯片族与实体 Flash 门禁',
        );
    }

    const currentFlash = current.resources?.flash;
    const currentRam = current.resources?.ram;
    if (currentFlash && currentFlash.usedBytes !== version.resources.flashUsedBytes) {
        add('programSpaceChanged', 'resources', 'info', '程序空间发生变化', bytesLabel(version.resources.flashUsedBytes), bytesLabel(currentFlash.usedBytes));
    }
    if (currentRam && currentRam.usedBytes !== version.resources.ramUsedBytes) {
        add('ramChanged', 'resources', 'info', '内部 RAM 发生变化', bytesLabel(version.resources.ramUsedBytes), bytesLabel(currentRam.usedBytes));
    }

    const informationalEvidence = new Set([
        'partitionEvidenceSaved',
        'toolchainEvidenceMissing',
        'deviceCheckMissing',
    ]);
    const meaningful = items.filter(item => !informationalEvidence.has(item.code));
    const important = meaningful.filter(item => item.severity === 'important').length;
    return {
        identical: meaningful.length === 0,
        summaryCode: meaningful.length === 0
            ? 'identical'
            : important > 0
                ? 'changedImportant'
                : 'changed',
        summaryParams: { changes: meaningful.length, important },
        summary: meaningful.length === 0
            ? '当前工程与上一个可用版本没有发现可解释差异。'
            : `与上次成功烧录相比有 ${meaningful.length} 项变化${important ? `，其中 ${important} 项需要优先确认` : ''}。`,
        items,
    };
};

export const formatLastWorkingTime = (value: string): string => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).format(date);
};

export const formatLastWorkingBytes = bytesLabel;
