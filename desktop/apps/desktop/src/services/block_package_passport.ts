import type {
    BlockManifestEntry,
    BlockMetadataSection,
    LibraryInfo,
} from '../types/library';
import { blockRuntimeActivation } from './block_runtime_activation';

export type BlockPackagePassportStageId =
    | 'structure'
    | 'semantics'
    | 'runtime'
    | 'compile'
    | 'device';

export type BlockPackagePassportStageStatus =
    | 'passed'
    | 'declared'
    | 'warning'
    | 'pending'
    | 'failed';

export interface BlockPackagePassportStage {
    id: BlockPackagePassportStageId;
    label: string;
    status: BlockPackagePassportStageStatus;
    /** Stable presentation descriptor; never infer behavior from detail text. */
    detailCode: string;
    detailParams?: Record<string, string | number>;
    missingEvidence?: string[];
    rawCause?: string;
    /** Legacy zh-CN fallback for older consumers. */
    detail: string;
}

export interface BlockPackagePassport {
    packageId: string;
    summary: 'blocked' | 'attention' | 'ready';
    passedStages: number;
    totalStages: number;
    stages: BlockPackagePassportStage[];
    boundary: string;
}

const REQUIRED_V2_SECTIONS: readonly BlockMetadataSection[] = [
    'semantics',
    'dependencies',
    'output',
    'hardware',
    'generation',
    'constraints',
    'examples',
    'errors',
];

const owns = (value: unknown, key: PropertyKey): boolean => (
    Boolean(value)
    && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, key)
);

const completeSections = (block: BlockManifestEntry): BlockMetadataSection[] => (
    REQUIRED_V2_SECTIONS.filter(section => owns(block, section))
);

const structureStage = (lib: Partial<LibraryInfo>): BlockPackagePassportStage => {
    const report = lib.quality_report;
    if (!report) {
        return {
            id: 'structure',
            label: '结构检查',
            status: 'pending',
            detailCode: 'qualityReportMissing',
            detail: '没有可验证的 CK 质量报告。',
        };
    }
    if (report.package_kind !== 'block-library') {
        return {
            id: 'structure',
            label: '结构检查',
            status: 'failed',
            detailCode: 'wrongPackageKind',
            detailParams: { kind: String(report.package_kind || 'unknown') },
            detail: `质量报告类型为 ${String(report.package_kind || '未知')}，不是积木库。`,
        };
    }
    if (report.status === 'failed') {
        return {
            id: 'structure',
            label: '结构检查',
            status: 'failed',
            detailCode: 'qualityBlocked',
            detailParams: { count: report.error_count || 1 },
            detail: `${report.error_count || 1} 个确定性问题已阻止加载。`,
        };
    }
    if (report.status !== 'passed' && report.status !== 'passed_with_warnings') {
        return {
            id: 'structure',
            label: '结构检查',
            status: 'pending',
            detailCode: 'qualityPending',
            detail: '质量报告尚未形成通过或阻止结论。',
        };
    }
    const expectedPackageId = String(lib.id || lib.block_manifest?.id || '').trim();
    const reportPackageId = String(report.package_id || '').trim();
    if (expectedPackageId && reportPackageId && expectedPackageId !== reportPackageId) {
        return {
            id: 'structure',
            label: '结构检查',
            status: 'failed',
            detailCode: 'packageIdMismatch',
            detailParams: { reportPackageId, expectedPackageId },
            detail: `质量报告绑定 ${reportPackageId}，与当前包 ${expectedPackageId} 不一致。`,
        };
    }
    const hasContentIdentity = /^[a-f0-9]{64}$/i.test(String(report.source_content_sha256 || ''));
    const hasImportConsumer = Array.isArray(report.validated_consumers)
        && report.validated_consumers.includes('import-gate');
    if (report.status === 'passed_with_warnings' || !reportPackageId || !hasContentIdentity || !hasImportConsumer) {
        const missing = [
            !reportPackageId ? 'packageId' : '',
            !hasContentIdentity ? 'contentSha256' : '',
            !hasImportConsumer ? 'importConsumer' : '',
        ].filter(Boolean);
        return {
            id: 'structure',
            label: '结构检查',
            status: 'warning',
            detailCode: missing.length > 0 ? 'structureEvidenceMissing' : 'structureWarnings',
            detailParams: { count: report.warning_count || 1 },
            missingEvidence: missing,
            detail: missing.length > 0
                ? `本机报告可读，但缺少 ${missing.join('、')}；不能视为完整结构证据。`
                : `本机门禁通过，但保留 ${report.warning_count || 1} 个警告。`,
        };
    }
    return {
        id: 'structure',
        label: '结构检查',
        status: 'passed',
        detailCode: 'structurePassed',
        detail: '目录、入口、依赖形状和内容身份通过本机门禁。',
    };
};

