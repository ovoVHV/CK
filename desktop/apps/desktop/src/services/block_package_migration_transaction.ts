import { invoke } from '@tauri-apps/api/core';
import {
    planBlockPackageMigration,
    type BlockPackageMigrationPlan,
} from './block_package_migrations';

export type PreparedBlockLibraryOperation =
    | 'new-install'
    | 'upgrade'
    | 'install-and-migrate'
    | 'project-migration-only'
    | 'package-only'
    | 'identical';

export interface PreparedBlockLibraryMigration {
    schemaVersion: 1;
    token: string;
    operation: PreparedBlockLibraryOperation;
    packageId: string;
    packageName: string;
    installedFromVersion: string | null;
    installedFromContentSha256: string | null;
    projectFromVersion: string | null;
    projectFromContentSha256: string | null;
    toVersion: string;
    toContentSha256: string;
    migrationManifest: unknown | null;
    migrationManifestSha256: string | null;
    projectPath: string;
    projectDiskSha256: string;
    requiresProjectMigration: boolean;
    expiresAt: string;
}

export interface PrepareBlockLibraryMigrationInput {
    path: string;
    board: string;
    boardPackageId?: string;
    projectPath: string;
}

export interface PreparedBlockLibraryMigrationPreview {
    prepared: PreparedBlockLibraryMigration;
    plan: BlockPackageMigrationPlan;
    workspaceBeforeJson: string;
    workspaceAfterJson: string;
    workspaceBeforeSha256: string;
    workspaceAfterSha256: string;
}

export interface CommitPreparedBlockLibraryMigrationResult {
    status: 'committed' | 'identical';
    packageId: string;
    packageVersion: string;
    packageContentSha256: string;
    packageActivated: boolean;
    projectMigrated: boolean;
    projectDiskSha256: string | null;
}

export class PreparedBlockLibraryMigrationBlockedError extends Error {
    readonly plan: BlockPackageMigrationPlan;

    constructor(plan: BlockPackageMigrationPlan) {
        const codes = [...plan.unresolved, ...plan.ambiguous]
            .map(issue => issue.code)
            .join(', ');
        super(`积木包迁移无法确定执行${codes ? `：${codes}` : ''}`);
        this.name = 'PreparedBlockLibraryMigrationBlockedError';
        this.plan = plan;
    }
}

const SHA256_RE = /^(?:sha256:)?[a-f0-9]{64}$/i;
const TOKEN_RE = /^[a-f0-9]{32}$/i;
const OPERATIONS = new Set<PreparedBlockLibraryOperation>([
    'new-install',
    'upgrade',
    'install-and-migrate',
    'project-migration-only',
    'package-only',
    'identical',
]);

const requiredText = (value: unknown, label: string): string => {
    const text = String(value || '').trim();
    if (!text) throw new Error(`${label}不能为空`);
    return text;
};

const sha256 = async (value: string): Promise<string> => {
    if (!globalThis.crypto?.subtle) {
        throw new Error('当前运行环境不支持迁移 SHA-256 校验');
    }
    const bytes = new TextEncoder().encode(value);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
};

const validatePrepared = (
    prepared: PreparedBlockLibraryMigration,
): PreparedBlockLibraryMigration => {
    if (!prepared || prepared.schemaVersion !== 1) {
        throw new Error('后端返回了不受支持的积木包迁移事务');
    }
    if (!TOKEN_RE.test(prepared.token) || !OPERATIONS.has(prepared.operation)) {
        throw new Error('积木包迁移事务身份无效');
    }
    for (const [label, hash] of [
        ['目标包内容', prepared.toContentSha256],
        ['工程磁盘', prepared.projectDiskSha256],
    ] as const) {
        if (!SHA256_RE.test(String(hash || ''))) throw new Error(`${label} SHA-256 无效`);
    }
    const expires = Date.parse(prepared.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now()) {
        throw new Error('积木包迁移预览已过期，请重新选择安装包');
    }
    if (prepared.requiresProjectMigration) {
        if (!prepared.projectFromVersion || !prepared.projectFromContentSha256) {
            throw new Error('工程缺少可验证的旧包版本或内容哈希');
        }
        if (!prepared.migrationManifest || !SHA256_RE.test(prepared.migrationManifestSha256 || '')) {
            throw new Error('升级包缺少可验证的 ck-migrations.json');
        }
    }
    return prepared;
};

export const prepareBlockLibraryMigration = async (
    input: PrepareBlockLibraryMigrationInput,
): Promise<PreparedBlockLibraryMigration> => {
    const normalized = {
        path: requiredText(input.path, '积木包路径'),
        board: requiredText(input.board, '当前板卡'),
        boardPackageId: String(input.boardPackageId || '').trim() || null,
        projectPath: requiredText(input.projectPath, '当前工程路径'),
    };
    let prepared: PreparedBlockLibraryMigration;
    try {
        prepared = await invoke<PreparedBlockLibraryMigration>(
            'prepare_block_library_migration',
            { input: normalized },
        );
    } catch (error) {
        const message = String(error instanceof Error ? error.message : error || '');
        if (message.includes('BLOCK_PACKAGE_EVIDENCE_REQUIRED')) {
            throw new Error(
                '当前工程还没有这个积木包的来源版本与内容哈希，CK 已停止升级以免猜错。请先取消导入，用当前已启用的旧包完整打开工程并保存一次；保存成功会记录“已启用声明式包清单”，然后再重新导入升级。若未知积木保护使工程无法安全保存，请保留旧包并从备份或检查点恢复，不能强行覆盖。',
            );
        }
        throw error;
    }
    return validatePrepared(prepared);
};