const semanticsStage = (lib: Partial<LibraryInfo>): BlockPackagePassportStage => {
    const manifest = lib.block_manifest;
    if (!manifest) {
        return {
            id: 'semantics',
            label: '语义元数据',
            status: 'pending',
            detailCode: 'manifestMissing',
            detail: '没有可读的 ck-blocks.json。',
        };
    }
    const blocks = Array.isArray(manifest.blocks) ? manifest.blocks : [];
    if (manifest.schema_version !== 2) {
        return {
            id: 'semantics',
            label: '语义元数据',
            status: 'warning',
            detailCode: 'legacySchema',
            detailParams: { version: String(manifest.schema_version ?? 'unknown') },
            detail: `当前为 schema v${manifest.schema_version}；可搜索，但尚未达到 v2 八类机器语义。`,
        };
    }
    if (blocks.length === 0) {
        return {
            id: 'semantics',
            label: '语义元数据',
            status: 'failed',
            detailCode: 'emptyManifest',
            detail: 'v2 清单没有声明任何积木。',
        };
    }

    const complete = blocks.filter(block => completeSections(block).length === REQUIRED_V2_SECTIONS.length);
    if (complete.length === blocks.length) {
        return {
            id: 'semantics',
            label: '语义元数据',
            status: 'passed',
            detailCode: 'semanticsComplete',
            detailParams: { count: blocks.length },
            detail: `${blocks.length} 个积木均声明语义、依赖、输出、硬件、生成、约束、示例和错误。`,
        };
    }

    const missing = new Set<BlockMetadataSection>();
    for (const block of blocks) {
        const present = new Set(completeSections(block));
        for (const section of REQUIRED_V2_SECTIONS) {
            if (!present.has(section)) missing.add(section);
        }
    }
    return {
        id: 'semantics',
        label: '语义元数据',
        status: 'warning',
        detailCode: 'semanticsIncomplete',
        detailParams: { complete: complete.length, total: blocks.length },
        missingEvidence: [...missing].map(section => `section.${section}`),
        detail: `${complete.length}/${blocks.length} 个积木语义完整；仍缺 ${[...missing].join('、') || '未知字段'}。`,
    };
};

const runtimeStage = (lib: Partial<LibraryInfo>): BlockPackagePassportStage => {
    const activation = blockRuntimeActivation(lib);
    if (activation.state === 'declarative-safe') {
        const activationHash = String(activation.contentSha256 || '').trim().toLowerCase();
        const reportHash = String(lib.quality_report?.source_content_sha256 || '').trim().toLowerCase();
        const entrypoints = lib.block_entrypoints || lib.block_manifest?.entrypoints;
        const completeEntrypoints = Boolean(
            entrypoints?.blocks?.trim()
            && entrypoints?.generator?.trim()
            && entrypoints?.toolbox?.trim(),
        );
        const exactHashBound = /^[a-f0-9]{64}$/.test(activationHash)
            && activationHash === reportHash;
        const runtimeConsumerBound = Array.isArray(lib.quality_report?.validated_consumers)
            && lib.quality_report.validated_consumers.includes('runtime-loader');
        const dataOnlyRuntime = activation.executablePresent === false;
        if (!completeEntrypoints || !exactHashBound || !runtimeConsumerBound || !dataOnlyRuntime) {
            const missing = [
                !completeEntrypoints ? 'declarativeEntrypoints' : '',
                !exactHashBound ? 'runtimeContentSha256' : '',
                !runtimeConsumerBound ? 'runtimeConsumer' : '',
                !dataOnlyRuntime ? 'dataOnlyRuntime' : '',
            ].filter(Boolean);
            return {
                id: 'runtime',
                label: '安全运行边界',
                status: 'warning',
                detailCode: 'runtimeEvidenceMissing',
                missingEvidence: missing,
                detail: `后端标记为声明式运行时，但缺少 ${missing.join('、')}；护照不将其提升为已验证。`,
            };
        }
        return {
            id: 'runtime',
            label: '安全运行边界',
            status: 'passed',
            detailCode: 'runtimePassed',
            detail: '三项声明式入口与精确内容哈希已复核，未执行第三方 JavaScript。',
        };
    }
    if (activation.state === 'legacy-disabled') {
        return {
            id: 'runtime',
            label: '安全运行边界',
            status: 'failed',
            detailCode: 'legacyDisabled',
            detail: 'Legacy JavaScript 已保留但禁用，需要迁移为声明式入口。',
        };
    }
    if (activation.state === 'quality-blocked') {
        return {
            id: 'runtime',
            label: '安全运行边界',
            status: 'failed',
            detailCode: 'runtimeQualityBlocked',
            rawCause: activation.reason || undefined,
            detail: activation.reason || '运行时质量复核未通过。',
        };
    }
    if (activation.state === 'approval-required'
        || activation.state === 'approved'
        || activation.state === 'ck-allowlisted') {
        return {
            id: 'runtime',
            label: '安全运行边界',
            status: 'warning',
            detailCode: 'legacyTrustInsufficient',
            detail: '旧信任记录不是脚本沙箱证据；CK 1.0 不据此执行第三方 JavaScript。',
        };
    }
    return {
        id: 'runtime',
        label: '安全运行边界',
        status: 'pending',
        detailCode: 'runtimeUnavailable',
        detail: '当前包没有形成可激活的声明式积木运行时。',
    };
};

const authorValidationStage = (
    lib: Partial<LibraryInfo>,
    stage: 'compile' | 'device',
): BlockPackagePassportStage => {
    const records = lib.manifest?.hardware_validation?.tested_targets || [];
    const matching = records.filter(record => (
        stage === 'compile'
            ? record.levels.includes('compile')
            : record.levels.includes('upload') || record.levels.includes('runtime')
    ));
    if (matching.length === 0) {
        return {
            id: stage,
            label: stage === 'compile' ? '真实编译证据' : '真板证据',
            status: 'pending',
            detailCode: stage === 'compile' ? 'compileEvidenceMissing' : 'deviceEvidenceMissing',
            detail: stage === 'compile'
                ? '尚未保存与本包内容哈希、完整 FQBN 和工具链绑定的独立 compile-only 凭证。'
                : '尚未保存与具体板卡、配置和包内容绑定的真板运行证据。',
        };
    }
    const targets = matching
        .slice(0, 3)
        .map(record => record.board_name?.trim() || record.fqbn)
        .join('、');
    const testedDates = matching
        .map(record => record.tested_at)
        .sort();
    const latestTestedAt = testedDates[testedDates.length - 1] || '';
    return {
        id: stage,
        label: stage === 'compile' ? '真实编译证据' : '真板证据',
        status: 'declared',
        detailCode: stage === 'compile' ? 'compileAuthorDeclared' : 'deviceAuthorDeclared',
        detailParams: {
            count: matching.length,
            targets,
            testedAt: latestTestedAt,
        },
        detail: stage === 'compile'
            ? `作者声明已在 ${targets} 完成编译测试；这不是 CK 独立验证。`
            : `作者声明已在 ${targets} 完成真板上传或运行测试；这不是 CK 独立验证。`,
    };
};

export const buildBlockPackagePassport = (lib: Partial<LibraryInfo>): BlockPackagePassport => {
    const stages: BlockPackagePassportStage[] = [
        structureStage(lib),
        semanticsStage(lib),
        runtimeStage(lib),
        authorValidationStage(lib, 'compile'),
        authorValidationStage(lib, 'device'),
    ];
    const passedStages = stages.filter(stage => stage.status === 'passed').length;
    const summary = stages.some(stage => stage.status === 'failed')
        ? 'blocked'
        : stages.some(stage => stage.status === 'declared' || stage.status === 'warning' || stage.status === 'pending')
            ? 'attention'
            : 'ready';
    return {
        packageId: String(lib.id || lib.block_manifest?.id || '').trim(),
        summary,
        passedStages,
        totalStages: stages.length,
        stages,
        boundary: '护照只汇总本机已有证据；待验证不等于失败，通过也不代表 CK 官方背书。',
    };
};

export const blockPassportStatusLabel = (status: BlockPackagePassportStageStatus): string => {
    if (status === 'passed') return '已验证';
    if (status === 'declared') return '作者声明';
    if (status === 'warning') return '需复核';
    if (status === 'failed') return '已阻止';
    return '待验证';
};