export const cancelPreparedBlockLibraryMigration = async (token: string): Promise<void> => {
    const normalized = requiredText(token, '迁移事务令牌');
    if (!TOKEN_RE.test(normalized)) throw new Error('迁移事务令牌无效');
    await invoke<void>('cancel_prepared_block_library_migration', { token: normalized });
};

export const previewPreparedBlockLibraryMigration = async (
    preparedInput: PreparedBlockLibraryMigration,
    workspaceJson: string,
): Promise<PreparedBlockLibraryMigrationPreview> => {
    const prepared = validatePrepared(preparedInput);
    if (!prepared.requiresProjectMigration) {
        throw new Error('当前安装事务不需要改写工程');
    }
    const exactWorkspace = String(workspaceJson || '');
    let workspace: unknown;
    try {
        workspace = JSON.parse(exactWorkspace.replace(/^\uFEFF/, ''));
    } catch (error) {
        throw new Error(`声明式迁移仅支持 Blockly JSON；原工程保持不变：${error}`);
    }
    if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
        throw new Error('声明式迁移仅支持 Blockly JSON 对象；原工程保持不变');
    }
    const plan = planBlockPackageMigration(
        workspace,
        prepared.migrationManifest,
        {
            packageId: prepared.packageId,
            fromVersion: prepared.projectFromVersion as string,
            toVersion: prepared.toVersion,
        },
    );
    if (!plan.canApply) throw new PreparedBlockLibraryMigrationBlockedError(plan);
    const workspaceAfterJson = JSON.stringify(plan.outputWorkspace);
    return {
        prepared,
        plan,
        workspaceBeforeJson: exactWorkspace,
        workspaceAfterJson,
        workspaceBeforeSha256: await sha256(exactWorkspace),
        workspaceAfterSha256: await sha256(workspaceAfterJson),
    };
};

export const commitPreparedBlockLibraryMigration = async (
    preparedInput: PreparedBlockLibraryMigration,
    preview?: PreparedBlockLibraryMigrationPreview,
    checkpointId?: string,
): Promise<CommitPreparedBlockLibraryMigrationResult> => {
    const prepared = validatePrepared(preparedInput);
    let project: Record<string, unknown> | null = null;
    if (prepared.requiresProjectMigration) {
        if (!preview || preview.prepared.token !== prepared.token) {
            throw new Error('迁移提交缺少与当前暂存包绑定的 dry-run 预览');
        }
        if (!preview.plan.canApply) throw new PreparedBlockLibraryMigrationBlockedError(preview.plan);
        const checkpoint = requiredText(checkpointId, '迁移前检查点');
        project = {
            workspaceBeforeJson: preview.workspaceBeforeJson,
            workspaceAfterJson: preview.workspaceAfterJson,
            workspaceBeforeSha256: preview.workspaceBeforeSha256,
            workspaceAfterSha256: preview.workspaceAfterSha256,
            checkpointId: checkpoint,
            stepIds: preview.plan.path.map(step => step.id),
        };
    } else if (preview || checkpointId) {
        throw new Error('无需迁移工程的安装事务不能携带工程改写数据');
    }
    return invoke<CommitPreparedBlockLibraryMigrationResult>(
        'commit_prepared_block_library_migration',
        {
            input: {
                token: prepared.token,
                project,
            },
        },
    );
};

export const formatBlockLibraryMigrationPreview = (
    preview: PreparedBlockLibraryMigrationPreview,
): string => {
    const { prepared, plan } = preview;
    const lines = [
        `包：${prepared.packageName}（${prepared.packageId}）`,
        `版本：${prepared.projectFromVersion} → ${prepared.toVersion}`,
        `内容哈希：${String(prepared.projectFromContentSha256).slice(0, 12)}… → ${prepared.toContentSha256.slice(0, 12)}…`,
        `迁移步骤：${plan.path.map(step => step.id).join(' → ')}`,
        `受影响积木：${plan.changedBlockCount} 个`,
    ];
    for (const block of plan.changedBlocks.slice(0, 8)) {
        lines.push(`• ${block.id || block.path}: ${block.originalType} → ${block.migratedType}（${block.changes.length} 项）`);
    }
    if (plan.changedBlocks.length > 8) {
        lines.push(`• 以及另外 ${plan.changedBlocks.length - 8} 个积木`);
    }
    lines.push('', '确认后 CK 会先保存完整检查点，再原子切换包与工程；任一步失败均不写入迁移后的工程。');
    return lines.join('\n');
};
